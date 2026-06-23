// ============================================================
// クリニック受信トレイ — マルチテナントSaaS版 (server2)
// ベース: clinic-inbox/server.js（本番シングルテナント版）をそのまま移植し、
// 旧 platform/server.js のテナント/認証レイヤー（tenantsテーブル・セッションcookie）を統合。
// ============================================================
process.env.TZ = "Asia/Tokyo";
// 想定外エラーでサーバー全体が落ちないようにする（IMAP接続エラー等）
process.on("uncaughtException", (e) => console.error("uncaught:", e && e.message));
process.on("unhandledRejection", (e) => console.error("unhandled:", e && (e.message || e)));
const express = require("express");
const crypto = require("crypto");
const app = express();
app.use(express.json({ limit: "16mb", verify: (req, res, buf) => { req.rawBody = buf; } }));
const PORT = process.env.PORT || 3000;
const INGEST_KEY = process.env.INGEST_KEY || "clinic-secret";
const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY || ""; // 全テナント共通（運営持ち）
// ===== 受付くん（SmileMedi Cloud）連携 =====
const PARTNER_KEY = process.env.PLATFORM_SECRET || ""; // パートナーAPI共有キー（x-partner-key）。未設定なら連携は無効
const PARTNER_HOOK_URL = process.env.PARTNER_HOOK_URL || "https://smilemedi-cloud-web.vercel.app/api/hooks/migiude"; // 受信イベントの転送先
const PARTNER_BOOKING_URL = process.env.PARTNER_BOOKING_URL || "https://smilemedi-cloud-web.vercel.app/api/partner/booking"; // AI下書き前の予約照会

// ---------- Postgres ----------
let pool = null;
if (process.env.DATABASE_URL) {
  try { const { Pool } = require("pg"); pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false, max: 6 }); }
  catch (e) { console.error("pg init failed:", e.message); pool = null; }
}

// ---------- tenant model ----------
// TEN: slug -> t = { slug, name, config, store:{}, rules:{}, ruleSeq, alerts:[], alertSeq, push:{} }
// t.config（tenantsテーブルのjsonbに永続化）:
//   passHash, conn:{lineToken,lineSecret,smtp*,imap*,emailInternal,lines[],mails[],seenIds,mailCutoff,lineBotId,lineName,mailName},
//   settings:{autoReply,level,tone}
const TEN = {};
function newTenant(slug, name, config) {
  config = config || {};
  if (!config.conn || typeof config.conn !== "object") config.conn = {};
  if (!config.settings || typeof config.settings !== "object") config.settings = { autoReply: false, level: "high", tone: "", autoDelayMin: 0, engine: "gemini" };
  if (!["claude", "gpt", "gemini"].includes(config.settings.engine)) config.settings.engine = "gemini"; // 文章作成の既定はGemini
  if (typeof config.settings.autoReply !== "boolean") config.settings.autoReply = false;
  if (config.settings.level !== "high" && config.settings.level !== "medium") config.settings.level = "high";
  if (typeof config.settings.tone !== "string") config.settings.tone = "";
  if (typeof config.settings.autoDelayMin !== "number" || !isFinite(config.settings.autoDelayMin) || config.settings.autoDelayMin < 0) config.settings.autoDelayMin = 0;
  config.settings.autoDelayMin = Math.min(60, Math.round(config.settings.autoDelayMin)); // 自動返信までの待ち時間（分）。0=即時, 上限60
  if (!Array.isArray(config.settings.prefs)) config.settings.prefs = []; // スタッフの記憶（全返信に効く恒久ルール）
  return { slug, name: name || slug, config, store: {}, rules: {}, ruleSeq: 1, examples: {}, exampleSeq: 1, alerts: [], alertSeq: 1, push: {} };
}
async function saveTenantConfig(t) {
  if (pool) await pool.query("UPDATE tenants SET name=$2, config=$3 WHERE slug=$1", [t.slug, t.name, t.config]);
}

// 接続設定アクセサ（テナントは全てUIで設定する。環境変数へのフォールバックは無し。ホスト/ポートのみGmail既定値）
function cf(t, k) { const v = t.config.conn[k]; return v == null ? "" : String(v); }
const C = {
  lineToken: (t) => cf(t, "lineToken"),
  lineSecret: (t) => cf(t, "lineSecret"),
  smtpHost: (t) => cf(t, "smtpHost") || "smtp.gmail.com",
  smtpPort: (t) => +(cf(t, "smtpPort") || 465),
  smtpUser: (t) => cf(t, "smtpUser"),
  smtpPass: (t) => cf(t, "smtpPass"),
  imapHost: (t) => cf(t, "imapHost") || "imap.gmail.com",
  imapPort: (t) => +(cf(t, "imapPort") || 993),
  imapUser: (t) => cf(t, "imapUser") || cf(t, "smtpUser"),
  imapPass: (t) => cf(t, "imapPass") || cf(t, "smtpPass"),
};
function emailOn(t) { return !!t.config.conn.emailInternal; }
function S(t) { return t.config.settings; }

// ---------- DB init: テーブル作成 + 全テナントとそのデータをTENにロード ----------
async function dbInit() {
  if (!pool) return;
  await pool.query("CREATE TABLE IF NOT EXISTS tenants (slug text primary key, name text, config jsonb)");
  await pool.query("CREATE TABLE IF NOT EXISTS convos (tenant text, id text, ts bigint, data jsonb, PRIMARY KEY(tenant,id))");
  await pool.query("CREATE TABLE IF NOT EXISTS rules (tenant text, id int, title text, content text, updated bigint, PRIMARY KEY(tenant,id))");
  await pool.query("CREATE TABLE IF NOT EXISTS examples (tenant text, id int, q text, final text, draft0 text, instr text, ts bigint, PRIMARY KEY(tenant,id))");
  await pool.query("CREATE TABLE IF NOT EXISTS alerts (id serial primary key, tenant text, type text, summary text, name text, ts bigint, done boolean default false)");
  await pool.query("CREATE TABLE IF NOT EXISTS files (id text primary key, tenant text, name text, mime text, data bytea, ts bigint)");
  await pool.query("CREATE TABLE IF NOT EXISTS push_subs (tenant text, endpoint text primary key, sub jsonb)");
  await pool.query("CREATE TABLE IF NOT EXISTS kv (k text primary key, v jsonb)");
  const r = await pool.query("SELECT slug,name,config FROM tenants");
  r.rows.forEach(row => { TEN[row.slug] = newTenant(row.slug, row.name, row.config || {}); });
  for (const slug of Object.keys(TEN)) {
    const t = TEN[slug];
    const cv = await pool.query("SELECT data FROM convos WHERE tenant=$1 ORDER BY ts DESC LIMIT 1000", [slug]);
    cv.rows.forEach(x => { const c = x.data; if (c && c.id) t.store[c.id] = c; });
    const ru = await pool.query("SELECT id,title,content FROM rules WHERE tenant=$1 ORDER BY id", [slug]);
    ru.rows.forEach(x => { t.rules[x.id] = { id: x.id, title: x.title, content: x.content }; if (x.id >= t.ruleSeq) t.ruleSeq = x.id + 1; });
    const ex = await pool.query("SELECT id,q,final,draft0,instr,ts FROM examples WHERE tenant=$1 ORDER BY id DESC LIMIT 500", [slug]);
    ex.rows.forEach(x => { t.examples[x.id] = { id: x.id, q: x.q, final: x.final, draft0: x.draft0, instr: x.instr, ts: Number(x.ts) }; if (x.id >= t.exampleSeq) t.exampleSeq = x.id + 1; });
    const al = await pool.query("SELECT id,type,summary,name,ts,done FROM alerts WHERE tenant=$1 ORDER BY ts DESC LIMIT 200", [slug]);
    t.alerts = al.rows.map(x => ({ id: x.id, type: x.type, summary: x.summary, name: x.name, ts: Number(x.ts), done: x.done }));
    t.alerts.forEach(a => { if (a.id >= t.alertSeq) t.alertSeq = a.id + 1; });
    const ps = await pool.query("SELECT sub FROM push_subs WHERE tenant=$1", [slug]);
    ps.rows.forEach(x => { t.push[x.sub.endpoint] = x.sub; });
  }
  console.log("loaded " + Object.keys(TEN).length + " tenants");
}
function dbSave(t, c) {
  if (!pool || !c) return;
  pool.query("INSERT INTO convos (tenant,id,ts,data) VALUES ($1,$2,$3,$4) ON CONFLICT (tenant,id) DO UPDATE SET ts=EXCLUDED.ts, data=EXCLUDED.data",
    [t.slug, c.id, c.ts || 0, c]).catch(e => console.error("dbSave:", e.message));
}

// ---------- auth（旧platform方式: セッションcookie sess=base64(slug).sha("sess|slug|passHash")） ----------
function sha(s) { return crypto.createHash("sha256").update(s).digest("hex"); }
function cookies(req) { const o = {}; (req.headers.cookie || "").split(";").forEach(p => { const i = p.indexOf("="); if (i > 0) o[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); }); return o; }
function sessToken(slug, passHash) { return sha("sess|" + slug + "|" + passHash); }
function setSess(res, t) { res.set("Set-Cookie", "sess=" + Buffer.from(t.slug).toString("base64") + "." + sessToken(t.slug, t.config.passHash) + "; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000"); }
function tenantFromReq(req) {
  const sess = cookies(req).sess || "";
  const dot = sess.lastIndexOf(".");
  if (dot < 1) return null;
  let slug; try { slug = Buffer.from(sess.slice(0, dot), "base64").toString("utf8"); } catch (e) { return null; }
  const tok = sess.slice(dot + 1);
  const t = TEN[slug];
  if (!t || !t.config.passHash) return null;
  if (tok !== sessToken(slug, t.config.passHash)) return null;
  if (t.config.suspended) return null; // 運営側で停止中
  return t;
}
function guard(req, res, next) { const t = tenantFromReq(req); if (!t) return res.status(401).json({ error: "auth" }); req.tenant = t; next(); }
function slugify(name) { const base = String(name || "clinic").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 20) || "clinic"; return base + "-" + crypto.randomBytes(2).toString("hex"); }

function loginIdTaken(id, exceptSlug){
  return Object.values(TEN).some(x => x.slug !== exceptSlug && ((x.config.loginId || x.slug) === id));
}
app.post("/api/signup", async (req, res) => {
  return res.status(403).json({ ok: false, error: "signup_closed" }); // 新規契約は運営（受付くん管理画面）経由のみ

  const name = String(req.body.company || req.body.name || "").trim().slice(0, 80);
  const pass = String(req.body.password || "");
  const loginId = String(req.body.loginId || "").trim();
  if (!name) return res.status(400).json({ ok: false, error: "name" });
  if (!/^[a-zA-Z0-9_-]{3,30}$/.test(loginId)) return res.status(400).json({ ok: false, error: "bad_id" });
  if (pass.length < 8) return res.status(400).json({ ok: false, error: "too_short" });
  if (loginIdTaken(loginId)) return res.status(409).json({ ok: false, error: "id_taken" });
  const slug = slugify(name);
  const config = { passHash: sha(pass), loginId, conn: {}, settings: { autoReply: false, level: "high", tone: "" } };
  const t = TEN[slug] = newTenant(slug, name, config);
  if (pool) { try { await pool.query("INSERT INTO tenants (slug,name,config) VALUES ($1,$2,$3)", [slug, name, t.config]); } catch (e) { delete TEN[slug]; return res.status(500).json({ ok: false, error: "db" }); } }
  seedTenant(t); // 本番と同様、新規テナントにはデモ会話を入れて空っぽにしない
  setSess(res, t);
  res.json({ ok: true, slug });
});
app.post("/api/login", (req, res) => {
  const loginId = String(req.body.loginId || req.body.company || "").trim();
  const pass = String(req.body.password || "");
  // ログインIDでマッチ（未設定テナントはslugがID代わり）
  const t = Object.values(TEN).find(x => (x.config.loginId || x.slug) === loginId && x.config.passHash && sha(pass) === x.config.passHash);
  if (!t) return res.status(401).json({ ok: false });
  if (t.config.suspended) return res.status(403).json({ ok: false, error: "suspended" });
  setSess(res, t);
  res.json({ ok: true, slug: t.slug });
});
app.post("/api/change-loginid", guard, async (req, res) => {
  const t = req.tenant;
  const next = String(req.body.next || "").trim();
  if (!/^[a-zA-Z0-9_-]{3,30}$/.test(next)) return res.status(400).json({ ok: false, error: "bad_id" });
  if (loginIdTaken(next, t.slug)) return res.status(409).json({ ok: false, error: "id_taken" });
  t.config.loginId = next;
  try { await saveTenantConfig(t); } catch (e) { return res.status(500).json({ ok: false, error: "save" }); }
  res.json({ ok: true, loginId: next });
});
app.post("/api/logout", (req, res) => { res.set("Set-Cookie", "sess=; Path=/; HttpOnly; Max-Age=0"); res.json({ ok: true }); });
app.post("/api/change-pass", guard, async (req, res) => {
  const t = req.tenant;
  const cur = String(req.body.current || ""), next = String(req.body.next || "");
  if (sha(cur) !== t.config.passHash) return res.status(401).json({ ok: false, error: "wrong_current" });
  if (next.length < 8) return res.status(400).json({ ok: false, error: "too_short" });
  t.config.passHash = sha(next);
  try { await saveTenantConfig(t); } catch (e) { return res.status(500).json({ ok: false, error: "save" }); }
  setSess(res, t);
  res.json({ ok: true });
});

// ---------- rulebook (per tenant) ----------
function rulesList(t) { return Object.values(t.rules).sort((a, b) => a.id - b.id); }
async function ruleAdd(t, title, content) {
  const id = t.ruleSeq++;
  t.rules[id] = { id, title, content };
  if (pool) { try { await pool.query("INSERT INTO rules (tenant,id,title,content,updated) VALUES ($1,$2,$3,$4,$5)", [t.slug, id, title, content, Date.now()]); } catch (e) { console.error("ruleAdd:", e.message); } }
  return t.rules[id];
}
async function ruleUpdate(t, id, title, content) {
  const r = t.rules[id]; if (!r) return null;
  if (title != null) r.title = title; if (content != null) r.content = content;
  if (pool) await pool.query("UPDATE rules SET title=$1,content=$2,updated=$3 WHERE tenant=$4 AND id=$5", [r.title, r.content, Date.now(), t.slug, id]);
  return r;
}
async function ruleDelete(t, id) {
  if (!t.rules[id]) return false; delete t.rules[id];
  if (pool) await pool.query("DELETE FROM rules WHERE tenant=$1 AND id=$2", [t.slug, id]);
  return true;
}
// ===== 自動メモリ（対応例）：スタッフの実際の返信を自動で貯め、次の下書きの“参考”にする。正式ルールではないので絶対視しない。=====
const EXAMPLE_MAX = 500; // テナントあたりの保持上限（古いものから捨てる）
async function exampleAdd(t, obj) {
  const q = String(obj.q || "").slice(0, 600).trim();
  const final = String(obj.final || "").slice(0, 1500).trim();
  if (!q || !final) return null;
  const id = t.exampleSeq++;
  const ex = { id, q, final, draft0: String(obj.draft0 || "").slice(0, 1500), instr: String(obj.instr || "").slice(0, 800), ts: Date.now() };
  t.examples[id] = ex;
  if (pool) { try { await pool.query("INSERT INTO examples (tenant,id,q,final,draft0,instr,ts) VALUES ($1,$2,$3,$4,$5,$6,$7)", [t.slug, id, ex.q, ex.final, ex.draft0, ex.instr, ex.ts]); } catch (e) { console.error("exampleAdd:", e.message); } }
  const ids = Object.keys(t.examples).map(Number).sort((a, b) => a - b);
  while (ids.length > EXAMPLE_MAX) { const old = ids.shift(); delete t.examples[old]; if (pool) pool.query("DELETE FROM examples WHERE tenant=$1 AND id=$2", [t.slug, old]).catch(() => {}); }
  return ex;
}
// スタッフの記憶（恒久ルール）を生成プロンプト用のテキストに整形
function prefsBlock(t) {
  const a = (S(t).prefs && Array.isArray(S(t).prefs)) ? S(t).prefs : [];
  return a.map(p => (typeof p === "string" ? p : (p && p.text) || "")).filter(Boolean).map(s => "・" + s).join("\n");
}
function examplesRanked(t, query, k) {
  const list = Object.values(t.examples || {});
  if (!list.length) return [];
  if (!query) return list.slice(-(k || 4));
  const qb = bigrams(query);
  const scored = list.map(e => { const tb = bigrams(e.q + " " + e.final + " " + (e.instr || "")); let n = 0; qb.forEach(b => { if (tb.has(b)) n++; }); return { e, n }; });
  scored.sort((a, b) => b.n - a.n || b.e.id - a.e.id);
  return scored.filter(x => x.n > 0).slice(0, k || 4).map(x => x.e);
}
// 矛盾検知：今回の返信が、似た過去の対応例と「事実・方針」で食い違うかをAIで判定。食い違えば前の例を返す。
async function checkConflict(t, q, newFinal, excludeId) {
  const cand = examplesRanked(t, q, 3).filter(e => e.id !== excludeId);
  if (!cand.length) return null;
  const old = cand[0];
  const sys = "2つの『お客様への返信』が、同じ種類の問い合わせに対して“事実・方針”で食い違うかだけを判定する。言い回し・丁寧さ・長さの違いは食い違いではない。料金・可否・日数・場所・有無・条件などの内容が矛盾する場合のみ conflict=true。質問の種類が違う場合や、単に情報が増えただけ・補足しただけの場合は false。出力はJSONのみ: {\"conflict\":true|false}";
  const u = "【過去】お客様: " + String(old.q).slice(0, 200) + "\n返信: " + String(old.final).slice(0, 500) + "\n\n【今回】お客様: " + String(q).slice(0, 200) + "\n返信: " + String(newFinal).slice(0, 500);
  try {
    const raw = await aiChat(t, sys, [{ role: "user", content: u }], 100);
    const m = raw && raw.match(/\{[\s\S]*\}/);
    const o = m ? JSON.parse(m[0]) : {};
    if (o && o.conflict === true) return { oldId: old.id, oldQ: old.q, oldFinal: old.final };
  } catch (e) {}
  return null;
}
// relevance search (character-bigram overlap; works for Japanese, no tokenizer needed)
function bigrams(s) { s = String(s || "").replace(/\s+/g, ""); const set = new Set(); for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2)); return set; }
// 全ルールを関連度順で返す（件数制限なし。物理枠を超えた場合のみrulesBlockが関連性の低いものを丸ごと外す）
function rulesRanked(t, query) {
  const list = rulesList(t);
  if (!query) return list;
  const qb = bigrams(query);
  const scored = list.map(r => { const tb = bigrams(r.title + " " + r.content); let n = 0; qb.forEach(b => { if (tb.has(b)) n++; }); return { r, n }; });
  scored.sort((a, b) => b.n - a.n || b.r.id - a.r.id);
  return scored.map(x => x.r);
}
function rulesSearch(t, query, limit) {
  const list = rulesList(t);
  if (!query || list.length <= limit) return list;
  const qb = bigrams(query);
  const scored = list.map(r => { const tb = bigrams(r.title + " " + r.content); let n = 0; qb.forEach(b => { if (tb.has(b)) n++; }); return { r, n }; });
  scored.sort((a, b) => b.n - a.n || b.r.id - a.r.id);
  return scored.slice(0, limit).map(x => x.r);
}
// ルールをAIに渡すブロックを作る。ルールは絶対に途中で切らない（万一物理上限に近づいたら関連性の低いルールを丸ごと外す）
// ===== 読み込み上限の中央管理 =====
// Gemini 3 Flash は約105万トークン(1,048,576)の文脈。会話履歴・出力(最大64k)・トークン換算の余白を確保した安全上限。
// 「読み込み量」を増減したい時はこの1か所だけ変えればOK（ルール枠・編集チャット参照・資料テキストすべてに反映）。
const GEMINI_MAX_CHARS = 800000;
const RULE_BUDGETS = { claude: 150000, gpt: 300000, gemini: GEMINI_MAX_CHARS }; // 各AIの物理枠（文字数）。ここを超えると関連性の低いルールが除外される
function ruleBudget(t) {
  const eng = (S(t).engine || "gemini");
  return RULE_BUDGETS[eng] || RULE_BUDGETS.gemini;
}
// ルールブックの合計文字数（rulesBlockと同じ換算: 「・タイトル: 本文」＋改行1）
function rulesCharTotal(t) {
  let n = 0;
  for (const r of rulesList(t)) { n += ("・" + r.title + ": " + String(r.content || "")).length + 1; }
  return n;
}
function rulesBlock(list, budget) {
  budget = budget || 150000;
  const out = []; let used = 0;
  for (const r of list) {
    const s = "・" + r.title + ": " + String(r.content || "");
    if (used + s.length > budget) break;
    out.push(s); used += s.length + 1;
  }
  return out.join("\n");
}

// ---------- helpers ----------
function lastText(c) { const m = c.msgs[c.msgs.length - 1]; if (!m) return ""; if (m.media === "image") return "［画像］写真"; if (m.media === "video") return "［動画］動画"; if (m.media === "file") return "［ファイル］" + (m.fileName || ""); if (m.media === "audio") return "［音声］"; return m.text || ""; }
function colorFor(s) { const cols = ["#7c93c7", "#c78a3a", "#3aa37a", "#b06fb0", "#5a8fb0", "#b05a5a", "#6f9a4a"]; let h = 0; for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) % cols.length; return cols[h]; }
function nowt() { const d = new Date(); return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0"); }
function tsFromTime(t) { const p = (t || "0:0").split(":"); const d = new Date(); d.setHours(+p[0] || 0, +p[1] || 0, 0, 0); return d.getTime(); }
function seedTenant(t) {
  const samples = [
    { id: "s1", name: "江村さおり", channel: "line", color: "#7c93c7", time: "18:50", status: "todo", flag: true, order: 1,
      draft: "お世話になっております。ご指摘ありがとうございます。指示書を再送いたしますので、少々お待ちくださいませ。",
      msgs: [{ from: "them", text: "お世話になります。先日オパールエッセンスgoを購入した江村さおりと申します。指示書が添付されておりません。ご確認お願いします。", time: "18:50" }] },
    { id: "s2", name: "萌", channel: "line", color: "#c78a3a", time: "16:11", status: "todo", flag: true, order: 2,
      draft: "お写真ありがとうございます。状態を確認のうえ担当者よりご案内いたします。",
      msgs: [{ from: "them", text: "施術後、白い斑点が気になります。写真送ります。", time: "16:09" }, { from: "them", media: "image", time: "16:11" }, { from: "them", text: "これって大丈夫でしょうか？", time: "16:11" }] },
    { id: "s3", name: "田中ゆうこ", channel: "mail", color: "#3aa37a", time: "17:30", status: "todo", flag: false,
      draft: "お世話になっております。ご予約の変更はWeb予約ページよりお手続きいただけます。前日変更はキャンセル料1,100円が発生いたします。",
      msgs: [{ from: "them", text: "明日の予約を今日キャンセル・変更したいのですが可能ですか？", time: "17:30" }] },
    { id: "s4", name: "佐藤かな", channel: "line", color: "#b06fb0", time: "16:40", status: "todo", flag: false,
      draft: "動画ありがとうございます。確認いたしますので少々お待ちください。",
      msgs: [{ from: "them", text: "マウスピースの付け方が合っているか動画撮りました。", time: "16:40" }, { from: "them", media: "video", time: "16:40" }] },
    { id: "s5", name: "えす", channel: "line", color: "#9aa0a6", time: "17:59", status: "done", flag: false,
      draft: "",
      msgs: [{ from: "them", text: "ホームホワイトニングを注文したのですが発送はいつですか？", time: "17:30" }, { from: "us", text: "お問い合わせありがとうございます。3営業日以内に発送いたします。", time: "17:59" }] }
  ];
  samples.forEach(s => { s.last = lastText(s); s.ts = tsFromTime(s.time) - 86400000; t.store[s.id] = s; dbSave(t, s); });
}

app.get("/health", (req, res) => res.json({ ok: true, tenants: Object.keys(TEN).length, db: !!pool }));

// ===== AIエンジン切り替え（返信文の生成のみ。みぎうで君等のシステム系はClaude固定） =====
// t.config.settings.engine: "claude"(標準) | "gpt" | "gemini"。各エンジンのAPIキーは環境変数（OPENAI_KEY / GEMINI_KEY、全テナント共通）
async function aiChat(t, system, messages, maxTokens){
  const eng = (S(t).engine || "gemini"); // 既定はGemini（文章作成）。Gemini失敗時のみ下のClaudeに保険でフォールバック
  if(eng === "gpt" && process.env.OPENAI_KEY){
    try{
      const model = process.env.OPENAI_MODEL || "gpt-5.4";
      const r = await fetch("https://api.openai.com/v1/chat/completions", { method:"POST",
        headers: { "Content-Type":"application/json", "Authorization":"Bearer "+process.env.OPENAI_KEY },
        body: JSON.stringify({ model, max_completion_tokens: maxTokens, reasoning_effort: "medium", messages: [{role:"system",content:system}].concat(messages) }) });  // GPT-5系は思考型。mediumで文章の質を確保（出力枠4000で途切れも防げる）。非対応モデルでエラーが出る場合はこの1項目を外す
      if(r.ok){ const d = await r.json(); const tx = d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content; if(tx) return tx; }
      else console.error("openai:", r.status, (await r.text().catch(()=>"")).slice(0,200));
    }catch(e){ console.error("openai:", e.message); }
    // 失敗時はClaudeにフォールバック（下に続く）
  }
  if(eng === "gemini" && process.env.GEMINI_KEY){
    try{
      const model = process.env.GEMINI_MODEL || "gemini-3-flash";
      const r = await fetch("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", { method:"POST",
        headers: { "Content-Type":"application/json", "Authorization":"Bearer "+process.env.GEMINI_KEY },
        body: JSON.stringify({ model, max_tokens: maxTokens, reasoning_effort: "medium", messages: [{role:"system",content:system}].concat(messages) }) });  // mediumで文章の質を確保（出力枠4000で途切れも防げる）
      if(r.ok){ const d = await r.json(); const tx = d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content; if(tx) return tx; }
      else console.error("gemini:", r.status, (await r.text().catch(()=>"")).slice(0,200));
    }catch(e){ console.error("gemini:", e.message); }
  }
  const key = ANTHROPIC_KEY;
  if(!key) return null;
  try{
    const r = await fetch("https://api.anthropic.com/v1/messages", { method:"POST",
      headers: { "Content-Type":"application/json", "x-api-key":key, "anthropic-version":"2023-06-01" },
      body: JSON.stringify({ model:"claude-sonnet-4-6", max_tokens:maxTokens, system, messages }) });
    if(!r.ok) return null;
    const d = await r.json();
    return (d.content && d.content[0] && d.content[0].text) || null;
  }catch(e){ return null; }
}

// Gemini ネイティブ generateContent（PDF・画像・大容量テキストの資料読み込み用。OpenAI互換のaiChatは添付不可のためこちらを使う）
async function geminiGenerate(systemText, userParts, maxTokens) {
  if (!process.env.GEMINI_KEY) return null;
  const model = process.env.GEMINI_MODEL || "gemini-3-flash";
  try {
    const parts = (userParts || []).map(p => (p && p.inlineData)
      ? { inlineData: { mimeType: p.inlineData.mimeType, data: p.inlineData.data } }
      : { text: String((p && p.text) || "") });
    const body = {
      systemInstruction: { parts: [{ text: String(systemText || "") }] },
      contents: [{ role: "user", parts }],
      generationConfig: { maxOutputTokens: maxTokens || 2000 }
    };
    const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent?key=" + encodeURIComponent(process.env.GEMINI_KEY), {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!r.ok) { console.error("gemini-gen:", r.status, (await r.text().catch(() => "")).slice(0, 200)); return null; }
    const d = await r.json();
    const cand = d.candidates && d.candidates[0];
    const txt = cand && cand.content && cand.content.parts && cand.content.parts.map(p => p.text || "").join("");
    return txt || null;
  } catch (e) { console.error("gemini-gen:", e.message); return null; }
}

// ===== AI brain: shared draft generator (used by LINE + email, in-app) =====
const JP_QUALITY ="【日本語の品質（トーン指示よりも優先）】実際の日本人受付スタッフが書いたものと区別がつかない、自然で正しい日本語にすること。不自然な敬語・誤った敬語・二重敬語は絶対に使わない。禁止例:「大変良かったでございます」「拝見させていただきます」「ご確認していただけます」「お伺いさせていただきます」。正しい例:「安心いたしました」「拝見します」「ご確認いただけます」「伺います」。動詞の活用や助詞の誤りがないか、文のつながりが自然か、出力する前に全文を自己点検し、少しでも違和感のある文は書き直してから出力すること。【AIっぽさの排除（同じく必須）】(1)同じ結論を言い換えて繰り返さない。結論は一度だけ述べる。(2)「原則として」「基本的には」「特に指示がない限り」等の保険表現は1通につき1回まで。(3)「〜についてご案内いたします」のような前置きの宣言は書かず、すぐ本題に入る。(4)1文ごとに空行で区切らない。関連する文は同じ段落にまとめる。(5)締めの定型句（ご安心くださいませ・どうぞよろしくお願いいたします等）は1文だけにする。(6)機械翻訳のような直訳調・カタコト・不要な主語（私たちは・当院では…）の多用をしない。日本語として自然な語順と省略にする。(7)「〜させていただきます」は実際に許可や恩恵がある時だけ使う。例:「確認させていただきます」→「確認します」、「ご案内させていただきます」→「ご案内します」。(8)「〜となります」「〜になります」は状態が変化する時だけ使う。例:「こちらが料金となります」→「こちらが料金です」。(9)同じ文末（です・ます・ございます）を3回以上連続させない。語尾に自然な変化をつける。(10)二重否定や回りくどい言い回しを避け、要点を先に短く述べる。出力する前に、声に出して読んで不自然なところがないか必ず一度見直す。";
// 出力が途中で切れる等でJSONがパースできない時、draft本文だけを救出する保険
function salvageDraft(raw) {
  const s = String(raw || "").trim();
  const m = s.match(/"draft"\s*:\s*"((?:[^"\\]|\\.)*)/);
  if (m) {
    try { return JSON.parse('"' + m[1] + '"'); }
    catch (e) { return m[1].replace(/\\n/g, "\n").replace(/\\"/g, '"'); }
  }
  return s;
}
// ===== 受付くん連携: 受信イベント転送（fire-and-forget。失敗してもメイン処理は止めない） =====
function forwardToPartner(t, c, extra) {
  try {
    if (!PARTNER_KEY || !PARTNER_HOOK_URL) return;
    const payload = {
      slug: t.slug,
      convId: c.id,
      channel: c.channel,
      userId: c.userId,
      name: c.name || "",
      text: c.last || lastText(c) || "",
      subject: c.subject || "",
      acct: c.acct || null,
      ts: c.ts || Date.now(),
    };
    if (extra && typeof extra === "object") Object.assign(payload, extra);
    const ctrl = new AbortController();
    const timer = setTimeout(() => { try { ctrl.abort(); } catch (e) {} }, 5000);
    fetch(PARTNER_HOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-partner-key": PARTNER_KEY },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    }).then(() => {}).catch(() => {}).finally(() => clearTimeout(timer));
  } catch (e) {}
}

// ===== 受付くん連携: AI下書き前の予約照会 =====
function bookingToText(data) {
  try {
    if (!data) return "";
    if (typeof data === "string") return data.slice(0, 1200);
    if (data.found === false || data.exists === false || data.ok === false) return "";
    if (typeof data.text === "string" && data.text.trim()) return data.text.trim().slice(0, 1200);
    let list = Array.isArray(data.bookings) ? data.bookings : (Array.isArray(data) ? data : null);
    if (!list && data.booking && typeof data.booking === "object") list = [data.booking];
    if (list && list.length) {
      return list.slice(0, 5).map(b => {
        if (typeof b === "string") return "・" + b;
        const d = b.date || b.datetime || b.start || b.reservedAt || "";
        const menu = b.menu || b.service || b.title || b.course || "";
        const staff = b.staff || b.practitioner || b.doctor || "";
        const st = b.status || "";
        const cols = [d, menu, staff, st].filter(Boolean);
        return cols.length ? "・" + cols.join(" / ") : "";
      }).filter(Boolean).join("\n").slice(0, 1200);
    }
    return "";
  } catch (e) { return ""; }
}
async function fetchBooking(t, c) {
  try {
    if (!PARTNER_KEY || !PARTNER_BOOKING_URL) return "";
    const url = PARTNER_BOOKING_URL
      + "?slug=" + encodeURIComponent(t.slug)
      + "&channel=" + encodeURIComponent(c.channel || "")
      + "&userId=" + encodeURIComponent(c.userId || "");
    const ctrl = new AbortController();
    const timer = setTimeout(() => { try { ctrl.abort(); } catch (e) {} }, 4000);
    let resp;
    try { resp = await fetch(url, { headers: { "x-partner-key": PARTNER_KEY }, signal: ctrl.signal }); }
    finally { clearTimeout(timer); }
    if (!resp || !resp.ok) return ""; // 404（未実装）等は予約情報なしで通常生成
    const data = await resp.json().catch(() => null);
    return bookingToText(data);
  } catch (e) { return ""; }
}

// ===== 自動返信の待ち時間スケジューラ（メモリ上。プロセス再起動で予約は消える＝短い遅延向け） =====
const pendingAuto = new Map();
function autoKey(t, id) { return t.slug + "::" + id; }
function cancelAutoReply(t, id) {
  const k = autoKey(t, id);
  const h = pendingAuto.get(k);
  if (h) { clearTimeout(h); pendingAuto.delete(k); }
}
function scheduleAutoReply(t, c, draftText, recvAt, delayMin) {
  cancelAutoReply(t, c.id);
  const k = autoKey(t, c.id);
  const wait = Math.max(0, recvAt + delayMin * 60000 - Date.now()); // 生成に設定時間以上かかっていたら0=即時
  const h = setTimeout(async () => {
    pendingAuto.delete(k);
    try {
      const cur = t.store[c.id];
      if (!cur) return;
      if (!S(t).autoReply) return;                 // 待機中に自動返信OFFにされた
      if (cur.status === "done" || cur.flag) return; // 既に対応済み/フラグ付き
      if (!cur.draft || cur.draft.trim() !== draftText) return; // 下書きが変わった/消えた
      const lastMsg = cur.msgs[cur.msgs.length - 1];
      if (!lastMsg || lastMsg.from !== "them") return; // 待機中に誰かが返信した
      const r = await deliverText(t, cur, draftText);
      if (r.sent) {
        cur.msgs.push({ from: "us", text: draftText, auto: true, time: nowt() });
        cur.draft = ""; cur.draft0 = ""; cur.status = "done"; cur.lastAuto = true;
        cur.time = nowt(); cur.ts = Date.now(); cur.last = lastText(cur); dbSave(t, cur);
        try { notifyAll(t, "🤖 自動返信済み: " + (cur.name || ""), (cur.last || "").slice(0, 90)); } catch (e) {}
      }
    } catch (e) {}
  }, wait);
  pendingAuto.set(k, h);
}

async function genDraft(t, c, opts) {
  opts = opts || {};
  const channel = c.channel;
  // 検索キーは直近3件のお客様メッセージ（最後の一言だけだと文脈語が拾えないため）
  const lastQ = c.msgs.filter(m => m.from === "them").slice(-3).map(m => m.text || "").join(" ");
  const rel = rulesRanked(t, lastQ.slice(0, 1500));
  const rulesTxt = rulesBlock(rel, ruleBudget(t));
  const exRel = examplesRanked(t, lastQ.slice(0, 1500), 4); // 自動メモリ：関連する過去の対応例
  const examplesTxt = exRel.length ? exRel.map(e => "・お客様「" + String(e.q).slice(0, 160) + "」→ スタッフの返信「" + String(e.final).slice(0, 300) + "」" + (e.instr ? "（スタッフが作り直しで出した方針: " + String(e.instr).slice(0, 160) + "）" : "")).join("\n") : "";
  const today = new Date().toLocaleDateString("ja-JP", { year: "numeric", month: "long", day: "numeric", weekday: "short" });
  const sig = channel === "mail" ? "メールなので返信本文の最後に改行して「" + (t.name || "クリニック") + " サポート」と署名を付ける。" : "LINEなので署名は付けない。";
  const msgsArr = []; let cur = null;
  c.msgs.slice(-16).forEach(m => {
    const role = m.from === "them" ? "user" : "assistant";
    const tx = (m.text || (m.media ? "［" + m.media + "を送信］" : "")).trim();
    if (!tx) return;
    if (cur && cur.role === role) { cur.content = (cur.content + "\n" + tx).slice(0, 3000); }
    else { cur = { role, content: tx.slice(0, 3000) }; msgsArr.push(cur); }
  });
  while (msgsArr.length && msgsArr[0].role === "assistant") msgsArr.shift();
  if (!msgsArr.length || msgsArr[msgsArr.length - 1].role !== "user") return null;
  let bookingTxt = "";
  try { bookingTxt = await fetchBooking(t, c); } catch (e) { bookingTxt = ""; }
  const sys = "あなたはクリニック・店舗「" + (t.name || "クリニック") + "」の受付スタッフです。お客様とこの会話をしてきた本人として、最新のメッセージへの返信を書きます。一流ホテルのコンシェルジュのように上質で温かく、品のある丁寧な言葉遣いで対応する。"
    + "本日は" + today + "です。キャンセル料など日付が関わる案内は、本日と予約日の差から判断すること（予約日の前日にあたる連絡なら前日扱い、当日なら当日扱い、それより前なら通常キャンセル料は不要）。憶測で日付を決めない。"
    + (opts.only && opts.only.length
        ? "お客様は複数の連絡をしているが、今回はスタッフが選んだ次の項目だけに答えること。選ばれていない項目には一切触れない: 「" + opts.only.map(s => String(s)).join("」「") + "」。会話で既に伝えた内容は繰り返さない。"
        : "お客様が複数の質問・依頼をしている場合は、その全てにもれなく答えること。1つも取りこぼさない。会話で既に伝えた内容は繰り返さない。")
    + "医療判断・診断はしない。「絶対」「完治」など断定的表現は使わない。絵文字は使わない。" + sig
    + (rulesTxt ? "\n\n【店舗ルール（最優先で従う。料金・規定・対応可否はここに従い、推測で答えない）】\n" + rulesTxt : "")
    + (examplesTxt ? "\n\n【過去の対応例（スタッフが実際に送った返信。答え方・言い回し・上のルールに無い細かい対応の“参考”にしてよい。ただし料金・規定・対応可否は必ず上の店舗ルールが優先で、例がルールと食い違う場合はルールに従う。特定の人にだけ通じる特別対応は一般化しない）】\n" + examplesTxt : "")
    + (S(t).tone && S(t).tone.trim() ? "\n\n【トーン指示（最優先）】\n" + S(t).tone.trim().slice(0, 1200) : "")
    + (prefsBlock(t) ? "\n\n【スタッフが記憶させた指示（全返信で必ず守る。トーン指示と同格で最優先）】\n" + prefsBlock(t) : "")
    + (bookingTxt ? "\n\n【この方の予約情報（予約システムからの照会結果。日付判断・キャンセル可否・来院案内の参考にする。ここに無い予約内容は推測しない）】\n" + bookingTxt : "")
    + "\n\n" + JP_QUALITY
    + "\n\n出力は必ず次のJSONのみ（前後に説明や```やかぎ括弧を付けない）: {\"draft\":\"お客様への返信文\",\"confidence\":\"high|medium|low\",\"is_urgent\":true|false,\"needs_human\":true|false,\"site_alert\":\"遅刻|当日キャンセル|緊急来院|none\",\"site_summary\":\"現場向け一行要約。site_alertがnoneなら空文字\",\"topics\":[{\"q\":\"短い質問ラベル\",\"need\":true}]}"
    + "\nconfidence: ルールと会話から自信を持って答えられればhigh、判断に迷う/情報不足ならlow。"
    + "\nneeds_human: 予約状況の確認・キャンセル例外判断・クレーム・支払いトラブル・偽物疑惑などスタッフ確認が必要ならtrue。"
    + "\nis_urgent: 痛み・出血・腫れ・強い不調など緊急性があればtrue。"
    + "\ntopics: お客様の直近メッセージにある「返信すべき質問・依頼」を、それぞれ短い日本語ラベル(q)で列挙する（最大5件）。状況連絡・挨拶・お礼や、時間が経って既に解決済みと思われるもの（例: かなり前に届いた『遅れます』）は need:false。それ以外は need:true。質問が1つだけなら1件でよい。";
  try {
    const raw = await aiChat(t, sys, msgsArr, 4000);
    if (!raw) return null;
    let out = null; try { const m = raw.match(/\{[\s\S]*\}/); out = JSON.parse(m ? m[0] : raw); } catch (e) { out = { draft: salvageDraft(raw), confidence: "low", is_urgent: false, needs_human: true, site_alert: "none", site_summary: "" }; }
    return out;
  } catch (e) { return null; }
}

// ===== shared inbound handler (LINE webhook / email poller / ingest all funnel here) =====
async function handleInbound(t, opts) {
  const channel = opts.channel === "mail" ? "mail" : "line";
  const uid = String(opts.uid || "unknown");
  const id = channel + ":" + uid;
  const recvAt = Date.now();   // 受信時刻（自動返信の待ち時間の起点）
  cancelAutoReply(t, id);      // 新着が来たので、保留中の自動返信予約があれば取り消して作り直す
  let c = t.store[id];
  if (!c) { c = t.store[id] = { id, userId: uid, name: opts.name || (channel === "mail" ? uid : "LINEのお客様"), channel, color: colorFor(id), status: "todo", flag: false, msgs: [], draft: "" }; }
  c.userId = uid;
  if (opts.name) c.name = opts.name;
  if (opts.pic) c.pic = opts.pic;
  if (opts.acct) c.acct = opts.acct; // どの連携アカウント（LINEチャネル/メールアドレス）経由か
  const med = ["image", "video", "file", "audio"].includes(opts.media) ? opts.media : null;
  c.msgs.push({ from: "them", text: opts.text || "", media: med, mediaId: med ? (opts.mediaId || null) : null, fileName: med === "file" ? (opts.fileName || "ファイル") : undefined, time: nowt() });
  if (opts.subject) c.subject = String(opts.subject).slice(0, 300);
  c.status = "todo"; c.time = nowt(); c.ts = Date.now(); c.last = lastText(c); dbSave(t, c);

  let confidence = opts.confidence, needsHuman = opts.needsHuman, urgent = opts.urgent, siteAlert = opts.siteAlert, siteSummary = opts.siteSummary;
  if (typeof opts.draft === "string") { c.draft = opts.draft; c.draft0 = opts.draft; }
  else if (!med) { // generate draft in-app for text messages
    const g = await genDraft(t, c);
    if (g) { c.draft = String(g.draft || ""); c.draft0 = c.draft; confidence = g.confidence; needsHuman = g.needs_human; urgent = g.is_urgent; siteAlert = g.site_alert; siteSummary = g.site_summary; c.topics = Array.isArray(g.topics) ? g.topics : []; }
  }
  if (confidence) c.confidence = confidence;
  dbSave(t, c);

  try { const sa = String(siteAlert || "").trim(); if (sa && sa !== "none") await alertAdd(t, sa, String(siteSummary || c.last || "").slice(0, 200), c.name || ""); } catch (e) {}

  let autoSent = false;     // この受信処理の中で即時送信したか
  let autoScheduled = false; // 待ち時間後に送信する予約をしたか
  try {
    const conf = String(confidence || "").toLowerCase();
    const confOk = conf === "high" || (S(t).level === "medium" && conf === "medium");
    const safe = String(needsHuman) !== "true" && String(urgent) !== "true" && !c.flag && !med;
    if (S(t).autoReply && confOk && safe && c.draft && c.draft.trim()) {
      const draftText = c.draft.trim();
      const delayMin = Number(S(t).autoDelayMin || 0);
      if (delayMin > 0 && (recvAt + delayMin * 60000 - Date.now()) > 0) {
        // 受信からdelayMin分が経過していない → 残り時間だけ待ってから送信（生成が設定時間を超えていれば即時）
        scheduleAutoReply(t, c, draftText, recvAt, delayMin);
        autoScheduled = true;
      } else {
        const r = await deliverText(t, c, draftText);
        if (r.sent) { c.msgs.push({ from: "us", text: draftText, auto: true, time: nowt() }); c.draft = ""; c.draft0 = ""; c.status = "done"; c.lastAuto = true; c.time = nowt(); c.ts = Date.now(); c.last = lastText(c); dbSave(t, c); autoSent = true; }
      }
    }
  } catch (e) {}
  try { if (autoSent) notifyAll(t, "🤖 自動返信済み: " + (c.name || ""), (c.last || "").slice(0, 90)); else notifyAll(t, c.name || "新着メッセージ", (c.last || "新しいメッセージが届きました").slice(0, 90)); } catch (e) {}
  try { forwardToPartner(t, c, { autoSent, autoScheduled }); } catch (e) {} // 受付くんへ受信イベントを転送
  return { id, autoSent, autoScheduled };
}

// ===== 複数アカウント対応: メイン（conn直下）＋追加分（conn.lines / conn.mails） =====
function lineAccounts(t) {
  const arr = [];
  const conn = t.config.conn;
  if (C.lineToken(t)) arr.push({ name: conn.lineName || "メイン", token: C.lineToken(t), secret: C.lineSecret(t), botId: conn.lineBotId || "", main: true });
  (Array.isArray(conn.lines) ? conn.lines : []).forEach(a => { if (a && a.token) arr.push({ name: a.name || "LINE", token: a.token, secret: a.secret || "", botId: a.botId || "" }); });
  return arr;
}
function mailAccounts(t) {
  const arr = [];
  const conn = t.config.conn;
  if (C.smtpUser(t) && C.smtpPass(t)) arr.push({ name: conn.mailName || "メイン", smtpHost: C.smtpHost(t), smtpPort: C.smtpPort(t), smtpUser: C.smtpUser(t), smtpPass: C.smtpPass(t), imapHost: C.imapHost(t), imapPort: C.imapPort(t), imapUser: C.imapUser(t), imapPass: C.imapPass(t), main: true });
  (Array.isArray(conn.mails) ? conn.mails : []).forEach(a => {
    if (a && a.smtpUser && a.smtpPass) arr.push({ name: a.name || "メール", smtpHost: a.smtpHost || "smtp.gmail.com", smtpPort: +(a.smtpPort || 465), smtpUser: a.smtpUser, smtpPass: a.smtpPass, imapHost: a.imapHost || "imap.gmail.com", imapPort: +(a.imapPort || 993), imapUser: a.imapUser || a.smtpUser, imapPass: a.imapPass || a.smtpPass });
  });
  return arr;
}
// メインLINEのbotId（宛先振り分け用）を未取得なら取得しておく（テナントごと・遅延）
async function ensureLineBotId(t) {
  const conn = t.config.conn;
  if (C.lineToken(t) && !conn.lineBotId) {
    try {
      const r = await fetch("https://api.line.me/v2/bot/info", { headers: { "Authorization": "Bearer " + C.lineToken(t) } });
      if (r.ok) { const j = await r.json(); if (j.userId) { conn.lineBotId = j.userId; await saveTenantConfig(t); } }
    } catch (e) {}
  }
}

// ===== LINE inbound webhook（全テナント共通URL。destination(botId)→署名でテナント×アカウントを特定） =====
async function lineProfile(uid, token) {
  if (!token) return {};
  try { const r = await fetch("https://api.line.me/v2/bot/profile/" + uid, { headers: { "Authorization": "Bearer " + token } }); if (r.ok) { const j = await r.json(); return { name: j.displayName, pic: j.pictureUrl }; } } catch (e) {}
  return {};
}
app.post("/webhook/line", async (req, res) => {
  const dest = String((req.body && req.body.destination) || "");
  const sig = req.headers["x-line-signature"];
  const sigOk = (a) => { if (!a.secret) return true; try { return sig === crypto.createHmac("sha256", a.secret).update(req.rawBody || Buffer.from("")).digest("base64"); } catch (e) { return false; } };
  // 宛先botIdでテナント×アカウント特定 → 署名検証。特定できなければ署名が合うアカウントを全テナントから探す
  let t = null, acct = null;
  if (dest) {
    for (const slug of Object.keys(TEN)) {
      if (TEN[slug].config.suspended) continue;
      const hit = lineAccounts(TEN[slug]).find(a => a.botId && a.botId === dest);
      if (hit) { t = TEN[slug]; acct = hit; break; }
    }
  }
  if (acct) { if (!sigOk(acct)) return res.status(401).end(); }
  else {
    // マルチテナントでは secret 未設定のアカウントが全リクエストにマッチしてしまうため、署名検証できるアカウントのみ対象
    for (const slug of Object.keys(TEN)) {
      if (TEN[slug].config.suspended) continue;
      const hit = lineAccounts(TEN[slug]).find(a => a.secret && sigOk(a));
      if (hit) { t = TEN[slug]; acct = hit; break; }
    }
    if (!acct) return res.status(401).end();
  }
  // botId未保存なら覚えておく（次回から即特定できる）
  if (dest && !acct.botId) {
    const conn = t.config.conn;
    if (acct.main) { conn.lineBotId = dest; }
    else { const raw = (conn.lines || []).find(x => x.token === acct.token); if (raw) raw.botId = dest; }
    acct.botId = dest; saveTenantConfig(t).catch(() => {});
  }
  res.status(200).end();
  const events = (req.body && req.body.events) || [];
  for (const ev of events) {
    try {
      if (ev.type !== "message" || !ev.message) continue;
      const uid = ev.source && ev.source.userId; if (!uid) continue;
      const prof = await lineProfile(uid, acct.token);
      const mt = ev.message.type;
      let text = "", media = null, mediaId = null, fileName = null;
      if (mt === "text") text = ev.message.text || "";
      else if (mt === "image" || mt === "video" || mt === "audio") { media = mt; mediaId = ev.message.id; }
      else if (mt === "file") { media = "file"; mediaId = ev.message.id; fileName = ev.message.fileName || "ファイル"; }
      else continue;
      await handleInbound(t, { channel: "line", uid, name: prof.name, pic: prof.pic, text, media, mediaId, fileName, acct: { type: "line", key: acct.botId || "main", name: acct.name } });
    } catch (e) { console.error("line webhook:", e.message); }
  }
});

// ===== Email inbound via IMAP（全テナント横断ポーリング。provider-agnostic: Gmail/Outlook/独自ドメイン） =====
let emailPolling = false;
async function pollAll() {
  if (emailPolling) return; emailPolling = true;
  let ImapFlow, simpleParser;
  try { ImapFlow = require("imapflow").ImapFlow; simpleParser = require("mailparser").simpleParser; }
  catch (e) { console.error("imap libs missing"); emailPolling = false; return; }
  for (const slug of Object.keys(TEN)) {
    const t = TEN[slug];
    if (t.config.suspended) continue;
    if (!emailOn(t)) continue;
    const accounts = mailAccounts(t);
    if (!accounts.length) continue;
    const conn = t.config.conn;
    // 有効化以降に届いたメールだけ処理する（過去の未読への一斉下書き/自動返信を防ぐ）
    let cutoff = +conn.mailCutoff || 0;
    if (!cutoff) { cutoff = Date.now(); conn.mailCutoff = cutoff; try { await saveTenantConfig(t); } catch (_) {} }
    // 処理済みメールのMessage-ID台帳（二重取り込み防止の保険）
    const seenIds = new Set(Array.isArray(conn.seenIds) ? conn.seenIds : []);
    const ownAddrs = accounts.map(a => String(a.imapUser || a.smtpUser || "").toLowerCase());
    for (const acc of accounts) {
      // SNI(servername)を明示しないとGoogleがダミー証明書を返し接続失敗する（Railway環境で確認済み）
      const client = new ImapFlow({ host: acc.imapHost, servername: acc.imapHost, port: acc.imapPort, secure: true, auth: { user: acc.imapUser, pass: acc.imapPass }, logger: false, greetingTimeout: 20000, socketTimeout: 90000 });
      client.on("error", (e) => console.error("imap event (" + slug + "/" + acc.name + "):", e && e.message));
      try {
        await client.connect();
        const lock = await client.getMailboxLock("INBOX");
        try {
          // 注意: fetchループの最中に他のIMAPコマンド（既読化など）を実行してはいけない（無効になる）
          const items = [];
          for await (const msg of client.fetch({ seen: false, since: new Date(Date.now() - 2 * 86400000) }, { source: true })) {
            items.push({ uid: msg.uid, source: msg.source });
          }
          const markUids = [];
          for (const it of items) {
            try {
              const parsed = await simpleParser(it.source);
              const mdate = parsed.date ? new Date(parsed.date).getTime() : Date.now();
              if (mdate < cutoff) continue; // 有効化前のメールは未読のまま放置
              const mid = String(parsed.messageId || "").trim();
              markUids.push(it.uid);
              if (mid && seenIds.has(mid)) continue; // 既に処理済み
              if (mid) seenIds.add(mid);
              const fromV = (parsed.from && parsed.from.value && parsed.from.value[0]) || {};
              const email = String(fromV.address || "").toLowerCase();
              if (!email || ownAddrs.includes(email)) continue;
              if (/no-?reply|mailer-daemon|postmaster/i.test(email)) continue;
              const text = String(parsed.text || parsed.subject || "").replace(/\r/g, "").slice(0, 8000);
              await handleInbound(t, { channel: "mail", uid: email, name: fromV.name || email, text, subject: parsed.subject || "", acct: { type: "mail", key: acc.smtpUser, name: acc.name } });
            } catch (e) { console.error("mail parse:", e.message); }
          }
          // フェッチ完了後にまとめて既読化（ループ中は効かないため）
          if (markUids.length) {
            try { await client.messageFlagsAdd(markUids.join(","), ["\\Seen"], { uid: true }); }
            catch (e) { console.error("mail seen:", e.message); }
          }
        } finally { lock.release(); }
        await client.logout();
      } catch (e) { console.error("imap (" + slug + "/" + acc.name + "):", e.message); try { await client.logout(); } catch (_) {} }
    }
    // 台帳を保存（直近300件まで）
    try { conn.seenIds = Array.from(seenIds).slice(-300); await saveTenantConfig(t); } catch (_) {}
  }
  emailPolling = false;
}

// Make等の外部連携が新規問い合わせをPOSTする（server-to-server, secret key + tenant slug 必須）
app.post("/api/ingest", async (req, res) => {
  if ((req.headers["x-key"] || req.body.key) !== INGEST_KEY) return res.status(401).json({ error: "bad key" });
  const t = TEN[String(req.body.tenant || "")];
  if (!t) return res.status(400).json({ error: "tenant" });
  const b = req.body || {};
  const channel = (b.channel || "line").toLowerCase().includes("mail") || (b.channel || "").toLowerCase() === "gmail" ? "mail" : "line";
  const r = await handleInbound(t, {
    channel,
    uid: (b.userId || b.email || b.id || "unknown").toString(),
    name: b.name, pic: b.pic, text: b.text, media: b.media, mediaId: b.mediaId, fileName: b.fileName, subject: b.subject,
    draft: typeof b.draft === "string" ? b.draft : undefined,
    confidence: b.confidence, needsHuman: b.needsHuman, urgent: b.urgent, siteAlert: b.siteAlert, siteSummary: b.siteSummary
  });
  res.json({ ok: true, ...r });
});

app.get("/api/conversations", guard, (req, res) => {
  const arr = Object.values(req.tenant.store).sort((a, b) => {
    if (a.flag && !b.flag) return -1; if (!a.flag && b.flag) return 1;
    if (a.flag && b.flag) return (a.order || 0) - (b.order || 0);
    return (b.ts || 0) - (a.ts || 0);
  });
  res.json(arr);
});

async function deliverText(t, c, text) {
  let sent = false, sendErr = null;
  const to = c.userId || (c.id.split(":")[1] || "");
  if (c.channel === "line") {
    // 届いたアカウント（チャネル）から返す。特定できなければメイン
    const accts = lineAccounts(t);
    const key = c.acct && c.acct.type === "line" ? c.acct.key : null;
    const a = (key ? accts.find(x => (x.botId || "main") === key || (key === "main" && x.main)) : null) || accts[0];
    if (a && to) {
      try {
        const resp = await fetch("https://api.line.me/v2/bot/message/push", { method: "POST", headers: { "Content-Type": "application/json", "Authorization": "Bearer " + a.token }, body: JSON.stringify({ to, messages: [{ type: "text", text }] }) });
        sent = resp.ok; if (!resp.ok) sendErr = "LINE_" + resp.status;
      } catch (e) { sendErr = String(e.message || e).slice(0, 80); }
    } else { sendErr = "no_send_config"; }
  } else if (c.channel === "mail") {
    const accts = mailAccounts(t);
    const key = c.acct && c.acct.type === "mail" ? c.acct.key : null;
    const a = (key ? accts.find(x => x.smtpUser === key) : null) || accts[0];
    if (a && to) {
      try {
        const nodemailer = require("nodemailer");
        const tp = nodemailer.createTransport({ host: a.smtpHost, port: a.smtpPort, secure: a.smtpPort === 465, auth: { user: a.smtpUser, pass: a.smtpPass } });
        const subj = c.subject ? (/^re:/i.test(c.subject) ? c.subject : "Re: " + c.subject) : "お問い合わせについて（" + (t.name || "クリニック") + "）";
        await tp.sendMail({ from: (t.name || "クリニック") + " <" + a.smtpUser + ">", to, subject: subj, text });
        sent = true;
      } catch (e) { sendErr = String(e.message || e).slice(0, 100); }
    } else { sendErr = "mail_send_pending"; }
  }
  else { sendErr = "no_send_config"; }
  return { sent, sendErr };
}

app.post("/api/send", guard, async (req, res) => {
  const t = req.tenant;
  const c = t.store[req.body.id]; if (!c) return res.status(404).json({ error: "no" });
  cancelAutoReply(t, c.id); // スタッフが手動返信したので保留中の自動返信は取り消す
  const text = (req.body.text || "").trim(); if (!text) return res.status(400).json({ error: "empty" });
  const { sent, sendErr } = await deliverText(t, c, text);
  let learnedId = null, conflict = null;
  if (sent) {
    const draft0 = String(c.draft0 || "").trim(); // 学習判定用に、消す前のAI初回下書きを確保
    c.msgs.push({ from: "us", text, time: nowt() }); c.draft = ""; c.status = "done"; c.flag = false; c.lastAuto = false; c.time = nowt(); c.ts = Date.now(); c.last = lastText(c); dbSave(t, c);
    // 自動メモリ：AIの下書きと違う返信（＝スタッフの貢献）だけを対応例として自動保存。送信したそのままは保存しない。
    if (text !== draft0) {
      const q0 = c.msgs.filter(m => m.from === "them").slice(-3).map(m => m.text || "").join(" ").trim();
      if (q0) {
        const ex = await exampleAdd(t, { q: q0, final: text, draft0, instr: req.body.instr || "" });
        if (ex) {
          learnedId = ex.id;
          const cf = await checkConflict(t, q0, text, ex.id); // 似た過去の対応例と矛盾していないか
          if (cf) conflict = { oldId: cf.oldId, oldFinal: cf.oldFinal, newId: ex.id, newFinal: text };
        }
      }
    }
  }
  res.json({ ok: true, sent, sendErr, learnedId, conflict });
});

// connection settings (secrets are write-only: never echoed back)
app.get("/api/conn", guard, (req, res) => {
  const t = req.tenant; const conn = t.config.conn;
  res.json({
    lineConfigured: !!C.lineToken(t) && !!C.lineSecret(t),
    mailConfigured: !!C.smtpUser(t) && !!C.smtpPass(t),
    emailInternal: !!emailOn(t),
    smtpHost: C.smtpHost(t), smtpPort: C.smtpPort(t), smtpUser: C.smtpUser(t),
    imapHost: C.imapHost(t), imapPort: C.imapPort(t), imapUser: C.imapUser(t),
    webhookUrl: "https://" + (req.headers["x-forwarded-host"] || req.headers.host) + "/webhook/line",
    extraLines: (Array.isArray(conn.lines) ? conn.lines : []).map(a => ({ name: a.name || "LINE" })),
    extraMails: (Array.isArray(conn.mails) ? conn.mails : []).map(a => ({ name: a.name || "メール", smtpUser: a.smtpUser || "" }))
  });
});
// 追加アカウントの登録・削除（秘密情報は書き込み専用）
app.post("/api/conn-add", guard, async (req, res) => {
  const t = req.tenant; const conn = t.config.conn;
  const b = req.body || {};
  if (b.kind === "line") {
    const token = String(b.token || "").trim(), secret = String(b.secret || "").trim(), name = String(b.name || "LINE").slice(0, 40);
    if (!token || !secret) return res.json({ ok: false, error: "missing" });
    let botId = "";
    try {
      const r = await fetch("https://api.line.me/v2/bot/info", { headers: { "Authorization": "Bearer " + token } });
      if (!r.ok) return res.json({ ok: false, error: "bad_token" });
      const j = await r.json(); botId = j.userId || "";
    } catch (e) { return res.json({ ok: false, error: "line_api" }); }
    conn.lines = Array.isArray(conn.lines) ? conn.lines : [];
    conn.lines.push({ name, token, secret, botId });
  } else if (b.kind === "mail") {
    const a = {
      name: String(b.name || "メール").slice(0, 40),
      smtpHost: String(b.smtpHost || "smtp.gmail.com").slice(0, 200), smtpPort: +(b.smtpPort || 465),
      smtpUser: String(b.smtpUser || "").trim().slice(0, 200), smtpPass: String(b.smtpPass || "").trim().slice(0, 200),
      imapHost: String(b.imapHost || "imap.gmail.com").slice(0, 200), imapPort: +(b.imapPort || 993),
      imapUser: String(b.imapUser || "").trim().slice(0, 200), imapPass: String(b.imapPass || "").trim().slice(0, 200)
    };
    if (!a.smtpUser || !a.smtpPass) return res.json({ ok: false, error: "missing" });
    conn.mails = Array.isArray(conn.mails) ? conn.mails : [];
    conn.mails.push(a);
  } else return res.json({ ok: false, error: "kind" });
  try { await saveTenantConfig(t); } catch (e) { return res.status(500).json({ ok: false }); }
  res.json({ ok: true });
});
app.post("/api/conn-del", guard, async (req, res) => {
  const t = req.tenant; const conn = t.config.conn;
  const kind = req.body.kind, i = +req.body.i;
  if (kind === "line" && Array.isArray(conn.lines) && conn.lines[i]) conn.lines.splice(i, 1);
  else if (kind === "mail" && Array.isArray(conn.mails) && conn.mails[i]) conn.mails.splice(i, 1);
  else return res.json({ ok: false });
  try { await saveTenantConfig(t); } catch (e) { return res.status(500).json({ ok: false }); }
  res.json({ ok: true });
});
app.post("/api/conn", guard, async (req, res) => {
  const t = req.tenant; const conn = t.config.conn;
  const b = req.body || {};
  ["lineToken", "lineSecret", "smtpHost", "smtpUser", "smtpPass", "imapHost", "imapUser", "imapPass"].forEach(k => {
    if (typeof b[k] === "string" && b[k].trim()) conn[k] = b[k].trim().slice(0, 300);
  });
  if (b.smtpPort) conn.smtpPort = +b.smtpPort; if (b.imapPort) conn.imapPort = +b.imapPort;
  if (typeof b.emailInternal === "boolean") conn.emailInternal = b.emailInternal;
  // LINEトークンが変わったらbotIdを取り直す（webhook振り分け用）
  if (typeof b.lineToken === "string" && b.lineToken.trim()) { delete conn.lineBotId; }
  try { await saveTenantConfig(t); } catch (e) { return res.status(500).json({ ok: false }); }
  ensureLineBotId(t).catch(() => {});
  res.json({ ok: true, lineConfigured: !!C.lineToken(t) && !!C.lineSecret(t), mailConfigured: !!C.smtpUser(t) && !!C.smtpPass(t), emailInternal: !!emailOn(t) });
});

// 新モデル検知：OpenAIのモデル一覧から、現行(OPENAI_MODEL)より新しいフラッグシップGPTが出ているか判定。結果は1日キャッシュ（毎回APIを叩かない）。
let MODEL_CHECK_CACHE = { ts: 0, current: "", latest: "", newer: false, error: null };
async function checkNewerModel() {
  const now = Date.now();
  if (MODEL_CHECK_CACHE.ts && now - MODEL_CHECK_CACHE.ts < 24 * 60 * 60 * 1000) return MODEL_CHECK_CACHE;
  const current = process.env.OPENAI_MODEL || "gpt-5.4";
  let latest = current, newer = false, error = null;
  try {
    if (process.env.OPENAI_KEY) {
      const r = await fetch("https://api.openai.com/v1/models", { headers: { "Authorization": "Bearer " + process.env.OPENAI_KEY } });
      if (r.ok) {
        const d = await r.json();
        const ids = (d.data || []).map(m => m.id);
        // フラッグシップの文章生成モデルだけを対象（gpt-5.5 / gpt-6 等）。mini・nano・pro・codex・audio・日付付きスナップショット等は誤検知防止のため除外。
        const ver = id => { const m = /^gpt-(\d+(?:\.\d+)?)$/.exec(id); return m ? parseFloat(m[1]) : null; };
        const curV = ver(current);
        let bestId = current, bestV = (curV != null ? curV : -1);
        ids.forEach(id => { const v = ver(id); if (v != null && v > bestV) { bestV = v; bestId = id; } });
        latest = bestId;
        newer = (curV != null && bestV > curV);
      } else { error = "models_" + r.status; }
    } else { error = "no_key"; }
  } catch (e) { error = String(e.message || e).slice(0, 80); }
  MODEL_CHECK_CACHE = { ts: now, current, latest, newer, error };
  return MODEL_CHECK_CACHE;
}
app.get("/api/model-check", guard, async (req, res) => { res.json(await checkNewerModel()); });
app.get("/api/settings", guard, (req, res) => res.json(Object.assign({}, S(req.tenant), { engines: { claude: !!ANTHROPIC_KEY, gpt: !!process.env.OPENAI_KEY, gemini: !!process.env.GEMINI_KEY }, rules: { chars: rulesCharTotal(req.tenant), count: rulesList(req.tenant).length, budget: ruleBudget(req.tenant), budgets: RULE_BUDGETS } })));
app.post("/api/settings", guard, async (req, res) => {
  const t = req.tenant;
  if (typeof req.body.autoReply === "boolean") S(t).autoReply = req.body.autoReply;
  if (req.body.level === "high" || req.body.level === "medium") S(t).level = req.body.level;
  if (typeof req.body.tone === "string") S(t).tone = req.body.tone.slice(0, 1500);
  if (req.body.autoDelayMin != null && isFinite(Number(req.body.autoDelayMin))) S(t).autoDelayMin = Math.min(60, Math.max(0, Math.round(Number(req.body.autoDelayMin))));
  if (["claude", "gpt", "gemini"].includes(req.body.engine)) S(t).engine = req.body.engine;
  try { await saveTenantConfig(t); } catch (e) {}
  res.json(Object.assign({}, S(t), { engines: { claude: !!ANTHROPIC_KEY, gpt: !!process.env.OPENAI_KEY, gemini: !!process.env.GEMINI_KEY } }));
});
app.post("/api/done", guard, (req, res) => { const t = req.tenant; const c = t.store[req.body.id]; if (!c) return res.status(404).json({ error: "no" }); cancelAutoReply(t, c.id); c.status = "done"; c.flag = false; dbSave(t, c); res.json({ ok: true }); });
app.post("/api/done-all", guard, (req, res) => { const t = req.tenant; let count = 0; Object.values(t.store).forEach(c => { if (c.status !== "done" || c.flag) { cancelAutoReply(t, c.id); c.status = "done"; c.flag = false; dbSave(t, c); count++; } }); res.json({ ok: true, count }); });
app.post("/api/tag", guard, (req, res) => { const t = req.tenant; const c = t.store[req.body.id]; if (!c) return res.status(404).json({ error: "no" }); c.flag = !c.flag; if (c.flag) { c.order = Math.max(0, ...Object.values(t.store).filter(x => x.flag).map(x => x.order || 0)) + 1; c.status = "todo"; } dbSave(t, c); res.json({ ok: true, flag: c.flag }); });

app.post("/api/example-delete", guard, (req, res) => { const t = req.tenant; const id = Number(req.body.id); if (t.examples && t.examples[id]) { delete t.examples[id]; if (pool) pool.query("DELETE FROM examples WHERE tenant=$1 AND id=$2", [t.slug, id]).catch(() => {}); } res.json({ ok: true }); });
app.post("/api/pref-add", guard, (req, res) => { const t = req.tenant; const text = String(req.body.text || "").trim().slice(0, 200); if (!text) return res.json({ ok: false }); const cur = (Array.isArray(S(t).prefs)) ? S(t).prefs : (S(t).prefs = []); if (!cur.some(p => (typeof p === "string" ? p : p.text) === text)) { cur.push({ id: Date.now(), text }); while (cur.length > 40) cur.shift(); saveTenantConfig(t).catch(() => {}); } res.json({ ok: true, prefs: S(t).prefs }); });
app.post("/api/pref-delete", guard, (req, res) => { const t = req.tenant; const id = req.body.id; const cur = Array.isArray(S(t).prefs) ? S(t).prefs : []; S(t).prefs = cur.filter(p => String(p && p.id) !== String(id)); saveTenantConfig(t).catch(() => {}); res.json({ ok: true, prefs: S(t).prefs }); });
app.post("/api/redraft", guard, async (req, res) => {
  const t = req.tenant; const c = t.store[req.body.id]; if (!c) return res.status(404).json({ error: "no" });
  const sel = Array.isArray(req.body.selected) ? req.body.selected.map(String).slice(0, 20) : [];
  const g = await genDraft(t, c, { only: sel });
  if (!g) return res.json({ ok: false });
  c.draft = String(g.draft || ""); c.draft0 = c.draft; if (Array.isArray(g.topics)) c.topics = g.topics; dbSave(t, c);
  res.json({ ok: true, draft: c.draft, topics: c.topics || [] });
});
app.post("/api/ai-regen", guard, async (req, res) => {
  const t = req.tenant;
  const idea = (req.body.idea || "").trim();
  if (!ANTHROPIC_KEY && !process.env.OPENAI_KEY && !process.env.GEMINI_KEY) return res.json({ ok: false, error: "no_ai_key" });
  if (!idea) return res.json({ ok: false, error: "empty" });
  const c = t.store[req.body.id] || null;
  const channel = c ? c.channel : (req.body.channel || "line");
  const lastQ = c ? (c.msgs.filter(m => m.from === "them").slice(-1).map(m => m.text || "").join("")) : "";
  const rel = rulesRanked(t, (lastQ + " " + idea).slice(0, 1000));
  const rulesTxt = rel.length ? rulesBlock(rel, ruleBudget(t)) : "";
  const sig = channel === "mail" ? "メールなので本文の最後に「" + (t.name || "クリニック") + " サポート」と署名を付ける。" : "LINEなので署名は付けない。";
  // build the real conversation as alternating turns (much better context understanding)
  const msgsArr = [];
  if (c) {
    let cur = null;
    c.msgs.slice(-16).forEach(m => {
      const role = m.from === "them" ? "user" : "assistant";
      const tx = (m.text || (m.media ? "［" + m.media + "を送信］" : "")).trim();
      if (!tx) return;
      if (cur && cur.role === role) { cur.content = (cur.content + "\n" + tx).slice(0, 3000); }
      else { cur = { role, content: tx.slice(0, 3000) }; msgsArr.push(cur); }
    });
    while (msgsArr.length && msgsArr[0].role === "assistant") msgsArr.shift();
  }
  msgsArr.push({ role: "user", content: "【スタッフからクリニックAIへの内部指示（お客様には見えません）】\nここまでの会話の流れ全体を正確に踏まえて、お客様の最新のメッセージへの返信文を作成してください。\n返信の方向性メモ: " + idea + "\nメモが『あってる』『大丈夫』のように短くても、会話の文脈に当てはめて意味を解釈し、お客様の話題に具体的に触れて答えること。すでに会話で伝えた内容は繰り返さないこと。返信文のみを出力すること。" });
  const today = new Date().toLocaleDateString("ja-JP", { year: "numeric", month: "long", day: "numeric", weekday: "short" });
  const sys = "あなたは「" + (t.name || "クリニック") + "」の受付スタッフとして、お客様とこの会話をしてきた本人です。一流ホテルのコンシェルジュのように、上質で温かく、品のある丁寧な言葉遣いでお客様に対応します。"
    + "会話の最後に入るスタッフの内部指示メモに沿って、会話の続きとして自然につながる返信を書いてください。"
    + "本日は" + today + "です。キャンセル料など日付が関わる案内では、本日の日付と予約日の差から判断すること（例: 予約日の前日にあたる連絡なら前日扱い、当日なら当日扱い、それより前なら通常はキャンセル料は不要）。憶測で日付を決めない。"
    + "お客様が複数の質問・依頼をしている場合は、その全てにもれなく答えること。1つも取りこぼさない。"
    + "お客様への敬意と心配りが自然に伝わる表現を選び、ご不便にはお詫びや労いの一言を添える。ただし慇懃無礼にならず、簡潔さと読みやすさも保つ。絵文字は使わない。断定や医療判断は避ける。" + sig
    + (rulesTxt ? "\n【店舗ルール（従うこと）】\n" + rulesTxt : "")
    + (S(t).tone && S(t).tone.trim() ? "\n【トーン指示（最優先）】" + S(t).tone.trim().slice(0, 1000) : "")
    + "\n" + JP_QUALITY
    + "\n出力はそのままお客様に送信される。だからお客様に送る返信文だけを出力すること。【】付きの見出し、状況の説明、会話の引用、区切り線(---)、前置き、かぎ括弧は一切含めてはいけない。1文字目から返信本文で始めること。";
  try {
    let text = await aiChat(t, sys, msgsArr, 3000); // 選択中エンジン（既定Gemini）で生成
    if (!text) { return res.json({ ok: false, error: "ai_error" }); }
    // safety: strip any echoed meta sections (headers / separators) the model might add
    if (/\n-{3,}\n?/.test(text)) text = text.split(/\n-{3,}\n?/).pop();
    const lines = text.split("\n");
    while (lines.length > 1 && (/^【.*】/.test(lines[0].trim()) || /^（.*）$/.test(lines[0].trim()) || lines[0].trim() === "")) lines.shift();
    text = lines.join("\n").trim();
    res.json({ ok: true, text });
  } catch (e) { res.json({ ok: false, error: String(e.message || e).slice(0, 80) }); }
});

// AIで作り直す（会話型）: 下書きをスタッフと会話しながら磨き上げる
app.post("/api/draft-chat", guard, async (req, res) => {
  const t = req.tenant;
  if (!ANTHROPIC_KEY && !process.env.OPENAI_KEY && !process.env.GEMINI_KEY) return res.json({ ok: false, error: "no_ai_key" });
  const c = t.store[req.body.id] || null;
  if (!c) return res.json({ ok: false, error: "no_conv" });
  const edits = (Array.isArray(req.body.messages) ? req.body.messages : []).slice(-14)
    .filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .map(m => ({ role: m.role, content: m.content.slice(0, 4000) }));
  while (edits.length && edits[0].role === "assistant") {
    edits[0] = { role: "user", content: "【現在の下書き（あなたが既に作成済み）】\n" + edits[0].content };
    if (edits[1] && edits[1].role === "user") { edits[0].content += "\n\n" + edits[1].content; edits.splice(1, 1); }
    break;
  }
  if (!edits.length || edits[edits.length - 1].role !== "user") return res.json({ ok: false, error: "empty" });
  const conv = c.msgs.slice(-20).map(m => (m.from === "them" ? "お客様" : "クリニック") + ": " + (m.text || (m.media ? "［" + m.media + "］" : ""))).join("\n").slice(0, 6000);
  const lastQ = c.msgs.filter(m => m.from === "them").slice(-1).map(m => m.text || "").join("");
  const editTxt = edits.map(e => e.content).join(" ");
  const rel = rulesRanked(t, (lastQ + " " + editTxt).slice(0, 1500));
  const rulesTxt = rel.length ? rulesBlock(rel, ruleBudget(t)) : "";
  const today = new Date().toLocaleDateString("ja-JP", { year: "numeric", month: "long", day: "numeric", weekday: "short" });
  const sig = c.channel === "mail" ? "メールなので下書きの最後に改行して「" + (t.name || "クリニック") + " サポート」と署名を付ける。" : "LINEなので署名は付けない。";
  const sys = "あなたは「" + (t.name || "クリニック") + "」の受付スタッフの返信作成アシスタントです。"
    + "スタッフと会話しながら、お客様への返信下書きを一緒に磨き上げます。あなたと会話しているのはスタッフで、下書きを送る相手はお客様です。"
    + "\n\n【お客様との会話履歴（この最新メッセージへの返信を作っている。必ず全体を読み込み、文脈を正確に踏まえること）】\n" + conv
    + "\n\n本日は" + today + "です。キャンセル料など日付が関わる案内は、本日と予約日の差から判断する。憶測で日付を決めない。"
    + "医療判断・診断はしない。断定的表現や絵文字は使わない。" + sig
    + (rulesTxt ? "\n\n【店舗ルール（料金・規定・対応可否はここに従い、推測で答えない）】\n" + rulesTxt : "")
    + (S(t).tone && S(t).tone.trim() ? "\n\n【トーン指示】\n" + S(t).tone.trim().slice(0, 1000) : "")
    + (prefsBlock(t) ? "\n\n【スタッフが記憶させた指示（全返信で必ず守る）】\n" + prefsBlock(t) : "")
    + "\n\n" + JP_QUALITY
    + "\n\nスタッフの指示がどんなに短くても（「あってる」「もっと短く」「優しく」等）、お客様との会話の文脈に当てはめて意味を解釈すること。"
    + "\n\n【書き方の最重要方針】優秀な受付スタッフが書くような、自然で読みやすく簡潔な返信にする。前の下書きの言い回しを無理に引き継がず、毎回“まっさらから一気に書き直す”つもりで、最も自然な完成形を作る（継ぎはぎ・冗長な説明の積み重ねを避ける）。お客様が聞いていないことや形式的な前置き・保険表現を詰め込みすぎず、要点に絞る（店舗ルールで必須の情報がある時だけ補う）。一息で読める自然な流れにする。"
    + "毎回、返信下書きの完成形の全文をdraftに入れる。replyにはスタッフへの短い一言（何をどう変えたか、1〜2文。敬語でなくてよい）。"
    + "出力は必ず次のJSONのみ: {\"reply\":\"スタッフへの一言\",\"draft\":\"お客様への返信下書き全文\",\"memory\":\"\"}"
    + "\nmemory: スタッフの指示の中に『他の返信でも再利用できる、書き方・対応の方針』が含まれていれば、簡潔なルール文にして入れる。『今後』『常に』と明示していなくても、再利用できる方針なら拾う（例:「冒頭に様を付けない」「短めにする」「絵文字を使わない」「結論から書く」「予約はWeb予約に誘導する」「謝罪を一言入れる」等）。"
    + "ただし次は絶対にmemoryに入れない（空文字にする）: (1)その問い合わせ固有の事実・数値・個別判断（例:「この件は3営業日」「今回はキャンセル無料」「この人には◯◯と伝える」）。 (2)『今は』『今回は』『一旦』『今だけ』『この返信は』『とりあえず』など“今回限り・一時的”を少しでも示す指示（例:「補償制度の件は今は書かなくていい」→ 今回だけの指示なので記憶しない）。スタッフが今回だけのつもりで言った可能性が少しでもあれば入れない。明確に毎回・恒久的に守るべき方針だと確信できる時だけ入れる。"
    + "複数あれば最も方針性が高い1つだけ。再利用できる恒久方針が無ければ空文字。";
  try {
    const raw = await aiChat(t, sys, edits, 4000);
    if (!raw) return res.json({ ok: false, error: "ai_failed" });
    let out = { reply: "", draft: "" };
    try { const m = raw.match(/\{[\s\S]*\}/); out = JSON.parse(m ? m[0] : raw); } catch (e) { out = { reply: "", draft: salvageDraft(raw) }; }
    let savedMem = "";
    const memTxt = String(out.memory || "").trim().slice(0, 200);
    if (memTxt) {
      const cur = (S(t).prefs && Array.isArray(S(t).prefs)) ? S(t).prefs : (S(t).prefs = []);
      if (!cur.some(p => (typeof p === "string" ? p : p.text) === memTxt)) {
        cur.push({ id: Date.now(), text: memTxt }); while (cur.length > 40) cur.shift();
        saveTenantConfig(t).catch(() => {}); savedMem = memTxt;
      }
    }
    const engLabel = (S(t).engine === "gpt" && process.env.OPENAI_KEY) ? "GPT" : (S(t).engine === "gemini" && process.env.GEMINI_KEY) ? "Gemini" : (ANTHROPIC_KEY ? "Claude(保険)" : "AI");
    res.json({ ok: true, reply: String(out.reply || "").slice(0, 600) + " 〔" + engLabel + "で作成〕", draft: String(out.draft || "").slice(0, 4000), memory: savedMem });
  } catch (e) { res.json({ ok: false, error: String(e.message || e).slice(0, 80) }); }
});

// ---- staff file uploads (PDF, images etc. to send to customers) ----
const FILES = {}; // id -> {tenant, name, mime, data(Buffer)} cache
app.post("/api/upload", guard, async (req, res) => {
  const t = req.tenant;
  const name = String(req.body.name || "file").slice(0, 200);
  const mime = String(req.body.mime || "application/octet-stream").slice(0, 100);
  let buf; try { buf = Buffer.from(String(req.body.data || ""), "base64"); } catch (e) { return res.status(400).json({ error: "bad data" }); }
  if (!buf || !buf.length) return res.status(400).json({ error: "empty" });
  if (buf.length > 10 * 1024 * 1024) return res.status(400).json({ error: "too_large" });
  const id = crypto.randomBytes(16).toString("hex");
  FILES[id] = { tenant: t.slug, name, mime, data: buf };
  if (pool) { try { await pool.query("INSERT INTO files (id,tenant,name,mime,data,ts) VALUES ($1,$2,$3,$4,$5,$6)", [id, t.slug, name, mime, buf, Date.now()]); } catch (e) {} }
  res.json({ ok: true, fileId: id });
});
// 公開URL（LINEの画像送信等はセッション無しで取得する）。idは128bitランダム。
// ログイン中のテナントが他テナントのファイルidを開いた場合は404（tenant check）
app.get("/files/:id", async (req, res) => {
  const id = String(req.params.id || "").replace(/[^0-9a-f]/g, "");
  let f = FILES[id];
  if (!f && pool) { try { const r = await pool.query("SELECT tenant,name,mime,data FROM files WHERE id=$1", [id]); if (r.rows[0]) f = FILES[id] = { tenant: r.rows[0].tenant, name: r.rows[0].name, mime: r.rows[0].mime, data: r.rows[0].data }; } catch (e) {} }
  if (!f) return res.status(404).end();
  const t = tenantFromReq(req);
  if (t && f.tenant && f.tenant !== t.slug) return res.status(404).end();
  res.set("Content-Type", f.mime);
  res.set("Content-Disposition", "inline; filename*=UTF-8''" + encodeURIComponent(f.name));
  res.set("Cache-Control", "public, max-age=604800");
  res.send(f.data);
});
app.post("/api/send-file", guard, async (req, res) => {
  const t = req.tenant;
  const c = t.store[req.body.id]; if (!c) return res.status(404).json({ error: "no" });
  const fid = String(req.body.fileId || "").replace(/[^0-9a-f]/g, "");
  let f = FILES[fid];
  if (!f && pool) { try { const r = await pool.query("SELECT tenant,name,mime,data FROM files WHERE id=$1 AND tenant=$2", [fid, t.slug]); if (r.rows[0]) f = FILES[fid] = { tenant: r.rows[0].tenant, name: r.rows[0].name, mime: r.rows[0].mime, data: r.rows[0].data }; } catch (e) {} }
  if (!f || (f.tenant && f.tenant !== t.slug)) return res.status(404).json({ error: "no_file" });
  const base = "https://" + (req.headers["x-forwarded-host"] || req.headers.host);
  const url = base + "/files/" + fid;
  const isImg = /^image\//.test(f.mime);
  let sent = false, sendErr = null;
  const to = c.userId || (c.id.split(":")[1] || "");
  if (c.channel === "line" && C.lineToken(t) && to) {
    try {
      const msg = isImg ? { type: "image", originalContentUrl: url, previewImageUrl: url } : { type: "text", text: "資料をお送りいたします。下記よりご覧ください。\n📄 " + f.name + "\n" + url };
      const resp = await fetch("https://api.line.me/v2/bot/message/push", { method: "POST", headers: { "Content-Type": "application/json", "Authorization": "Bearer " + C.lineToken(t) }, body: JSON.stringify({ to, messages: [msg] }) });
      sent = resp.ok; if (!resp.ok) sendErr = "LINE_" + resp.status;
    } catch (e) { sendErr = String(e.message || e).slice(0, 80); }
  } else if (c.channel === "mail" && C.smtpUser(t) && C.smtpPass(t) && to) {
    try {
      const nodemailer = require("nodemailer");
      const tp = nodemailer.createTransport({ host: C.smtpHost(t), port: C.smtpPort(t), secure: C.smtpPort(t) === 465, auth: { user: C.smtpUser(t), pass: C.smtpPass(t) } });
      const subj = c.subject ? (/^re:/i.test(c.subject) ? c.subject : "Re: " + c.subject) : "資料のご送付（" + (t.name || "クリニック") + "）";
      await tp.sendMail({ from: (t.name || "クリニック") + " <" + C.smtpUser(t) + ">", to, subject: subj, text: "資料をお送りいたします。添付ファイルをご確認ください。", attachments: [{ filename: f.name, content: f.data }] });
      sent = true;
    } catch (e) { sendErr = String(e.message || e).slice(0, 100); }
  } else { sendErr = "no_send_config"; }
  if (sent) {
    c.msgs.push(isImg ? { from: "us", media: "image", url: url, time: nowt() } : { from: "us", media: "file", url: url, fileName: f.name, time: nowt() });
    c.time = nowt(); c.ts = Date.now(); c.last = (isImg ? "［画像］" : "［ファイル］" + f.name); dbSave(t, c);
  }
  res.json({ ok: true, sent, sendErr });
});

// ---- site alerts (現場ボード) ----
async function alertAdd(t, type, summary, name) {
  let id = t.alertSeq++;
  if (pool) { try { const r = await pool.query("INSERT INTO alerts (tenant,type,summary,name,ts,done) VALUES ($1,$2,$3,$4,$5,false) RETURNING id", [t.slug, type, summary, name, Date.now()]); id = r.rows[0].id; if (id >= t.alertSeq) t.alertSeq = id + 1; } catch (e) {} }
  t.alerts.unshift({ id, type, summary, name, ts: Date.now(), done: false });
  t.alerts = t.alerts.slice(0, 200);
  try { notifyAll(t, "🏥 " + type, (name ? name + "様: " : "") + String(summary || "").slice(0, 80)); } catch (e) {}
  return id;
}
app.get("/api/alerts", guard, (req, res) => res.json(req.tenant.alerts.filter(a => !a.done).slice(0, 100)));
app.post("/api/alert-done", guard, async (req, res) => {
  const t = req.tenant;
  const a = t.alerts.find(x => x.id === Number(req.body.id)); if (!a) return res.status(404).json({ error: "no" });
  a.done = true;
  if (pool) { try { await pool.query("UPDATE alerts SET done=true WHERE id=$1 AND tenant=$2", [a.id, t.slug]); } catch (e) {} }
  res.json({ ok: true });
});
app.post("/api/share", guard, async (req, res) => {
  const t = req.tenant;
  const c = t.store[req.body.id]; if (!c) return res.status(404).json({ error: "no" });
  const note = String(req.body.note || "").slice(0, 300);
  const lastThem = c.msgs.filter(m => m.from === "them").slice(-1).map(m => m.text || (m.media ? "[" + m.media + "]" : "")).join("");
  await alertAdd(t, "共有", note || lastThem || "（内容なし）", c.name || "");
  res.json({ ok: true });
});

// ---- push notifications (PWA web push; VAPID鍵は全テナント共有、購読はテナント別) ----
let webpush = null; try { webpush = require("web-push"); } catch (e) { console.error("web-push not installed"); }
let VAPID = null;
async function pushInit() {
  if (!webpush) return;
  if (process.env.VAPID_PUBLIC && process.env.VAPID_PRIVATE) {
    VAPID = { publicKey: process.env.VAPID_PUBLIC, privateKey: process.env.VAPID_PRIVATE };
  } else if (pool) {
    await pool.query("CREATE TABLE IF NOT EXISTS kv (k text primary key, v jsonb)");
    const r = await pool.query("SELECT v FROM kv WHERE k='vapid'");
    if (r.rows[0]) VAPID = r.rows[0].v;
    else { VAPID = webpush.generateVAPIDKeys(); await pool.query("INSERT INTO kv (k,v) VALUES ('vapid',$1)", [VAPID]); }
  } else { VAPID = webpush.generateVAPIDKeys(); }
  webpush.setVapidDetails("mailto:" + (process.env.VAPID_MAILTO || "admin@example.com"), VAPID.publicKey, VAPID.privateKey);
  console.log("push ready");
}
function notifyAll(t, title, body) {
  if (!webpush || !VAPID) return;
  const payload = JSON.stringify({ title: title || "新着メッセージ", body: body || "" });
  Object.values(t.push).forEach(sub => {
    webpush.sendNotification(sub, payload).catch(err => {
      if (err && (err.statusCode === 410 || err.statusCode === 404)) {
        delete t.push[sub.endpoint];
        if (pool) pool.query("DELETE FROM push_subs WHERE endpoint=$1", [sub.endpoint]).catch(() => {});
      }
    });
  });
}
app.get("/api/push-key", guard, (req, res) => res.json({ key: VAPID ? VAPID.publicKey : null }));
app.post("/api/subscribe", guard, async (req, res) => {
  const t = req.tenant;
  const sub = req.body.sub; if (!sub || !sub.endpoint) return res.status(400).json({ error: "bad" });
  t.push[sub.endpoint] = sub;
  if (pool) { try { await pool.query("INSERT INTO push_subs (tenant,endpoint,sub) VALUES ($1,$2,$3) ON CONFLICT (endpoint) DO UPDATE SET sub=EXCLUDED.sub, tenant=EXCLUDED.tenant", [t.slug, sub.endpoint, sub]); } catch (e) {} }
  res.json({ ok: true });
});
const ICON_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAMAAAADACAYAAABS3GwHAAAER0lEQVR4nO3cPW7baBSG0c+DwFNOky4b8UacHcyqsgNvxNnIdNNM6cpTEREUiaQkkt8l33PKBAEE8j66F/l7en5//WwQ6o/eHwB6EgDRBEA0ARBNAEQTANEEQDQBEE0ARBMA0QRANAEQTQBEEwDRBEA0ARBNAEQTANEEQDQBEE0ARBMA0QRANAEQTQBEEwDRBEA0ARBNAEQTANEEQDQBEE0ARBMA0QRANAEQTQBEEwDRBEA0ARBNAEQTANEEQDQBEE0ARBMA0QRANAEQTQBEEwDRBEA0ARBNAEQTANEEQLQvvT/ALT5e3np/BGb68+f33h9hlqfn99fP3h9iisHfr+ohlD+BDP++VX9/pQOo/vCYp/J7LHsCXXto/7b/Nv4k3Opr++vij1c8h0pugLFvjGsPlxrG3k/FTVD+d4HGvjX+efmx4SdhzLeff1/9uYqDPyi3Ac4f1tjDG3vobOeW4a8WQ7kALvl4ebv64ETQ17XnP/bOKil/Ap36eHm7eBINL8FJtJ29njzndrEBTjmJ+jvK8Le2sw0wGB6ybbCtIw3+YHcb4JRtsJ0jDn9rOw+gNRFs4ajD39pOT6BzTqJ1HHnwB7vfAKdsg+UkDH9rBwugNREsIWX4WzvICXTOSXSfpMEfHG4DnLIN5ksc/tYOugFOXfvT49Zsg9amvwiOPPytHXwDDKb+XkrqNpj61j/68LcWEsBABL+knjznDn8CnUs/idJPnnNRG2CQehI5eX4XGcAgKQInz2VxJ9C5o59ETp5x0RtgcNSTyMkzTQAnjhSBk2ee+BPo3N5PIifPbWyAC/Z6Ejl5bmcDjNjLNvCtfz8bYMLU8PTeBob/MQKYoepJ5OR5nBPoBlVOIt/6y7EBbtT7JDL8yxLAHXqdRE6e5TmBHrDVSeRbfz02wIPWPokM/7psgAWM/SP81u7bBgZ/GzbAgpbaBoZ/OwJY2KMRGP5tOYFWcM9JZPD7sAFWNHcbGP5+BLCyR08iw78uJ9AGpk6isV/DumyADc0dasO/HQFsbGq4Df+2nEAdXDqJDH4fNkBHw9Ab/n4E0Jnh70sARBMA0QRANAEQTQBEEwDRBEA0ARBNAEQTANEEQDQBEE0ARBMA0QRANAEQTQBEEwDRBEA0ARBNAEQTANEEQDQBEK1cALf8D8rsT7X3Wy4A2FLJAKp9S7CMiu+1ZACt1XxY3K/q+ywbQGt1Hxq3qfweSwfQWu2Hx7Tq7+/p+f31s/eHmMt/Jb4f1Qd/sKsAYGnlTyBYkwCIJgCiCYBoAiCaAIgmAKIJgGgCIJoAiCYAogmAaAIgmgCIJgCiCYBoAiCaAIgmAKIJgGgCIJoAiCYAogmAaAIgmgCIJgCiCYBoAiCaAIgmAKIJgGgCIJoAiCYAogmAaAIgmgCIJgCiCYBoAiCaAIgmAKIJgGgCIJoAiCYAogmAaAIgmgCIJgCiCYBoAiCaAIj2P//Cd56Rfb/VAAAAAElFTkSuQmCC", "base64");
app.get("/icon.png", (req, res) => { res.set("Content-Type", "image/png"); res.set("Cache-Control", "public, max-age=604800"); res.send(ICON_PNG); });
app.get("/manifest.json", (req, res) => res.json({ name: "クリニック受信トレイ", short_name: "受信トレイ", start_url: "/", display: "standalone", background_color: "#f3f4f6", theme_color: "#06c755", icons: [{ src: "/icon.png", sizes: "192x192", type: "image/png" }, { src: "/icon.png", sizes: "512x512", type: "image/png" }] }));
const SW_JS = 'self.addEventListener("push",function(e){var d={};try{d=e.data?e.data.json():{};}catch(err){}e.waitUntil(self.registration.showNotification(d.title||"新着メッセージ",{body:d.body||"",icon:"/icon.png",badge:"/icon.png",data:{url:"/"}}));});self.addEventListener("notificationclick",function(e){e.notification.close();e.waitUntil(clients.matchAll({type:"window",includeUncontrolled:true}).then(function(ws){for(var i=0;i<ws.length;i++){if("focus" in ws[i])return ws[i].focus();}return clients.openWindow("/");}));});';
app.get("/sw.js", (req, res) => { res.set("Content-Type", "application/javascript"); res.set("Cache-Control", "no-store"); res.send(SW_JS); });

// LINE media proxy (photos/videos sent by customers) — そのテナントのLINEトークンで試行
app.get("/api/line-media/:id", guard, async (req, res) => {
  const t = req.tenant;
  const id = String(req.params.id || "").replace(/[^0-9A-Za-z_-]/g, "");
  const accts = lineAccounts(t);
  if (!id || !accts.length) return res.status(404).end();
  try {
    let r = null;
    for (const a of accts) {
      r = await fetch("https://api-data.line.me/v2/bot/message/" + id + "/content", { headers: { "Authorization": "Bearer " + a.token } });
      if (r.ok) break;
    }
    if (!r || !r.ok) return res.status(r ? r.status : 404).end();
    res.set("Content-Type", r.headers.get("content-type") || "application/octet-stream");
    res.set("Cache-Control", "private, max-age=86400");
    const buf = Buffer.from(await r.arrayBuffer());
    res.send(buf);
  } catch (e) { res.status(502).end(); }
});

// bulk import of rules (資料取り込み: server-to-server, secret key + tenant slug 必須). Updates by same title, adds new.
app.post("/api/rules-import", async (req, res) => {
  if ((req.headers["x-key"] || req.body.key) !== INGEST_KEY) return res.status(401).json({ error: "bad key" });
  const t = TEN[String(req.body.tenant || "")];
  if (!t) return res.status(400).json({ error: "tenant" });
  const items = Array.isArray(req.body.rules) ? req.body.rules.slice(0, 100) : [];
  let added = 0, updated = 0;
  for (const it of items) {
    if (!it || typeof it.content !== "string" || !it.content.trim()) continue;
    const title = String(it.title || "ルール").slice(0, 100);
    const content = it.content.slice(0, 2000);
    const existing = rulesList(t).find(r => r.title === title);
    if (existing) { await ruleUpdate(t, existing.id, title, content); updated++; }
    else { await ruleAdd(t, title, content); added++; }
  }
  res.json({ ok: true, added, updated, total: rulesList(t).length });
});

app.get("/api/rules-for-ai", (req, res) => {
  if ((req.headers["x-key"] || req.query.key) !== INGEST_KEY) return res.status(401).json({ error: "bad key" });
  const t = TEN[String(req.query.tenant || "")];
  if (!t) return res.status(400).json({ error: "tenant" });
  const q = String(req.query.q || "").slice(0, 1000);
  const list = rulesSearch(t, q, 40); // 40件以下なら全件、超えたら質問に関連する40件
  let text = list.map(r => "■" + r.title + "\n" + r.content).join("\n\n");
  if (S(t).tone && S(t).tone.trim()) text = "■回答全体のトーン・文体（最優先で従う）\n" + S(t).tone.trim() + "\n\n" + text;
  // conversation history from this app (full log) for the requesting customer
  let history = "";
  const uid = String(req.query.uid || "");
  const ch = String(req.query.channel || "line");
  if (uid) {
    const c = t.store[ch + ":" + uid];
    if (c && c.msgs.length) {
      history = c.msgs.slice(-14).map(m => (m.from === "them" ? "お客様" : "クリニック") + ": " + (m.text || (m.media ? "［" + m.media + "］" : ""))).join("\n").slice(0, 4000);
    }
  }
  res.json({ count: list.length, total: rulesList(t).length, text, history });
});

// みぎうで君: rulebook-editing chat. Server only allows rule add/update/delete — nothing else.
app.post("/api/assistant", guard, async (req, res) => {
  const t = req.tenant;
  if (!process.env.GEMINI_KEY && !ANTHROPIC_KEY && !process.env.OPENAI_KEY) return res.json({ ok: false, error: "no_ai_key" });
  const msgs = (Array.isArray(req.body.messages) ? req.body.messages : []).slice(-12)
    .filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .map(m => ({ role: m.role, content: m.content.slice(0, 4000) }));
  let lead = "";
  while (msgs.length && msgs[0].role === "assistant") { lead += msgs.shift().content + "\n"; }
  if (!msgs.length || msgs[msgs.length - 1].role !== "user") return res.json({ ok: false, error: "empty" });
  const ctx = req.body.context || null;
  let ctxTxt = "";
  if (ctx && typeof ctx === "object") {
    ctxTxt = "\n\n【今回の学習対象（スタッフが送信した返信）】\nお客様の直近メッセージ: " + String(ctx.customer || "").slice(0, 1000)
      + "\nAIの初回下書き: " + String(ctx.draft0 || "").slice(0, 1500)
      + "\nスタッフが実際に送った返信: " + String(ctx.finalText || "").slice(0, 1500)
      + (ctx.instructions ? "\nスタッフが『AIで作り直す』で出した指示（最重要の手がかり。『今後こう答えてほしい』という方針そのもの。ルール案の核にすること）: " + String(ctx.instructions).slice(0, 1500) : "")
      + "\n初回下書きとスタッフの最終返信の差分・会話の流れから「今後どう回答すべきか」を自分で読み取り、最初の返答で要点の短い説明と具体的なルール案（proposals）をすぐ提示すること。スタッフに『どんなルールにしたいか教えて』と聞き返さない。差分がなく学習すべき点が本当に無い場合だけ、その旨を短く伝える。"
      + "\n【例外対応の検知（重要）】提案の前に、今回の対応が全患者向けの一般ルールか、この患者だけの例外対応（特別扱い・イレギュラー・クレーム対応のための特例・規定外の譲歩など）かを必ず判定すること。例外対応に見える場合はルール化を提案せず、『今回は例外対応に見えるため、ルール化はおすすめしません』と理由を添えて伝える。繰り返し起こり得る例外の場合のみ、既存の通常ルールを壊さない条件付きの形（例:『通常は◯◯と案内する。ただし△△の場合のみ□□とする』）で提案する。通常ルール自体を例外に合わせて書き換える提案は絶対にしない。"
      + (ctx.confirmedGeneral ? "\n【スタッフの明示判断】スタッフはこの対応を『今後も標準にする』と選択済み。よって安易に例外却下せず、ルール化を前提に具体案を出すこと。ただし既存ルールと矛盾・重複する場合は新規追加ではなく該当ルールのupdate提案にし、どこがどう変わるかをreplyで必ず明示する（矛盾を黙って上書きしない）。内容が特定の患者にしか当てはまらず一般化が危険な場合のみ、既存ルールを壊さない条件付きの形で提案する。" : "");
  }
  const searchKey = msgs.map(m => m.content).join(" ") + (ctx ? " " + String(ctx.customer || "") + " " + String(ctx.finalText || "") : "");
  const rel = rulesRanked(t, searchKey.slice(0, 2000)); // 全ルール・関連度順（途中で切らない）
  const list = rel.map(r => "[" + r.id + "] " + r.title + ": " + String(r.content||"")).join("\n").slice(0, GEMINI_MAX_CHARS) || "（まだルールはありません）";
  const totalRules = rulesList(t).length;
  const sys = "あなたは「みぎうで君」。クリニック問い合わせ返信システムの『返信ルールブック』編集専用アシスタントです。"
    + "できることはルールの追加・修正・削除の提案と、現在のルール内容の説明だけです。守ること:"
    + "(1) お客様対応・返信の内容・言い回し・今回の返信・接客方針に関する話は、言い方がどんなにラフでも曖昧でも全てルールブック編集の相談として扱い、意図を汲み取って具体的なルール案に翻訳する。完全に無関係な依頼（天気、雑談、コードやシステムの変更など）だけ『ルールブックの編集のみお手伝いできます』と短く返す。"
    + "(2) ユーザーが『今どうなってる？』『現在の料金ルールは？』のように現状を聞いたら、関連するルールの内容（最大5件）をreplyの中にそのまま見せて構わない。ルールブック全体の一括出力だけは禁止。"
    + "(3) ルールにしたい内容が会話から読み取れたら、確認を待たずにすぐproposalsで具体的なルール案を出す。聞き返すのは本当に意図が読み取れない時だけ。proposalsはユーザーの画面で『反映ボタン』付きのカードとして表示され、ユーザーがボタンを押した時だけ登録される仕組みなので、気軽に毎回提案してよい。actionsは常に空配列にする（旧方式・使用禁止）。"
    + "(4) ルール本文は、回答AIがそのまま使える簡潔で具体的な日本語にする。日本語は自然で正しい敬語にする。"
    + "(5) 新しい内容が既存ルールと重複・矛盾する場合は、新規追加ではなく該当ルールの修正(update)のproposalを出し、どのルールとどう違うかをreplyで説明する。"
    + "出力は必ず次のJSONのみで、他のテキストは出さない: {\"reply\":\"ユーザーへの返答\",\"proposals\":[],\"actions\":[]}"
    + " proposalsの形式: 追加={\"op\":\"add\",\"title\":\"短い見出し\",\"content\":\"ルール本文\"} 修正={\"op\":\"update\",\"id\":番号,\"title\":\"...\",\"content\":\"...\"} 削除={\"op\":\"delete\",\"id\":番号}"
    + (lead ? "\n\nあなたは会話の冒頭で既にこう発言済み（ユーザーはこれへの返事をしている）: " + lead.slice(0, 500) : "")
    + "\n\n関連する既存ルール（全" + totalRules + "件中、この会話に関連するもののみ抽出。編集判断用、ユーザーにそのまま見せない）:\n" + list + ctxTxt;
  try {
    const raw = await aiChat(t, sys, msgs, 1500) || ""; // 既定Gemini（失敗時はaiChat内でClaude保険）
    if (!raw) return res.json({ ok: false, error: "ai_error" });
    let out = { reply: "", proposals: [], actions: [] };
    try { const m = raw.match(/\{[\s\S]*\}/); out = JSON.parse(m ? m[0] : raw); } catch (e) { out = { reply: raw.slice(0, 1200), proposals: [], actions: [] }; }
    const proposals = (Array.isArray(out.proposals) ? out.proposals : []).filter(a => a && typeof a === "object" && (a.op === "delete" ? t.rules[a.id] : (typeof a.content === "string" && a.content.trim()))).slice(0, 20)
      .map(a => ({ op: a.op === "update" || a.op === "delete" ? a.op : "add", id: a.id, title: String(a.title || (a.id && t.rules[a.id] ? t.rules[a.id].title : "ルール")).slice(0, 100), content: typeof a.content === "string" ? a.content.slice(0, 2000) : "" }));
    res.json({ ok: true, reply: String(out.reply || "").slice(0, 2000), proposals, applied: [], ruleCount: rulesList(t).length });
  } catch (e) { res.json({ ok: false, error: String(e.message || e).slice(0, 80) }); }
});

// みぎうで君の提案カード→反映ボタンで確定
app.post("/api/rules-apply", guard, async (req, res) => {
  const t = req.tenant;
  const items = Array.isArray(req.body.items) ? req.body.items.slice(0, 60) : [];
  const applied = [];
  for (const a of items) {
    if (!a || typeof a !== "object") continue;
    try {
      if (a.op === "add" && typeof a.content === "string" && a.content.trim()) {
        const title = String(a.title || "ルール").slice(0, 100);
        const dup = rulesList(t).find(r => r.title === title);
        if (dup) { await ruleUpdate(t, dup.id, title, a.content.slice(0, 2000)); applied.push("修正 [" + dup.id + "] " + title); }
        else { const r = await ruleAdd(t, title, a.content.slice(0, 2000)); applied.push("追加 [" + r.id + "] " + r.title); }
      } else if (a.op === "update" && t.rules[a.id]) {
        await ruleUpdate(t, a.id, a.title != null ? String(a.title).slice(0, 100) : null, a.content != null ? String(a.content).slice(0, 2000) : null);
        applied.push("修正 [" + a.id + "] " + t.rules[a.id].title);
      } else if (a.op === "delete" && t.rules[a.id]) {
        const tt = t.rules[a.id].title; await ruleDelete(t, a.id);
        applied.push("削除 [" + a.id + "] " + tt);
      }
    } catch (e) {}
  }
  res.json({ ok: true, applied, ruleCount: rulesList(t).length });
});

// みぎうで君への資料アップロード（画像・PDF・CSV/テキスト）→ ルール案に一括変換
app.post("/api/assistant-file", guard, async (req, res) => {
  const t = req.tenant;
  if (!process.env.GEMINI_KEY && !ANTHROPIC_KEY) return res.json({ ok: false, error: "no_ai_key" });
  const name = String(req.body.name || "file").slice(0, 200);
  const mime = String(req.body.mime || "").toLowerCase();
  const note = String(req.body.note || "").slice(0, 500);
  let buf; try { buf = Buffer.from(String(req.body.data || ""), "base64"); } catch (e) { return res.status(400).json({ error: "bad data" }); }
  if (!buf || !buf.length) return res.json({ ok: false, error: "empty" });
  if (buf.length > 14 * 1024 * 1024) return res.json({ ok: false, error: "too_large" }); // Geminiのinlineリクエスト上限(20MB)に収まる範囲で最大化
  const content = [];      // Claude（フォールバック）用ペイロード
  const geminiParts = [];  // Gemini（優先）用ペイロード
  if (/^image\/(jpeg|png|gif|webp)$/.test(mime)) {
    const b64 = buf.toString("base64");
    content.push({ type: "image", source: { type: "base64", media_type: mime, data: b64 } });
    geminiParts.push({ inlineData: { mimeType: mime, data: b64 } });
  } else if (mime === "application/pdf" || /\.pdf$/i.test(name)) {
    const b64 = buf.toString("base64");
    content.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: b64 } });
    geminiParts.push({ inlineData: { mimeType: "application/pdf", data: b64 } });
  } else {
    const txt = buf.toString("utf8").slice(0, GEMINI_MAX_CHARS); // テキスト/CSVの読み込み上限（Geminiの文脈に収まる最大）
    if (!txt.trim()) return res.json({ ok: false, error: "unsupported" });
    const blk = "【アップロードされた資料（" + name + "）】\n" + txt;
    content.push({ type: "text", text: blk });
    geminiParts.push({ text: blk });
  }
  const instr = "この資料の内容を、クリニック問い合わせ返信AIのルールブックに登録できる形に整理してください。" + (note ? "\nスタッフからの補足: " + note : "");
  content.push({ type: "text", text: instr });
  geminiParts.push({ text: instr });
  const existing = rulesList(t).map(r => "[" + r.id + "] " + r.title).join("\n").slice(0, 100000);
  const fsys = "あなたは「みぎうで君」。クリニック返信ルールブックの編集アシスタントです。渡された資料（価格表・案内文・FAQ・CSVなど）を読み取り、回答AIがそのまま使える簡潔で具体的な日本語ルールに変換します。"
    + "料金表はカテゴリごとに数件のルールにまとめる。数字・金額・条件は資料から正確に転記し、読み取れない部分は省いて勝手に補完しない。"
    + "\n既存ルールの見出し一覧（同じテーマの資料なら新規追加ではなくその番号へのupdateにする）:\n" + (existing || "（まだルールはありません）")
    + "\n出力は必ず次のJSONのみ: {\"reply\":\"資料から読み取った内容の短い要約説明（ユーザー向け）\",\"items\":[{\"op\":\"add\",\"title\":\"見出し\",\"content\":\"ルール本文\"} または {\"op\":\"update\",\"id\":番号,\"title\":\"...\",\"content\":\"...\"}]}";
  try {
    let raw = await geminiGenerate(fsys, geminiParts, 3500) || ""; // 資料読み込みはGemini優先（大容量・低コスト）
    if (!raw && ANTHROPIC_KEY) { // Gemini失敗時のみClaudeにフォールバック
      const resp = await fetch("https://api.anthropic.com/v1/messages", { method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 3500, system: fsys, messages: [{ role: "user", content }] }) });
      if (resp.ok) { const data = await resp.json(); raw = (data.content && data.content[0] && data.content[0].text) || ""; }
    }
    if (!raw) return res.json({ ok: false, error: "ai_error" });
    let out = { reply: "", items: [] };
    try { const m = raw.match(/\{[\s\S]*\}/); out = JSON.parse(m ? m[0] : raw); } catch (e) { out = { reply: raw.slice(0, 800), items: [] }; }
    const proposals = (Array.isArray(out.items) ? out.items : []).filter(a => a && typeof a === "object" && typeof a.content === "string" && a.content.trim()).slice(0, 60)
      .map(a => ({ op: a.op === "update" && t.rules[a.id] ? "update" : "add", id: a.id, title: String(a.title || "ルール").slice(0, 100), content: a.content.slice(0, 2000) }));
    res.json({ ok: true, reply: String(out.reply || "資料を読み取りました。").slice(0, 1500), proposals });
  } catch (e) { res.json({ ok: false, error: String(e.message || e).slice(0, 80) }); }
});

// 管理者用バックアップ: 会話・ルールブック・設定を1つのJSONでダウンロード（テナント別）
app.get("/api/backup", guard, (req, res) => {
  const t = req.tenant;
  const data = {
    app: "clinic-inbox-platform",
    tenant: t.slug,
    name: t.name,
    exportedAt: new Date().toISOString(),
    conversations: Object.values(t.store),
    rules: rulesList(t),
    settings: S(t),
    alerts: t.alerts
  };
  res.set("Content-Type", "application/json; charset=utf-8");
  res.set("Content-Disposition", "attachment; filename=clinic-backup-" + t.slug + "-" + new Date().toISOString().slice(0, 10) + ".json");
  res.send(JSON.stringify(data, null, 1));
});

// ---------- 運営管理は受付くん（SmileMedi Cloud）に統合済み。旧/adminは410 ----------
// PLATFORM_SECRET はパートナーAPIの共有キーとして引き続き使用（変更・削除しないこと）
const ADMIN_SECRET = process.env.PLATFORM_SECRET || "";
app.get("/admin", (req,res)=>{ res.status(410).send("運営管理は受付くん（SmileMedi Cloud）の管理画面に統合されました。"); });

// テナントデータの取り込み（移行用: hatobiyo-inboxの /api/backup 出力をそのまま受け取る）
app.post("/api/partner/import", (req,res,next)=>{ if(partnerOk(req)) return next(); res.status(401).json({error:"auth"}); }, async (req,res)=>{
  const t = TEN[String(req.body.slug||"")]; if(!t) return res.status(404).json({ok:false,error:"no_tenant"});
  const b = req.body.backup || {};
  let convs = 0, rulesN = 0;
  try{
    for(const c of (Array.isArray(b.conversations)?b.conversations:[]).slice(0,2000)){
      if(!c || !c.id) continue;
      t.store[c.id] = c; dbSave(t, c); convs++;
    }
    for(const r of (Array.isArray(b.rules)?b.rules:[]).slice(0,500)){
      if(!r || typeof r.content !== "string" || !r.content.trim()) continue;
      await ruleAdd(t, String(r.title||"ルール").slice(0,100), r.content.slice(0,2000)); rulesN++;
    }
    if(b.settings && typeof b.settings === "object"){
      const s = t.config.settings;
      if(typeof b.settings.autoReply === "boolean") s.autoReply = b.settings.autoReply;
      if(b.settings.level === "high" || b.settings.level === "medium") s.level = b.settings.level;
      if(typeof b.settings.tone === "string") s.tone = b.settings.tone.slice(0,1500);
      if(b.settings.autoDelayMin != null && isFinite(Number(b.settings.autoDelayMin))) s.autoDelayMin = Math.min(60, Math.max(0, Math.round(Number(b.settings.autoDelayMin))));
      await saveTenantConfig(t);
    }
    res.json({ok:true, convs, rules:rulesN, ruleCount:Object.keys(t.rules).length});
  }catch(e){ res.status(500).json({ok:false,error:String(e.message||e).slice(0,80)}); }
});

// 自テナントへの引っ越し（ログイン中のテナント自身が、旧システムのエクスポートURLからデータを取り込む）
app.post("/api/import-own", guard, async (req,res)=>{
  const t = req.tenant;
  const url = String(req.body.url||"");
  if(!/^https:\/\//.test(url)) return res.status(400).json({ok:false,error:"bad_url"});
  let b;
  try{
    const r = await fetch(url);
    if(!r.ok) return res.status(502).json({ok:false,error:"fetch_"+r.status});
    b = await r.json();
  }catch(e){ return res.status(502).json({ok:false,error:"fetch_failed"}); }
  if(!b || !Array.isArray(b.conversations)) return res.status(400).json({ok:false,error:"bad_backup"});
  let convs = 0, rulesN = 0;
  try{
    for(const c of b.conversations.slice(0,2000)){
      if(!c || !c.id) continue;
      t.store[c.id] = c; dbSave(t, c); convs++;
    }
    const existingTitles = new Set(Object.values(t.rules||{}).map(r=>r.title));
    for(const r of (Array.isArray(b.rules)?b.rules:[]).slice(0,500)){
      if(!r || typeof r.content !== "string" || !r.content.trim()) continue;
      if(existingTitles.has(String(r.title||"ルール").slice(0,100))) continue; // 二重実行しても重複しない
      await ruleAdd(t, String(r.title||"ルール").slice(0,100), r.content.slice(0,2000)); rulesN++;
    }
    if(b.settings && typeof b.settings === "object"){
      const s = t.config.settings;
      if(typeof b.settings.autoReply === "boolean") s.autoReply = b.settings.autoReply;
      if(b.settings.level === "high" || b.settings.level === "medium") s.level = b.settings.level;
      if(typeof b.settings.tone === "string") s.tone = b.settings.tone.slice(0,1500);
      if(b.settings.autoDelayMin != null && isFinite(Number(b.settings.autoDelayMin))) s.autoDelayMin = Math.min(60, Math.max(0, Math.round(Number(b.settings.autoDelayMin))));
      if(["claude","gpt","gemini"].includes(b.settings.engine)) s.engine = b.settings.engine;
      await saveTenantConfig(t);
    }
    res.json({ok:true, convs, rules:rulesN, ruleCount:Object.keys(t.rules).length, convoCount:Object.keys(t.store).length});
  }catch(e){ res.status(500).json({ok:false,error:String(e.message||e).slice(0,80)}); }
});

// ---------- パートナーアプリ連携API（受付くん等。鍵: header x-partner-key = PLATFORM_SECRET） ----------
function partnerOk(req){ return !!ADMIN_SECRET && String(req.headers["x-partner-key"]||"") === ADMIN_SECRET; }
function pGuard(req,res,next){ if(partnerOk(req)) return next(); res.status(401).json({error:"auth"}); }
const SSO_TOKENS = {}; // token -> {slug, exp}
const RESET_TOKENS = {}; // パスワード再設定トークン token -> {slug, exp}
const RESET_REQ_AT = {}; // email -> 最終リクエスト時刻(ms)。簡易レート制限
app.get("/api/partner/tenants", pGuard, (req,res)=>{
  res.json(Object.values(TEN).map(t=>({ slug:t.slug, name:t.name,
    convos:Object.keys(t.store||{}).length, rules:Object.keys(t.rules||{}).length,
    line: !!(t.config.conn&&t.config.conn.lineToken), mail: !!(t.config.conn&&t.config.conn.smtpUser),
    suspended: !!t.config.suspended })));
});
app.get("/api/partner/conn", pGuard, (req,res)=>{
  const t = TEN[String(req.query.slug||"")]; if(!t) return res.status(404).json({error:"no_tenant"});
  const cn = t.config.conn || {};
  res.json({ slug:t.slug, name:t.name,
    lineConfigured: !!cn.lineToken, lineBotId: cn.lineBotId||"",
    mailConfigured: !!cn.smtpUser, mailAddress: cn.smtpUser||"",
    extraLines: (cn.lines||[]).map(a=>({name:a.name,botId:a.botId||""})),
    extraMails: (cn.mails||[]).map(a=>({name:a.name,address:a.smtpUser})),
    rules: Object.values(t.rules||{}).map(r=>({id:r.id,title:r.title})).slice(0,200) });
});
// テナント新規作成（受付くん運営画面から。空テナント: LINE/メール未設定・ルール0件・デモなし）
app.post("/api/partner/tenants", pGuard, async (req,res)=>{
  const name = String(req.body.name||"").trim().slice(0,80);
  if(!name) return res.status(400).json({ok:false,error:"name"});
  let slug = String(req.body.slug||"").trim().toLowerCase().replace(/[^a-z0-9-]/g,"").slice(0,30);
  if(slug && TEN[slug]) return res.status(409).json({ok:false,error:"slug_exists"});
  if(!slug){ slug = slugify(name); if(TEN[slug]) return res.status(409).json({ok:false,error:"slug_exists"}); }
  // パスワード未指定ならランダム生成（顧客はSSO経由で入る。後からパスワード設定も可能）
  const pass = String(req.body.password||"") || crypto.randomBytes(12).toString("hex");
  const config = { passHash: sha(pass), conn: {}, settings: { autoReply: false, level: "high", tone: "" } };
  const t = TEN[slug] = newTenant(slug, name, config);
  if(pool){ try{ await pool.query("INSERT INTO tenants (slug,name,config) VALUES ($1,$2,$3)", [slug, name, t.config]); }catch(e){ delete TEN[slug]; return res.status(500).json({ok:false,error:"db"}); } }
  res.status(201).json({ slug, name });
});
// テナント完全削除（解約時）
app.delete("/api/partner/tenants/:slug", pGuard, async (req,res)=>{
  const slug = String(req.params.slug||""); const t = TEN[slug]; if(!t) return res.status(404).json({ok:false});
  try{
    if(pool){
      await pool.query("DELETE FROM convos WHERE tenant=$1",[slug]);
      await pool.query("DELETE FROM rules WHERE tenant=$1",[slug]);
      await pool.query("DELETE FROM alerts WHERE tenant=$1",[slug]);
      await pool.query("DELETE FROM files WHERE tenant=$1",[slug]);
      await pool.query("DELETE FROM push_subs WHERE tenant=$1",[slug]);
      await pool.query("DELETE FROM tenants WHERE slug=$1",[slug]);
    }
    delete TEN[slug];
    res.json({ok:true});
  }catch(e){ res.status(500).json({ok:false,error:String(e.message||e).slice(0,80)}); }
});
// LINE設定（受付くん運営画面から。トークン検証＋botId自動取得）
app.put("/api/partner/line-config", pGuard, async (req,res)=>{
  const t = TEN[String(req.body.slug||"")]; if(!t) return res.status(404).json({ok:false,error:"no_tenant"});
  const conn = t.config.conn = t.config.conn || {};
  if(req.body.clear === true){
    delete conn.lineToken; delete conn.lineSecret; delete conn.lineBotId; delete conn.lineChannelId;
  }else{
    const token = String(req.body.channel_access_token||"").trim();
    const secret = String(req.body.channel_secret||"").trim();
    if(!token || !secret) return res.status(400).json({ok:false,error:"missing"});
    try{
      const r = await fetch("https://api.line.me/v2/bot/info", { headers: { "Authorization": "Bearer " + token } });
      if(!r.ok) return res.status(400).json({ok:false,error:"bad_token"});
      const j = await r.json(); conn.lineBotId = j.userId || "";
    }catch(e){ return res.status(502).json({ok:false,error:"line_api"}); }
    conn.lineToken = token.slice(0,300); conn.lineSecret = secret.slice(0,300);
    if(req.body.channel_id) conn.lineChannelId = String(req.body.channel_id).slice(0,40);
  }
  try{ await saveTenantConfig(t); }catch(e){ return res.status(500).json({ok:false}); }
  res.json({ ok:true, webhook_url: "https://" + (req.headers.host||"") + "/webhook/line" });
});
// メール設定（受付くん運営画面から。設定完了で受信監視も自動オン）
app.put("/api/partner/mail-config", pGuard, async (req,res)=>{
  const t = TEN[String(req.body.slug||"")]; if(!t) return res.status(404).json({ok:false,error:"no_tenant"});
  const conn = t.config.conn = t.config.conn || {};
  if(req.body.clear === true){
    ["smtpHost","smtpPort","smtpUser","smtpPass","imapHost","imapPort","imapUser","imapPass"].forEach(k=>{ delete conn[k]; });
    conn.emailInternal = false;
  }else{
    const b = req.body;
    ["smtpHost","smtpUser","smtpPass","imapHost","imapUser","imapPass"].forEach(k=>{ if(typeof b[k]==="string" && b[k].trim()) conn[k] = b[k].trim().slice(0,300); });
    if(b.smtpPort) conn.smtpPort = +b.smtpPort;
    if(b.imapPort) conn.imapPort = +b.imapPort;
    if(typeof b.emailInternal === "boolean") conn.emailInternal = b.emailInternal;
    else if(conn.smtpUser && conn.smtpPass) conn.emailInternal = true;
  }
  try{ await saveTenantConfig(t); }catch(e){ return res.status(500).json({ok:false}); }
  res.json({ ok:true, mail_address: conn.smtpUser || "" });
});
app.post("/api/partner/suspend", pGuard, async (req,res)=>{
  const t = TEN[String(req.body.slug||"")]; if(!t) return res.status(404).json({ok:false});
  t.config.suspended = !!req.body.on;
  try{ await saveTenantConfig(t); }catch(e){ return res.status(500).json({ok:false}); }
  res.json({ok:true, suspended:t.config.suspended});
});
// SSO: 受付くん側から「右腕くんを開く」ボタン用のワンタイムURLを発行（5分有効・1回限り）
app.post("/api/partner/sso", pGuard, (req,res)=>{
  const t = TEN[String(req.body.slug||"")]; if(!t || t.config.suspended) return res.status(404).json({ok:false});
  const tok = crypto.randomBytes(24).toString("hex");
  SSO_TOKENS[tok] = { slug: t.slug, exp: Date.now() + 5*60000 };
  res.json({ ok:true, url: "https://" + (req.headers.host||"") + "/sso?t=" + tok });
});
// 受付くん管理画面用: ログイン再発行（現パスワード不要）。partner key 必須・新パスワードを平文で1回だけ返す
app.post("/api/partner/reset-login", pGuard, async (req,res)=>{
  const t = TEN[String(req.body.slug||"")];
  if(!t) return res.status(404).json({ ok:false });
  const prevHash = t.config.passHash, prevId = t.config.loginId; // DB保存失敗時のロールバック用
  // 紛らわしい文字(0/O/1/l/I)を除いた12桁の安全な新パスワードを自動生成
  const ab = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const rb = crypto.randomBytes(12); let pw = "";
  for(let i=0;i<12;i++) pw += ab[rb[i] % ab.length];
  t.config.passHash = sha(pw);
  let loginId = t.config.loginId || t.slug;
  if(req.body.resetId === true){
    let cand; do { cand = slugify(t.name || t.slug); } while(loginIdTaken(cand, t.slug));
    t.config.loginId = cand; loginId = cand;
  }
  try { await saveTenantConfig(t); }
  catch(e){ t.config.passHash = prevHash; t.config.loginId = prevId; return res.status(500).json({ ok:false, error:"db" }); }
  console.log("partner reset-login:", t.slug, "resetId=" + (req.body.resetId === true)); // 操作ログ（パスワードは記録しない）
  res.json({ ok:true, loginId, password: pw });
});
// 受付くんのAIアシスタント用: 患者へLINE送信（partner key必須）。line_uid優先、無ければphone/emailで既存LINE会話を解決
app.post("/api/partner/send-line", pGuard, async (req,res)=>{
  const t = TEN[String(req.body.slug||"")];
  if(!t) return res.json({ ok:false, error:"no_tenant" }); // 実装済みルートなのでslug不正は200で返す（404=未実装と混同させない）
  const p = (req.body && typeof req.body.patient === "object" && req.body.patient) || {};
  const text = String(req.body.text||"").trim();
  if(!text) return res.json({ ok:false, error:"empty_text" });
  // 宛先(LINEユーザーID)の解決
  let uid = String(p.line_uid||"").trim();
  let acctKey = null;
  if(uid){
    const c = t.store["line:" + uid];
    if(c && c.acct && c.acct.type === "line") acctKey = c.acct.key;
  } else {
    // line_uidが無い場合、保存済みのLINE会話から phone/email 一致を探す（該当が無ければ解決不可）
    const email = String(p.email||"").trim().toLowerCase();
    const phone = String(p.phone||"").replace(/[^0-9]/g, "");
    const conv = Object.values(t.store).find(c => c.channel === "line" && (
      (email && String(c.email||"").toLowerCase() === email) ||
      (phone && String(c.phone||"").replace(/[^0-9]/g, "") === phone)
    ));
    if(conv){ uid = conv.userId; acctKey = (conv.acct && conv.acct.type === "line") ? conv.acct.key : null; }
  }
  if(!uid) return res.json({ ok:false, error:"no_line_target" });
  // 送信元LINEチャネル: 会話が紐づくチャネル優先、無ければメイン
  const accts = lineAccounts(t);
  const a = (acctKey ? accts.find(x => (x.botId||"main") === acctKey) : null) || accts[0];
  if(!a || !a.token) return res.json({ ok:false, error:"no_line_config" });
  try{
    const resp = await fetch("https://api.line.me/v2/bot/message/push", { method:"POST",
      headers:{ "Content-Type":"application/json", "Authorization":"Bearer " + a.token },
      body: JSON.stringify({ to: uid, messages:[{ type:"text", text }] }) });
    if(!resp.ok) return res.json({ ok:false, error:"line_" + resp.status });
  }catch(e){ return res.json({ ok:false, error:String(e.message||e).slice(0,80) }); }
  // 会話履歴にも残す（既存会話があれば）
  try{
    const c = t.store["line:" + uid];
    if(c){ c.msgs.push({ from:"us", text, time: nowt(), via:"partner" }); c.time = nowt(); c.ts = Date.now(); c.last = lastText(c); dbSave(t, c); }
  }catch(e){}
  console.log("partner send-line:", t.slug, "uid=" + uid.slice(0,8) + "…");
  res.json({ ok:true });
});
app.get("/sso", (req,res)=>{
  const tok = String(req.query.t||"");
  const e = SSO_TOKENS[tok];
  if(e) delete SSO_TOKENS[tok];
  if(!e || Date.now() > e.exp) return res.status(401).send("リンクの有効期限が切れています。もう一度お試しください。");
  const t = TEN[e.slug];
  if(!t || t.config.suspended) return res.status(404).send("not found");
  setSess(res, t);
  res.redirect("/");
});
setInterval(()=>{ const now=Date.now(); for(const k of Object.keys(SSO_TOKENS)) if(SSO_TOKENS[k].exp < now) delete SSO_TOKENS[k]; for(const k of Object.keys(RESET_TOKENS)) if(RESET_TOKENS[k].exp < now) delete RESET_TOKENS[k]; }, 60000);

// ===== パスワードを忘れた方（顧客の自己解決リセット。右腕くん単独で完結） =====
function tenantByEmail(email){
  const e = String(email||"").trim().toLowerCase();
  if(!e || e.indexOf("@") < 0) return null;
  for(const slug of Object.keys(TEN)){
    const t = TEN[slug];
    if(t.config && t.config.suspended) continue;
    if(mailAccounts(t).some(a => String(a.smtpUser||"").toLowerCase() === e)) return t;
  }
  return null;
}
async function sendResetEmail(t, toEmail, link){
  const a = mailAccounts(t).find(x => String(x.smtpUser||"").toLowerCase() === String(toEmail||"").toLowerCase()) || mailAccounts(t)[0];
  if(!a) return false;
  try{
    const nodemailer = require("nodemailer");
    const tp = nodemailer.createTransport({ host:a.smtpHost, port:a.smtpPort, secure:a.smtpPort===465, auth:{user:a.smtpUser, pass:a.smtpPass} });
    await tp.sendMail({
      from: (t.name || "受信トレイ") + " <" + a.smtpUser + ">",
      to: toEmail,
      subject: "【受信トレイ】パスワード再設定のご案内",
      text: "受信トレイのパスワード再設定リクエストを受け付けました。\n下記リンクから新しいパスワードを設定してください（1時間有効・1回のみ）。\n\n" + link + "\n\nお心当たりが無い場合はこのメールを破棄してください。"
    });
    return true;
  }catch(e){ console.error("reset-mail:", e.message); return false; }
}
app.get("/forgot", (req,res)=>{ res.set("Content-Type","text/html; charset=utf-8"); res.set("Cache-Control","no-store"); res.send(FORGOT_PAGE); });
app.post("/api/forgot", async (req,res)=>{
  const email = String(req.body.email||"").trim().toLowerCase();
  try{
    const now = Date.now();
    if(email && email.indexOf("@")>0 && !(RESET_REQ_AT[email] && now - RESET_REQ_AT[email] < 60000)){
      RESET_REQ_AT[email] = now;
      const t = tenantByEmail(email);
      if(t){
        const tok = crypto.randomBytes(24).toString("hex");
        RESET_TOKENS[tok] = { slug: t.slug, exp: now + 60*60000 }; // 1時間有効
        const link = "https://" + (req.headers.host||"") + "/reset?token=" + tok;
        await sendResetEmail(t, email, link);
      }
    }
  }catch(e){ console.error("forgot:", e.message); }
  res.json({ ok:true }); // 列挙対策: 登録有無に関わらず常に成功扱い
});
app.get("/reset", (req,res)=>{
  res.set("Content-Type","text/html; charset=utf-8"); res.set("Cache-Control","no-store");
  const e = RESET_TOKENS[String(req.query.token||"")];
  if(!e || Date.now() > e.exp) return res.send(RESET_INVALID_PAGE);
  res.send(RESET_PAGE(String(req.query.token||"")));
});
app.post("/api/reset", async (req,res)=>{
  const tok = String(req.body.token||"");
  const password = String(req.body.password||"");
  const e = RESET_TOKENS[tok];
  if(!e || Date.now() > e.exp){ if(e) delete RESET_TOKENS[tok]; return res.status(400).json({ ok:false, error:"expired" }); }
  if(password.length < 8) return res.status(400).json({ ok:false, error:"too_short" });
  const t = TEN[e.slug];
  if(!t){ delete RESET_TOKENS[tok]; return res.status(404).json({ ok:false }); }
  const prev = t.config.passHash;
  t.config.passHash = sha(password);
  try{ await saveTenantConfig(t); }
  catch(err){ t.config.passHash = prev; return res.status(500).json({ ok:false, error:"db" }); }
  delete RESET_TOKENS[tok]; // 1回限り
  console.log("self password reset:", t.slug);
  res.json({ ok:true });
});

app.get("/", (req, res) => { res.set("Content-Type", "text/html; charset=utf-8"); res.set("Cache-Control", "no-store"); res.send(tenantFromReq(req) ? PAGE : LOGIN_PAGE); });
app.get("/signup", (req, res) => res.redirect("/")); // 申込みは営業契約後に運営が作成
app.get("/board", (req, res) => { res.set("Content-Type", "text/html; charset=utf-8"); res.set("Cache-Control", "no-store"); res.send(tenantFromReq(req) ? BOARD_PAGE : LOGIN_PAGE); });
(async () => {
  try { if (pool) await dbInit(); } catch (e) { console.error("dbInit failed:", e.message); }
  try { await pushInit(); } catch (e) { console.error("pushInit failed:", e.message); }
  setInterval(() => { pollAll().catch(() => {}); }, 60000); setTimeout(() => { pollAll().catch(() => {}); }, 8000);
  setTimeout(() => { Object.values(TEN).forEach(t => ensureLineBotId(t).catch(() => {})); }, 3000);
  const server = app.listen(PORT, () => console.log("clinic-inbox platform listening on " + PORT));
  // Railwayの前段プロキシよりNodeが先にkeep-alive接続を切ると、切断直後のPOST(LINE Webhook等)が
  // 499/接続リセットで稀に失敗する。プロキシのアイドル時間より長くして競合をなくす。
  server.keepAliveTimeout = 120000; // 120秒
  server.headersTimeout = 125000;   // keepAliveTimeoutより長く必須
})();

const LOGIN_PAGE = `<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>ログイン</title></head>
<body style="font-family:-apple-system,'Hiragino Kaku Gothic ProN',sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f3f4f6;">
<div style="background:#fff;padding:28px 24px;border-radius:14px;width:min(90vw,320px);box-shadow:0 2px 14px rgba(0,0,0,.08);">
<div style="font-size:18px;font-weight:600;margin-bottom:4px;">📥 受信トレイ</div>
<div style="font-size:13px;color:#6b7280;margin-bottom:18px;">ログイン</div>
<input id="lid" placeholder="ログインID" autocapitalize="off" autofocus style="width:100%;box-sizing:border-box;padding:11px;border:1px solid #d1d5db;border-radius:8px;font-size:15px;margin-bottom:10px;">
<input id="p" type="password" placeholder="パスワード" style="width:100%;box-sizing:border-box;padding:11px;border:1px solid #d1d5db;border-radius:8px;font-size:15px;margin-bottom:10px;" onkeydown="if(event.key==='Enter'&&!event.isComposing&&event.keyCode!==229)go()">
<button onclick="go()" style="width:100%;padding:11px;border:none;border-radius:8px;background:#06c755;color:#fff;font-size:15px;font-weight:600;cursor:pointer;">ログイン</button>
<div id="e" style="color:#dc2626;font-size:12px;margin-top:8px;min-height:14px;"></div>
<div style="text-align:center;margin-top:6px;font-size:11px;color:#9ca3af;">ご利用開始をご希望の方は運営までお問い合わせください</div>
<div style="text-align:center;margin-top:10px;font-size:12px;"><a href="/forgot" style="color:#06c755;text-decoration:none;">パスワードを忘れた方</a></div>
<div style="text-align:center;margin-top:6px;font-size:11px;color:#9ca3af;">ログインIDが不明な場合は運営にお問い合わせください</div></div>
<script>async function go(){const loginId=document.getElementById("lid").value.trim();const password=document.getElementById("p").value;if(!loginId){document.getElementById("e").textContent="ログインIDを入力してください";return;}const r=await fetch("/api/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({loginId,password})});if(r.ok){location.reload();}else{document.getElementById("e").textContent="ログインIDかパスワードが違います";document.getElementById("p").value="";}}</script>
</body></html>`;

const FORGOT_PAGE = `<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>パスワード再設定</title></head>
<body style="font-family:-apple-system,'Hiragino Kaku Gothic ProN',sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f3f4f6;">
<div style="background:#fff;padding:28px 24px;border-radius:14px;width:min(90vw,340px);box-shadow:0 2px 14px rgba(0,0,0,.08);">
<div style="font-size:17px;font-weight:600;margin-bottom:4px;">🔑 パスワード再設定</div>
<div style="font-size:13px;color:#6b7280;margin-bottom:16px;">登録メールアドレスに再設定リンクをお送りします。</div>
<input id="em" type="email" placeholder="登録メールアドレス" autocapitalize="off" autofocus style="width:100%;box-sizing:border-box;padding:11px;border:1px solid #d1d5db;border-radius:8px;font-size:15px;margin-bottom:10px;" onkeydown="if(event.key==='Enter'&&!event.isComposing&&event.keyCode!==229)send()">
<button onclick="send()" id="sb" style="width:100%;padding:11px;border:none;border-radius:8px;background:#06c755;color:#fff;font-size:15px;font-weight:600;cursor:pointer;">再設定リンクを送る</button>
<div id="msg" style="font-size:12px;margin-top:10px;min-height:14px;color:#374151;"></div>
<div style="text-align:center;margin-top:12px;font-size:12px;"><a href="/" style="color:#06c755;text-decoration:none;">ログインに戻る</a></div></div>
<script>async function send(){const email=document.getElementById("em").value.trim();const b=document.getElementById("sb");b.disabled=true;try{await fetch("/api/forgot",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({email})});}catch(e){}document.getElementById("msg").textContent="ご登録があれば、再設定リンクをメールでお送りしました。届かない場合は迷惑メールをご確認のうえ、運営にお問い合わせください。";b.disabled=false;}</script>
</body></html>`;

const RESET_INVALID_PAGE = `<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>パスワード再設定</title></head>
<body style="font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f3f4f6;">
<div style="background:#fff;padding:28px 24px;border-radius:14px;width:min(90vw,340px);box-shadow:0 2px 14px rgba(0,0,0,.08);text-align:center;">
<div style="font-size:15px;margin-bottom:12px;color:#374151;">リンクの有効期限が切れているか、無効です。</div>
<a href="/forgot" style="color:#06c755;text-decoration:none;">もう一度再設定リンクを取得する</a></div>
</body></html>`;

function RESET_PAGE(tok){ return `<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>新しいパスワード</title></head>
<body style="font-family:-apple-system,'Hiragino Kaku Gothic ProN',sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f3f4f6;">
<div style="background:#fff;padding:28px 24px;border-radius:14px;width:min(90vw,340px);box-shadow:0 2px 14px rgba(0,0,0,.08);">
<div style="font-size:17px;font-weight:600;margin-bottom:14px;">新しいパスワードを設定</div>
<input id="p1" type="password" placeholder="新しいパスワード（8文字以上）" style="width:100%;box-sizing:border-box;padding:11px;border:1px solid #d1d5db;border-radius:8px;font-size:15px;margin-bottom:10px;">
<input id="p2" type="password" placeholder="もう一度入力" style="width:100%;box-sizing:border-box;padding:11px;border:1px solid #d1d5db;border-radius:8px;font-size:15px;margin-bottom:10px;" onkeydown="if(event.key==='Enter'&&!event.isComposing&&event.keyCode!==229)go()">
<button onclick="go()" id="sb" style="width:100%;padding:11px;border:none;border-radius:8px;background:#06c755;color:#fff;font-size:15px;font-weight:600;cursor:pointer;">設定する</button>
<div id="e" style="color:#dc2626;font-size:12px;margin-top:8px;min-height:14px;"></div></div>
<script>var TOK=${JSON.stringify(tok)};async function go(){var p1=document.getElementById("p1").value,p2=document.getElementById("p2").value,e=document.getElementById("e");if(p1.length<8){e.textContent="8文字以上で入力してください";return;}if(p1!==p2){e.textContent="パスワードが一致しません";return;}var b=document.getElementById("sb");b.disabled=true;try{var r=await fetch("/api/reset",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({token:TOK,password:p1})});var j=await r.json();if(j.ok){document.body.innerHTML='<div style=\\'font-family:sans-serif;text-align:center;margin-top:25vh;color:#374151;\\'>パスワードを変更しました。<br><br><a href=\\'/\\' style=\\'color:#06c755;\\'>ログインへ</a></div>';}else{e.textContent=(j.error==='too_short'?'8文字以上で入力してください':(j.error==='expired'?'リンクの有効期限が切れています':'設定に失敗しました'));b.disabled=false;}}catch(err){e.textContent="設定に失敗しました";b.disabled=false;}}</script>
</body></html>`; }

const SIGNUP_PAGE = `<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>新規お申し込み</title></head>
<body style="font-family:-apple-system,'Hiragino Kaku Gothic ProN',sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f3f4f6;">
<div style="background:#fff;padding:28px 24px;border-radius:14px;width:min(90vw,320px);box-shadow:0 2px 14px rgba(0,0,0,.08);">
<div style="font-size:18px;font-weight:600;margin-bottom:4px;">📥 受信トレイ</div>
<div style="font-size:13px;color:#6b7280;margin-bottom:18px;">新規お申し込み</div>
<label style="font-size:12px;color:#374151;display:block;margin:0 0 3px;">会社名（クリニック・店舗名）</label>
<input id="company" placeholder="例：歯と美容のクリニック" autofocus style="width:100%;box-sizing:border-box;padding:11px;border:1px solid #d1d5db;border-radius:8px;font-size:15px;margin-bottom:10px;">
<label style="font-size:12px;color:#374151;display:block;margin:0 0 3px;">ログインID（半角英数字。スタッフ全員がログインに使います）</label>
<input id="lid" autocapitalize="off" placeholder="例：hbclinic" style="width:100%;box-sizing:border-box;padding:11px;border:1px solid #d1d5db;border-radius:8px;font-size:15px;margin-bottom:10px;">
<label style="font-size:12px;color:#374151;display:block;margin:0 0 3px;">ログインパスワード（8文字以上）</label>
<input id="p" type="password" style="width:100%;box-sizing:border-box;padding:11px;border:1px solid #d1d5db;border-radius:8px;font-size:15px;margin-bottom:10px;" onkeydown="if(event.key==='Enter'&&!event.isComposing&&event.keyCode!==229)go()">
<button onclick="go()" style="width:100%;padding:11px;border:none;border-radius:8px;background:#06c755;color:#fff;font-size:15px;font-weight:600;cursor:pointer;">アカウントを作成</button>
<div id="e" style="color:#dc2626;font-size:12px;margin-top:8px;min-height:14px;"></div>
<div style="text-align:center;margin-top:6px;"><a href="/" style="font-size:12px;color:#6b7280;">既にアカウントをお持ちの方はこちら</a></div></div>
<script>async function go(){const company=document.getElementById("company").value.trim();const loginId=document.getElementById("lid").value.trim();const password=document.getElementById("p").value;const e=document.getElementById("e");if(!company){e.textContent="会社名を入力してください";return;}if(!/^[a-zA-Z0-9_-]{3,30}$/.test(loginId)){e.textContent="ログインIDは半角英数字3〜30文字にしてください";return;}if(password.length<8){e.textContent="パスワードは8文字以上にしてください";return;}const r=await fetch("/api/signup",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({company,loginId,password})});let j={};try{j=await r.json();}catch(err){}if(j.ok){location.href="/";}else{e.textContent=j.error==="too_short"?"パスワードは8文字以上にしてください":j.error==="id_taken"?"このログインIDは既に使われています":j.error==="bad_id"?"ログインIDは半角英数字3〜30文字にしてください":"作成に失敗しました";}}</script>
</body></html>`;

const BOARD_PAGE = `<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>現場ボード</title>
<style>
body{margin:0;font-family:-apple-system,"Hiragino Kaku Gothic ProN","Noto Sans JP",sans-serif;background:#111827;color:#fff;min-height:100vh;}
header{display:flex;align-items:center;justify-content:space-between;padding:14px 18px;border-bottom:1px solid #374151;}
h1{font-size:18px;margin:0;}
#clock{font-size:15px;color:#9ca3af;}
#cards{padding:16px;display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px;}
.card{border-radius:14px;padding:14px;background:#1f2937;border-left:6px solid #6b7280;}
.card.t緊急来院{border-left-color:#ef4444;background:#2d1a1a;}
.card.t当日キャンセル{border-left-color:#f59e0b;background:#2b2113;}
.card.t遅刻{border-left-color:#fbbf24;}
.card.t共有{border-left-color:#3b82f6;}
.chip{display:inline-block;font-size:12px;font-weight:700;padding:2px 9px;border-radius:7px;background:#374151;margin-bottom:8px;}
.t緊急来院 .chip{background:#ef4444;}
.t当日キャンセル .chip{background:#f59e0b;color:#111;}
.t遅刻 .chip{background:#fbbf24;color:#111;}
.t共有 .chip{background:#3b82f6;}
.sum{font-size:15px;line-height:1.5;margin-bottom:8px;white-space:pre-wrap;word-break:break-word;}
.meta{font-size:12px;color:#9ca3af;display:flex;justify-content:space-between;align-items:center;}
.okbtn{font-size:12px;padding:5px 12px;border:1px solid #4b5563;background:transparent;color:#d1d5db;border-radius:8px;cursor:pointer;}
#empty{padding:60px 20px;text-align:center;color:#6b7280;font-size:16px;}
</style></head><body>
<header><h1>🏥 現場ボード</h1><span id="clock"></span></header>
<div id="cards"></div><div id="empty" style="display:none;">現在、現場への連絡はありません</div>
<script>
function tick(){var d=new Date();document.getElementById("clock").textContent=d.toLocaleDateString("ja-JP",{month:"numeric",day:"numeric",weekday:"short"})+" "+String(d.getHours()).padStart(2,"0")+":"+String(d.getMinutes()).padStart(2,"0");}
tick();setInterval(tick,15000);
function esc(s){return (s||"").replace(/[<>&]/g,function(c){return {"<":"&lt;",">":"&gt;","&":"&amp;"}[c];});}
async function loadB(){try{var r=await fetch("/api/alerts");var arr=await r.json();var el=document.getElementById("cards");el.innerHTML=arr.map(function(a){var t=new Date(a.ts);var hm=String(t.getHours()).padStart(2,"0")+":"+String(t.getMinutes()).padStart(2,"0");return '<div class="card t'+esc(a.type)+'"><span class="chip">'+esc(a.type)+'</span><div class="sum">'+esc(a.summary)+'</div><div class="meta"><span>'+esc(a.name||"")+'　'+hm+'</span><button class="okbtn" onclick="doneA('+a.id+')">対応した</button></div></div>';}).join("");document.getElementById("empty").style.display=arr.length?"none":"block";}catch(e){}}
async function doneA(id){await fetch("/api/alert-done",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({id:id})});loadB();}
loadB();setInterval(loadB,8000);
</script></body></html>`;

const PAGE = `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">
<title>クリニック受信トレイ</title>
<link rel="manifest" href="/manifest.json">
<link rel="apple-touch-icon" href="/icon.png">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<meta name="theme-color" content="#06c755">
<style>
  :root{--bg:#f3f4f6;--panel:#fff;--line:#e5e7eb;--text:#111827;--muted:#6b7280;--line-green:#06c755;--mail-blue:#2563eb;--danger:#dc2626;--info:#2563eb;--done:#16a34a;--bubble-us:#dcf7c5;--bubble-us-text:#14532d;--chatbg:#eef0f3;}
  *{box-sizing:border-box;}
  html,body{margin:0;height:100%;font-family:-apple-system,"Hiragino Kaku Gothic ProN","Noto Sans JP",sans-serif;color:var(--text);background:var(--bg);}
  #app{display:flex;height:100vh;height:100dvh;overflow:hidden;}
  #list{width:320px;flex-shrink:0;background:var(--panel);border-right:1px solid var(--line);display:flex;flex-direction:column;}
  #listHead{padding:12px 14px 6px;font-weight:600;display:flex;align-items:center;justify-content:space-between;}
  #tools{display:flex;gap:6px;padding:4px 12px 10px;border-bottom:1px solid var(--line);}
  .tbtn{flex:1;font-size:11px;padding:7px 2px;border:1px solid var(--line);background:#fff;border-radius:9px;cursor:pointer;white-space:nowrap;color:var(--text);}
  .tbtn:hover{background:#f9fafb;}
  .tbtn.migi{border-color:#ddd6fe;background:#f5f3ff;color:#6d28d9;font-weight:600;}
  #search{margin:10px 12px;padding:8px 10px;border:1px solid var(--line);border-radius:8px;font-size:13px;}
  #rooms{flex:1;overflow-y:auto;}
  .room{display:flex;align-items:center;gap:10px;padding:11px 12px;border-bottom:1px solid var(--line);cursor:pointer;}
  .room:hover{background:#f9fafb;}.room.active{background:#eef2ff;}.room.flag{background:#fef2f2;}
  .avatar{width:40px;height:40px;border-radius:50%;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:14px;color:#fff;position:relative;background-size:cover;background-position:center;}
  .ch{position:absolute;right:-2px;bottom:-2px;width:17px;height:17px;border-radius:50%;border:2px solid #fff;display:flex;align-items:center;justify-content:center;font-size:9px;color:#fff;}
  .ch.line{background:var(--line-green);}.ch.mail{background:var(--mail-blue);}
  .rmid{flex:1;min-width:0;}.rtop{display:flex;justify-content:space-between;align-items:center;}
  .rname{font-size:14px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
  .rtime{font-size:11px;color:var(--muted);flex-shrink:0;margin-left:6px;}
  .rlast{font-size:12px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
  .stat{flex-shrink:0;width:20px;text-align:center;font-size:15px;}
  .dot{width:9px;height:9px;border-radius:50%;background:var(--info);display:inline-block;}.flagicon{color:var(--danger);}.doneicon{color:var(--done);}
  #chat{flex:1;display:flex;flex-direction:column;min-width:0;background:var(--chatbg);}
  #chatHead{display:flex;align-items:center;gap:10px;padding:10px 14px;background:var(--panel);border-bottom:1px solid var(--line);}
  #backBtn{display:none;border:none;background:none;font-size:20px;cursor:pointer;color:var(--text);}
  #chatName{font-weight:600;flex:1;}
  .hbtn{font-size:12px;padding:6px 10px;border:1px solid var(--line);background:#fff;border-radius:8px;cursor:pointer;white-space:nowrap;}
  #msgs{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:10px;}
  .b{max-width:74%;padding:9px 12px;border-radius:14px;font-size:13px;line-height:1.5;white-space:pre-wrap;word-break:break-word;}
  .b.them{align-self:flex-start;background:#fff;border:1px solid var(--line);}.b.us{align-self:flex-end;background:var(--bubble-us);color:var(--bubble-us-text);}
  .b.media{padding:5px;}.b img.ph{max-width:200px;border-radius:10px;display:block;}
  .vid{width:200px;height:120px;border-radius:10px;background:#111827;display:flex;align-items:center;justify-content:center;color:#fff;font-size:30px;position:relative;}.vid span{position:absolute;bottom:6px;right:8px;font-size:11px;}
  .btime{font-size:10px;color:var(--muted);margin:2px 4px;}
  #composer{background:var(--panel);border-top:1px solid var(--line);padding:10px 12px;}
  #aiLabel{font-size:11px;color:var(--info);margin-bottom:5px;}
  #draftRow{display:flex;gap:8px;align-items:flex-end;}
  #attach{flex-shrink:0;width:38px;height:38px;border:1px solid var(--line);border-radius:9px;background:#fff;cursor:pointer;font-size:18px;}
  #draft{flex:1;min-height:110px;max-height:300px;border:1px solid #d1d5db;border-radius:10px;padding:9px 11px;font-size:13px;line-height:1.5;font-family:inherit;resize:vertical;transition:min-height .15s ease;}
  #cbtns{display:flex;gap:8px;margin-top:8px;justify-content:flex-end;flex-wrap:wrap;}
  .cbtn{font-size:13px;padding:7px 14px;border-radius:9px;border:1px solid var(--line);background:#fff;cursor:pointer;}
  .cbtn.send{background:var(--line-green);border-color:var(--line-green);color:#fff;font-weight:600;}
  .cbtn.ai{background:#eff6ff;border-color:#bfdbfe;color:#1d4ed8;}.cbtn.done{background:#ecfdf5;border-color:#a7f3d0;color:#047857;}
  #empty{flex:1;display:flex;align-items:center;justify-content:center;color:var(--muted);font-size:14px;}
  #menu{position:fixed;z-index:50;background:#fff;border:1px solid var(--line);border-radius:10px;padding:5px;display:none;box-shadow:0 6px 24px rgba(0,0,0,.12);}
  #menu div{padding:9px 14px;font-size:13px;cursor:pointer;border-radius:7px;white-space:nowrap;}#menu div:hover{background:#f3f4f6;}
  #pop{position:fixed;inset:0;background:rgba(0,0,0,.35);z-index:60;display:none;align-items:center;justify-content:center;}
  #popCard{background:#fff;border-radius:14px;padding:18px;width:min(92vw,380px);}#popCard h3{margin:0 0 10px;font-size:15px;}
  #popInput{width:100%;min-height:70px;border:1px solid #d1d5db;border-radius:10px;padding:9px 11px;font-size:13px;font-family:inherit;}
  #popBtns{display:flex;gap:8px;margin-top:12px;justify-content:flex-end;}
  .badge{font-size:10px;padding:1px 6px;border-radius:6px;background:#eef2ff;color:#3730a3;}
  .cbtn.learn{background:#f5f3ff;border-color:#ddd6fe;color:#6d28d9;}
  .cbtn.flagb{background:#fef2f2;border-color:#fecaca;color:#dc2626;}
  #migiBtn{font-size:11px;padding:4px 9px;border:1px solid #ddd6fe;background:#f5f3ff;color:#6d28d9;border-radius:8px;cursor:pointer;margin-left:8px;font-weight:600;}
  #asst{position:fixed;inset:0;background:rgba(0,0,0,.25);z-index:70;display:none;}
  #asstCard{position:absolute;right:0;top:0;bottom:0;width:min(96vw,430px);background:#fff;display:flex;flex-direction:column;overflow:hidden;box-shadow:-4px 0 24px rgba(0,0,0,.15);animation:slideinX .28s cubic-bezier(.22,.9,.36,1);}
  .amcard{align-self:flex-start;max-width:92%;background:#fff;border:1px solid #ddd6fe;border-radius:12px;padding:10px 12px;font-size:12.5px;}
  .amcard .t{font-weight:600;color:#6d28d9;margin-bottom:4px;font-size:12px;}
  .amcard .c{white-space:pre-wrap;word-break:break-word;color:#374151;max-height:140px;overflow-y:auto;line-height:1.5;}
  .amcard button{margin-top:8px;border:none;background:#7c3aed;color:#fff;border-radius:8px;padding:7px 12px;font-size:12.5px;cursor:pointer;font-weight:600;}
  .amcard button:disabled{background:#d1d5db;cursor:default;}
  .spin{display:inline-block;width:13px;height:13px;border:2px solid #ddd6fe;border-top-color:#7c3aed;border-radius:50%;animation:spin .7s linear infinite;vertical-align:-2px;margin-right:7px;}
  @keyframes spin{to{transform:rotate(360deg);}}
  #dpanel{position:fixed;inset:0;background:rgba(0,0,0,.25);z-index:72;display:none;}
  #dCard{position:absolute;right:0;top:0;bottom:0;width:min(96vw,430px);background:#fff;display:flex;flex-direction:column;overflow:hidden;box-shadow:-4px 0 24px rgba(0,0,0,.15);animation:slideinX .28s cubic-bezier(.22,.9,.36,1);}
  #dMsgs{flex:1;overflow-y:auto;padding:10px;display:flex;flex-direction:column;gap:8px;background:#f8fafc;}
  #dChips{padding:6px 10px 0;display:flex;gap:6px;flex-wrap:wrap;}
  #dText{flex:1;border:1px solid #d1d5db;border-radius:10px;padding:10px 12px;font-size:14px;font-family:inherit;min-height:110px;max-height:240px;resize:vertical;}
  @media(max-width:760px){
    #asstCard{left:0;right:0;top:auto;bottom:0;width:auto;height:80vh;border-radius:16px 16px 0 0;box-shadow:0 -4px 24px rgba(0,0,0,.18);animation:slideinY .28s cubic-bezier(.22,.9,.36,1);}
    #dCard{left:0;right:0;top:auto;bottom:0;width:auto;height:84vh;border-radius:16px 16px 0 0;box-shadow:0 -4px 24px rgba(0,0,0,.18);animation:slideinY .28s cubic-bezier(.22,.9,.36,1);}
    #dText,#asstText{font-size:16px;min-height:56px;transition:min-height .15s;}
    #dText:focus,#asstText:focus{min-height:150px;}
  }
  #asstHead{padding:11px 13px;border-bottom:1px solid var(--line);display:flex;align-items:center;justify-content:space-between;font-weight:600;font-size:14px;gap:8px;}
  #asstMsgs{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:8px;background:#f8fafc;}
  .am{max-width:85%;padding:8px 11px;border-radius:12px;font-size:13px;line-height:1.5;white-space:pre-wrap;word-break:break-word;}
  .am.user{align-self:flex-end;background:#dbeafe;}
  .am.ai{align-self:flex-start;background:#fff;border:1px solid var(--line);}
  .am.sysn{align-self:center;background:#ecfdf5;color:#047857;font-size:12px;}
  #asstIn{display:flex;gap:8px;padding:10px;border-top:1px solid var(--line);align-items:flex-end;}
  #asstText{flex:1;border:1px solid #d1d5db;border-radius:10px;padding:10px 12px;font-size:14px;font-family:inherit;min-height:110px;max-height:240px;resize:vertical;}
  @keyframes slideinX{from{transform:translateX(102%);}to{transform:translateX(0);}}
  @keyframes slideinY{from{transform:translateY(102%);}to{transform:translateY(0);}}
  @keyframes slideoutX{from{transform:translateX(0);}to{transform:translateX(102%);}}
  @keyframes slideoutY{from{transform:translateY(0);}to{transform:translateY(102%);}}
  @media(max-width:760px){#list{width:100%;}#chat{display:none;position:absolute;inset:0;}#app.chatopen #list{display:none;}#app.chatopen #chat{display:flex;}#backBtn{display:block;}
    #draft{min-height:44px;}#draft:focus{min-height:140px;}
    #draft,#search,#popInput,#asstText,#setTone{font-size:16px;}}
</style>
</head>
<body>
<div id="app">
  <div id="list">
    <div id="listHead"><span>📥 受信トレイ</span><span class="badge" id="cnt"></span></div>
    <div id="tools">
      <button class="tbtn migi" onclick="openAsst(null)">🤝 みぎうで君</button>
      <button class="tbtn" onclick="window.open('/board','_blank')">🏥 現場ボード</button>
      <button class="tbtn" id="bellBtn" onclick="enablePush()">🔔 通知</button>
      <button class="tbtn" onclick="openSet()">⚙ 設定<span id="newModelDot" style="display:none;margin-left:3px;">🆕</span></button>
    </div>
    <input id="search" placeholder="検索" oninput="renderList()">
    <div id="rooms"></div>
  </div>
  <div id="chat"><div id="empty">左の一覧から会話を選んでください</div></div>
</div>
<div id="menu"></div>
<div id="dpanel"><div id="dCard">
  <div style="padding:11px 13px;border-bottom:1px solid var(--line);display:flex;align-items:center;justify-content:space-between;font-weight:600;font-size:14px;"><span>✨ AIで作り直す（会話で調整）</span><button class="cbtn" onclick="closeDraftChat()">閉じる</button></div>
  <div id="dMsgs"></div>
  <div id="dChips">
    <button class="cbtn" onclick="dChip('もっと簡潔に短くして')">簡潔に</button>
    <button class="cbtn" onclick="dChip('もっと丁寧で温かい言い方にして')">丁寧に</button>
    <button class="cbtn" onclick="dChip('もっと柔らかい印象にして')">柔らかく</button>
  </div>
  <div style="display:flex;gap:8px;padding:10px;border-top:1px solid var(--line);align-items:flex-end;"><textarea id="dText" placeholder="どう変えたいか入力…（例：予約確定メールに記載の院に来てと案内して）" onkeydown="if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing&&event.keyCode!==229){event.preventDefault();dSend();}"></textarea><button class="cbtn send" onclick="dSend()">送信</button></div>
</div></div>
<div id="setPop" style="position:fixed;inset:0;background:rgba(0,0,0,.35);z-index:65;display:none;align-items:center;justify-content:center;"><div style="background:#fff;border-radius:14px;padding:18px;width:min(92vw,360px);max-height:86vh;overflow-y:auto;overscroll-behavior:contain;-webkit-overflow-scrolling:touch;">
  <h3 style="margin:0 0 12px;font-size:15px;">⚙ 設定</h3>
  <label style="display:flex;align-items:center;gap:10px;font-size:14px;padding:8px 0;cursor:pointer;"><input type="checkbox" id="setAuto" style="width:18px;height:18px;"> 自動返信を有効にする</label>
  <div style="font-size:12px;color:#6b7280;margin:2px 0 10px;">AIの確信率が高い問い合わせに、スタッフを待たずAIが自動で返信します。緊急・要対応と判定されたものは自動返信されません。</div>
  <div style="font-size:13px;margin-bottom:4px;">自動返信の対象</div>
  <select id="setLevel" style="width:100%;padding:8px;border:1px solid #d1d5db;border-radius:8px;font-size:13px;">
    <option value="high">確信率「高」のみ（おすすめ）</option>
    <option value="medium">確信率「高」と「中」</option>
  </select>
  <div style="font-size:13px;margin:12px 0 4px;">⏱ 自動返信までの待ち時間（分）</div>
  <input type="number" id="setDelay" min="0" max="60" step="1" inputmode="numeric" style="width:100%;box-sizing:border-box;padding:8px;border:1px solid #d1d5db;border-radius:8px;font-size:13px;">
  <div style="font-size:11px;color:#6b7280;margin-top:2px;">例：5 と入れると、メッセージ受信から5分後に自動返信します。0 なら即時。返信文の生成に設定時間以上かかった場合は、できあがり次第すぐ送信します。</div>
  <div style="border-top:1px solid #e5e7eb;margin-top:14px;padding-top:10px;">
    <div style="font-size:13px;margin-bottom:4px;">🧠 返信文を作るAIエンジン</div>
    <select id="setEngine" onchange="renderRuleGauge()" style="width:100%;padding:8px;border:1px solid #d1d5db;border-radius:8px;font-size:13px;">
      <option value="gpt">GPT（OpenAI・gpt-5系）</option>
      <option value="gemini">Gemini（gemini-3-flash）</option>
      <option value="claude">Claude（保険・安定）</option>
    </select>
    <div id="engineNote" style="font-size:11px;color:#6b7280;margin-top:2px;">文章作成（AI下書き・自動返信・AIで作り直す）に使うAIです。GPTを使うにはRailwayに OPENAI_KEY（必要なら OPENAI_MODEL）の設定が必要です。未設定のまま選ぶと安全のためClaudeで生成します。みぎうで君チャットと資料読み込みは引き続きClaude/Geminiを使用します。</div>
    <div id="modelAlert" style="display:none;font-size:11px;background:#fef3c7;border:1px solid #fcd34d;color:#92400e;border-radius:8px;padding:8px;margin-top:6px;line-height:1.5;"></div>
  </div>
  <div style="border-top:1px solid #e5e7eb;margin-top:14px;padding-top:10px;">
    <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px;"><span style="font-size:13px;">📚 ルールブックの使用量</span><span id="ruleGaugePct" style="font-size:12px;font-weight:600;color:#6b7280;">—</span></div>
    <div style="background:#e5e7eb;border-radius:999px;height:10px;overflow:hidden;"><div id="ruleGaugeBar" style="height:100%;width:0%;background:#16a34a;transition:width .25s,background .25s;"></div></div>
    <div id="ruleGaugeText" style="font-size:11px;color:#6b7280;margin-top:4px;">読み込み中…</div>
    <div id="ruleGaugeWarn" style="font-size:11px;color:#dc2626;margin-top:2px;display:none;"></div>
  </div>
  <div style="border-top:1px solid #e5e7eb;margin-top:14px;padding-top:10px;">
    <div style="font-size:13px;margin-bottom:4px;">🎨 回答全体のトーン・文体</div>
    <textarea id="setTone" placeholder="例：少し柔らかめで親しみやすい敬語にする。文章は短めに。「〜でございます」は使わない。" style="width:100%;box-sizing:border-box;min-height:70px;border:1px solid #d1d5db;border-radius:8px;padding:8px;font-size:13px;font-family:inherit;"></textarea>
    <div style="font-size:11px;color:#6b7280;margin-top:2px;">ここに書いた指示は、AI下書き・自動返信・AIで作り直す、すべてに最優先で反映されます。空欄なら標準のトーンです。</div>
  </div>
  <div style="border-top:1px solid #e5e7eb;margin-top:14px;padding-top:10px;">
    <div style="font-size:13px;margin-bottom:4px;">🧠 スタッフの記憶（全返信に効く恒久ルール）</div>
    <div id="prefList" style="font-size:12px;color:#374151;"></div>
    <div style="display:flex;gap:6px;margin-top:6px;">
      <input id="prefInput" placeholder="例：返信の冒頭に『様』を付けない" style="flex:1;box-sizing:border-box;padding:8px;border:1px solid #d1d5db;border-radius:8px;font-size:12px;">
      <button class="cbtn" onclick="addPref()">＋追加</button>
    </div>
    <div style="font-size:11px;color:#6b7280;margin-top:4px;">「AIで作り直す」で『今後〜』『常に〜』のように指示すると自動でここに記憶され、以後の全返信に効きます。手動の追加・削除もここで。</div>
  </div>
  <div style="border-top:1px solid #e5e7eb;margin-top:14px;padding-top:10px;">
    <div style="display:flex;justify-content:space-between;align-items:center;cursor:pointer;" onclick="document.getElementById('connBox').style.display=document.getElementById('connBox').style.display==='none'?'block':'none'"><span style="font-size:13px;font-weight:600;">🔗 連携設定（LINE・メール）</span><span id="connStat" style="font-size:11px;color:#16a34a;"></span></div>
    <div id="connBox" style="display:none;margin-top:8px;">
      <div style="font-size:12px;font-weight:600;margin:6px 0 2px;">LINE連携</div>
      <input id="cLineSecret" type="password" placeholder="チャネルシークレット（変更時のみ入力）" style="width:100%;box-sizing:border-box;padding:8px;border:1px solid #d1d5db;border-radius:8px;font-size:12px;margin-bottom:4px;">
      <input id="cLineToken" type="password" placeholder="チャネルアクセストークン（変更時のみ入力）" style="width:100%;box-sizing:border-box;padding:8px;border:1px solid #d1d5db;border-radius:8px;font-size:12px;">
      <div style="font-size:12px;font-weight:600;margin:10px 0 2px;">メール連携（Gmail以外もOK）</div>
      <div style="display:flex;gap:6px;margin-bottom:4px;"><input id="cSmtpHost" placeholder="SMTPホスト" style="flex:2;padding:8px;border:1px solid #d1d5db;border-radius:8px;font-size:12px;"><input id="cSmtpPort" placeholder="465" style="flex:1;padding:8px;border:1px solid #d1d5db;border-radius:8px;font-size:12px;"></div>
      <input id="cSmtpUser" placeholder="送信メールアドレス" style="width:100%;box-sizing:border-box;padding:8px;border:1px solid #d1d5db;border-radius:8px;font-size:12px;margin-bottom:4px;">
      <input id="cSmtpPass" type="password" placeholder="送信パスワード（変更時のみ入力）" style="width:100%;box-sizing:border-box;padding:8px;border:1px solid #d1d5db;border-radius:8px;font-size:12px;margin-bottom:4px;">
      <div style="display:flex;gap:6px;margin-bottom:4px;"><input id="cImapHost" placeholder="IMAPホスト" style="flex:2;padding:8px;border:1px solid #d1d5db;border-radius:8px;font-size:12px;"><input id="cImapPort" placeholder="993" style="flex:1;padding:8px;border:1px solid #d1d5db;border-radius:8px;font-size:12px;"></div>
      <input id="cImapUser" placeholder="受信メールアドレス（空欄=送信と同じ）" style="width:100%;box-sizing:border-box;padding:8px;border:1px solid #d1d5db;border-radius:8px;font-size:12px;margin-bottom:4px;">
      <input id="cImapPass" type="password" placeholder="受信パスワード（変更時のみ入力）" style="width:100%;box-sizing:border-box;padding:8px;border:1px solid #d1d5db;border-radius:8px;font-size:12px;margin-bottom:6px;">
      <label style="display:flex;align-items:center;gap:8px;font-size:13px;padding:4px 0;cursor:pointer;"><input type="checkbox" id="cEmailInternal" style="width:16px;height:16px;"> メール受信をこのアプリで直接監視する</label>
      <div style="font-size:11px;color:#6b7280;margin-bottom:8px;">⚠️ オンにする前に、Make等の旧メール監視を必ず停止してください（二重取り込み防止）</div>
      <button class="cbtn" style="width:100%;" onclick="saveConn()">連携設定を保存</button>
      <div style="border-top:1px dashed #e5e7eb;margin-top:10px;padding-top:8px;">
        <div style="font-size:12px;font-weight:600;margin-bottom:4px;">➕ 追加アカウント（複数のLINE・メールを集約）</div>
        <div id="acctList" style="font-size:12px;color:#374151;"></div>
        <div style="display:flex;gap:6px;margin-top:6px;">
          <button class="cbtn" onclick="addLineAcct()">＋LINE追加</button>
          <button class="cbtn" onclick="addMailAcct()">＋メール追加</button>
        </div>
        <div style="font-size:11px;color:#6b7280;margin-top:4px;">届いたアカウント宛に返信も自動で振り分けられます。LINE追加後は、そのチャネルのWebhook URLにこのアプリと同じURLを設定してください。</div>
      </div>
    </div>
  </div>
  <div style="border-top:1px solid #e5e7eb;margin-top:14px;padding-top:10px;">
    <div style="font-size:13px;margin-bottom:6px;">✅ 一括操作</div>
    <button class="cbtn" style="width:100%;" onclick="markAllDone()">すべてのチャットを対応済みにする</button>
    <div style="font-size:11px;color:#6b7280;margin-top:4px;">未対応・要対応をまとめて「対応済み」にします。元に戻すときは各チャットを個別に開いて操作してください。</div>
  </div>
  <div style="border-top:1px solid #e5e7eb;margin-top:12px;padding-top:10px;display:flex;flex-direction:column;gap:8px;">
    <button class="cbtn" style="width:100%;" onclick="changeLoginId()">🪪 ログインIDを変更</button>
    <button class="cbtn" style="width:100%;" onclick="changePass()">🔑 ログインパスワードを変更</button>
    <button class="cbtn" style="width:100%;" onclick="location.href='/api/backup'">💾 バックアップをダウンロード（会話・ルール・設定）</button>
    <button class="cbtn" style="width:100%;" onclick="doLogout()">↩ ログアウト</button>
  </div>
  <div style="display:flex;gap:8px;margin-top:14px;justify-content:flex-end;"><button class="cbtn" onclick="closeSet()">閉じる</button><button class="cbtn send" onclick="saveSet()">保存</button></div>
</div></div>
<div id="asst"><div id="asstCard">
  <div id="asstHead"><span>🤝 みぎうで君（ルールブック編集）</span><button class="cbtn" onclick="closeAsst()">閉じる</button></div>
  <div id="asstMsgs"></div>
  <div id="asstIn"><button class="cbtn" onclick="asstAttach()" title="価格表などの資料（画像・PDF・CSV）を読み込ませて一括学習">📎</button><textarea id="asstText" placeholder="例：発送質問には3営業日以内と答えて／今の料金ルールは？" onkeydown="if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing&&event.keyCode!==229){event.preventDefault();asstSend();}"></textarea><button class="cbtn send" onclick="asstSend()">送信</button></div>
</div></div>
<div id="learnToast" style="display:none;position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:75;background:#065f46;color:#fff;border-radius:10px;padding:8px 14px;font-size:12px;box-shadow:0 6px 20px rgba(0,0,0,.25);">✓ この対応を学習しました</div>
<div id="conflictPop" style="position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:80;display:none;align-items:center;justify-content:center;"><div style="background:#fff;border-radius:14px;padding:18px;width:min(92vw,380px);max-height:86vh;overflow-y:auto;">
  <h3 style="margin:0 0 8px;font-size:15px;">⚠️ 前と答えが食い違っています</h3>
  <div style="font-size:12px;color:#374151;margin-bottom:4px;">似た質問に、前はこう答えていました：</div>
  <div id="conflictOld" style="font-size:12px;background:#f3f4f6;border-radius:8px;padding:8px;margin-bottom:8px;white-space:pre-wrap;"></div>
  <div style="font-size:12px;color:#374151;margin-bottom:4px;">今回はこう答えました：</div>
  <div id="conflictNew" style="font-size:12px;background:#ede9fe;border-radius:8px;padding:8px;margin-bottom:12px;white-space:pre-wrap;"></div>
  <div style="font-size:12px;color:#374151;margin-bottom:10px;">今後はどちらを基準にしますか？</div>
  <div style="display:flex;flex-direction:column;gap:8px;">
    <button class="cbtn send" style="width:100%;" onclick="resolveConflict('new')">今後は今回を基準にする（前の答えを消す）</button>
    <button class="cbtn" style="width:100%;" onclick="resolveConflict('exception')">今回は特例（前の答えを残す・今回は学習しない）</button>
    <button class="cbtn" style="width:100%;" onclick="resolveConflict('chat')">どちらでもない（チャットで正しい答えを決める）</button>
  </div>
</div></div>
<script>
let DATA=[];let current=null;
const roomsEl=document.getElementById("rooms"),chatEl=document.getElementById("chat"),appEl=document.getElementById("app");
async function load(){ try{ const r=await fetch("/api/conversations"); DATA=await r.json(); }catch(e){} renderList(); if(current){ const c=DATA.find(x=>x.id===current); if(c) syncMsgs(c); } }
function api(path,body){ return fetch(path,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)}); }
function filt(){ const q=(document.getElementById("search").value||"").trim(); return q?DATA.filter(r=>(r.name||"").includes(q)||(r.last||"").includes(q)):DATA; }
function chIcon(ch){return ch==="line"?'<span class="ch line">L</span>':'<span class="ch mail">✉</span>';}
function statIcon(r){ if(r.flag)return '<i class="flagicon">⚑</i>'; if(r.status==="done")return r.lastAuto?'<span title="自動返信済み" style="font-size:13px;">🤖</span>':''; return '<span class="dot"></span>'; }
// 一覧の時刻表示：当日はHH:MM、昨日は「昨日」、それ以前は日付（年跨ぎはYYYY/M/D）。r.ts が無い古いデータは従来のr.timeにフォールバック。
function tlabel(r){
  if(!r.ts){ return r.time||""; }
  const d=new Date(r.ts), n=new Date();
  const sameDay=(a,b)=>a.getFullYear()===b.getFullYear()&&a.getMonth()===b.getMonth()&&a.getDate()===b.getDate();
  if(sameDay(d,n)) return String(d.getHours()).padStart(2,"0")+":"+String(d.getMinutes()).padStart(2,"0");
  const y=new Date(n); y.setDate(n.getDate()-1);
  if(sameDay(d,y)) return "昨日";
  if(d.getFullYear()===n.getFullYear()) return (d.getMonth()+1)+"/"+d.getDate();
  return d.getFullYear()+"/"+(d.getMonth()+1)+"/"+d.getDate();
}
function av(r,sz){ const s=sz||40; const bg=r.pic?("background-image:url("+r.pic+");"):("background:"+(r.color||"#888")+";"); return '<div class="avatar" style="width:'+s+'px;height:'+s+'px;font-size:'+(s/3)+'px;'+bg+'">'+(r.pic?"":(r.name||"?").charAt(0))+chIcon(r.channel)+'</div>'; }
function renderList(){
  document.getElementById("cnt").textContent="未対応 "+DATA.filter(r=>r.status!=="done").length+"件";
  roomsEl.innerHTML="";
  filt().forEach(r=>{ const d=document.createElement("div");
    d.className="room"+(current===r.id?" active":"")+(r.flag?" flag":"");
    const acctBadge=(r.acct&&r.acct.name&&r.acct.name!=="メイン")?' <span class="badge">'+esc(r.acct.name)+'</span>':'';
    d.innerHTML=av(r)+'<div class="rmid"><div class="rtop"><span class="rname">'+esc(r.name)+acctBadge+'</span><span class="rtime">'+tlabel(r)+'</span></div><div class="rlast">'+esc(r.last||"")+'</div></div><div class="stat">'+statIcon(r)+'</div>';
    d.onclick=()=>openChat(r.id);
    roomsEl.appendChild(d);
  });
}
function esc(s){return (s||"").replace(/[<>&]/g,c=>({"<":"&lt;",">":"&gt;","&":"&amp;"}[c]));}
function mediaHtml(m){ var cls='b '+(m.from==="them"?"them":"us"); var src=m.mediaId?('/api/line-media/'+m.mediaId):(m.url||"https://placehold.co/300x220/e5e7eb/6b7280?text=%F0%9F%93%B7"); if(m.media==="image")return '<div class="'+cls+' media"><a href="'+src+'" target="_blank"><img class="ph" src="'+src+'"></a></div>'; if(m.media==="video")return (m.mediaId||m.url)?('<div class="'+cls+' media"><video class="ph" style="max-width:220px;border-radius:10px;" controls preload="metadata" src="'+src+'"></video></div>'):('<div class="'+cls+' media"><div class="vid">▶<span>動画</span></div></div>'); if(m.media==="file")return '<div class="'+cls+'"><a href="'+src+'" target="_blank" style="text-decoration:none;">📄 '+esc(m.fileName||"ファイル")+'</a></div>'; if(m.media==="audio")return '<div class="'+cls+'"><a href="'+src+'" target="_blank" style="text-decoration:none;">🎤 音声メッセージ</a></div>'; return ''; }
function bubblesHtml(r){return r.msgs.map(m=>{const body=m.media?mediaHtml(m):('<div class="b '+(m.from==="them"?"them":"us")+'">'+esc(m.text)+'</div>');const tl=(m.time||"")+(m.auto?' <span style="color:#7c3aed;">🤖 自動返信</span>':"");return body+'<div class="btime" style="align-self:'+(m.from==="them"?"flex-start":"flex-end")+'">'+tl+'</div>';}).join("");}
function syncMsgs(c){const m=document.getElementById("msgs");if(!m)return;if(m.getAttribute("data-count")!==String(c.msgs.length)){m.innerHTML=bubblesHtml(c);m.setAttribute("data-count",String(c.msgs.length));m.scrollTop=m.scrollHeight;}}
function openChat(id,keep){ current=id;const r=DATA.find(x=>x.id===id);if(!r)return; appEl.classList.add("chatopen");
  const bubbles=bubblesHtml(r);
  chatEl.innerHTML='<div id="chatHead"><button id="backBtn" onclick="closeChat()">‹</button>'+av(r,30)+'<span id="chatName">'+esc(r.name)+'　<span style="font-size:11px;color:#6b7280;">'+(r.channel==="line"?"LINE":"メール")+((r.acct&&r.acct.name&&r.acct.name!=="メイン")?"・"+esc(r.acct.name):"")+'</span></span><button class="hbtn" onclick="shareClinic()">🏥 クリニックへ共有</button></div>'+
    '<div id="msgs">'+bubbles+'</div>'+
    '<div id="composer"><div id="aiLabel">✨ AI下書き（編集して送れます）</div><div id="topicChips" style="display:none;"></div><div id="draftRow"><button id="attach" onclick="attach()" title="写真・動画を添付">📎</button><textarea id="draft">'+esc(r.draft||"")+'</textarea></div>'+
    '<div id="cbtns"><button class="cbtn flagb" id="flagBtn" onclick="toggleFlag()">'+(r.flag?"⚑ 要対応を外す":"⚑ 要対応")+'</button><button class="cbtn ai" onclick="openDraftChat()">✨ AIで作り直す</button><button class="cbtn done" onclick="markDone()">対応済み</button><button class="cbtn send" onclick="sendMsg()">送信</button></div></div>';
  const m=document.getElementById("msgs");if(m){m.setAttribute("data-count",String(r.msgs.length));m.scrollTop=m.scrollHeight;} selTopics=null; renderTopicChips(r); if(!keep)renderList();
}
function closeChat(){appEl.classList.remove("chatopen");current=null;renderList();}
// ===== 質問チップ：返信する内容を選んで下書きを作り直す =====
let selTopics=null;
function renderTopicChips(r){
  const el=document.getElementById("topicChips"); if(!el)return;
  const tp=(r&&Array.isArray(r.topics))?r.topics.filter(x=>x&&x.q):[];
  if(tp.length<2){ el.style.display="none"; el.innerHTML=""; return; }
  if(!selTopics){ selTopics=new Set(); tp.forEach(x=>{ if(x.need!==false) selTopics.add(x.q); }); }
  el.style.display="block";
  el.innerHTML='<div style="font-size:11px;color:#6b7280;margin:0 0 4px;">返信する内容を選択（タップでON/OFF）</div>'+
    '<div style="display:flex;gap:6px;overflow-x:auto;padding-bottom:4px;">'+
    tp.map((x,i)=>{const on=selTopics.has(x.q);return '<button type="button" onclick="toggleTopic('+i+')" style="flex:0 0 auto;font-size:12px;padding:5px 10px;border-radius:999px;border:1px solid '+(on?"#7c3aed":"#d1d5db")+';background:'+(on?"#ede9fe":"#fff")+';color:'+(on?"#5b21b6":"#9ca3af")+';white-space:nowrap;cursor:pointer;">'+(on?"✓ ":"")+esc(x.q)+'</button>';}).join("")+
    '</div>'+
    '<button type="button" id="redraftBtn" class="cbtn" style="margin:2px 0 6px;font-size:12px;padding:5px 10px;" onclick="redraftSelected()">選んだ内容で下書きを作成</button>';
}
function toggleTopic(i){ const r=DATA.find(x=>x.id===current); if(!r||!Array.isArray(r.topics))return; const tp=r.topics.filter(x=>x&&x.q); const q=tp[i]&&tp[i].q; if(q==null)return; if(!selTopics)selTopics=new Set(); if(selTopics.has(q))selTopics.delete(q); else selTopics.add(q); renderTopicChips(r); }
async function redraftSelected(){ if(!current||!selTopics)return; const sel=[...selTopics]; if(!sel.length){alert("返信する内容を1つ以上選んでください");return;} const btn=document.getElementById("redraftBtn"); if(btn){btn.disabled=true;btn.textContent="作成中…";} try{ const rr=await api("/api/redraft",{id:current,selected:sel}); const j=await rr.json(); if(j&&j.ok&&typeof j.draft==="string"){ const d=document.getElementById("draft"); if(d)d.value=j.draft; const cd=DATA.find(x=>x.id===current); if(cd){cd.draft=j.draft; if(Array.isArray(j.topics))cd.topics=j.topics;} }else{ alert("作り直しに失敗しました"); } }catch(e){ alert("作り直しに失敗しました"); } if(btn){btn.disabled=false;btn.textContent="選んだ内容で下書きを作成";} }
async function markDone(){const id=current;await api("/api/done",{id});await load();}
async function markAllDone(){if(!confirm("すべてのチャットを「対応済み」に変更します。よろしいですか？"))return;try{const r=await api("/api/done-all",{});const j=await r.json();closeSet();if(current){closeChat();}await load();alert((j.count||0)+"件を対応済みにしました");}catch(e){alert("変更に失敗しました");}}
async function sendMsg(){const id=current;const t=document.getElementById("draft").value.trim();if(!t)return;const cd0=DATA.find(x=>x.id===id);const orig=String((cd0&&(cd0.draft0!=null?cd0.draft0:cd0.draft))||"").trim();const edited=(t!==orig);let instr="";try{if(dSessions&&dSessions[id]&&Array.isArray(dSessions[id].hist)){instr=dSessions[id].hist.filter(m=>m&&m.role==="user").map(m=>String(m.content||"")).join(" / ").slice(0,1500);}}catch(e){}const r=await api("/api/send",{id,text:t,instr:edited?instr:""});let j={};try{j=await r.json();}catch(e){}if(j.sent){const d0=document.getElementById("draft");if(d0)d0.value="";const cd=DATA.find(x=>x.id===id);if(cd)cd.draft="";if(j.conflict){showConflict(j.conflict);}else if(edited&&orig.length>0){showLearnToast(j.learnedId);}await load();}else{const m={mail_send_pending:"メール送信は準備中です",LINE_400:"LINE送信失敗：相手がお友だち未登録か、無効なIDの可能性",no_send_config:"送信設定が未完了です"}[j.sendErr]||("送信失敗: "+(j.sendErr||"不明"));alert(m+"\\n（下書きは消えていません）");}}
function attach(){const inp=document.createElement("input");inp.type="file";inp.accept="image/*,video/*,application/pdf,.pdf,.doc,.docx,.xls,.xlsx";inp.onchange=async()=>{const f=inp.files[0];if(!f)return;if(f.size>10*1024*1024){alert("10MB以下のファイルにしてください");return;}const btn=document.getElementById("attach");if(btn){btn.disabled=true;btn.textContent="⏳";}try{const b64=await new Promise((res,rej)=>{const rd=new FileReader();rd.onload=()=>res(String(rd.result).split(",")[1]);rd.onerror=rej;rd.readAsDataURL(f);});const up=await api("/api/upload",{name:f.name,mime:f.type||"application/octet-stream",data:b64});const uj=await up.json();if(!uj.ok)throw new Error(uj.error||"upload");const sr=await api("/api/send-file",{id:current,fileId:uj.fileId});const sj=await sr.json();if(!sj.sent)alert("送信失敗: "+(sj.sendErr||"不明"));await load();}catch(e){alert("ファイル送信に失敗しました: "+e.message);}if(btn){btn.disabled=false;btn.textContent="📎";}};inp.click();}
async function shareClinic(){const note=prompt("現場に伝える内容を入力してください（空欄のままOKを押すと、お客様の直近メッセージをそのまま共有します）","");if(note===null)return;try{const r=await api("/api/share",{id:current,note:note||""});const j=await r.json();if(j.ok)alert("現場ボードに共有しました");else alert("共有に失敗しました");}catch(e){alert("共有に失敗しました");}}
async function toggleFlag(){if(!current)return;try{const r=await api("/api/tag",{id:current});const j=await r.json();const b=document.getElementById("flagBtn");if(b)b.textContent=j.flag?"⚑ 要対応を外す":"⚑ 要対応";const cd=DATA.find(x=>x.id===current);if(cd)cd.flag=j.flag;renderList();}catch(e){}}
// ---- AIで作り直す（会話型・下書きを会話で磨く。会話ごとにセッションを保持し再開可能）----
let dHist=[],dLog=[],dSessions={};
const dMsgsEl=document.getElementById("dMsgs");
function dRender(role,text){const d=document.createElement("div");d.className="am "+role;d.textContent=text;dMsgsEl.appendChild(d);dMsgsEl.scrollTop=dMsgsEl.scrollHeight;return d;}
function dAdd(role,text){dLog.push({type:role,text});return dRender(role,text);}
function dDraftCard(entry){const card=document.createElement("div");card.className="amcard";
  card.innerHTML='<div class="t">📝 下書き案</div><div class="c" style="max-height:220px;">'+esc(entry.draft)+'</div>';
  const b=document.createElement("button");
  if(entry.applied){b.disabled=true;b.textContent="下書きに反映済み";}
  else{b.textContent="✅ この下書きを使う";
    b.onclick=()=>{const d=document.getElementById("draft");if(d)d.value=entry.draft;const cd=DATA.find(z=>z.id===current);if(cd)cd.draft=entry.draft;
      entry.applied=true;b.disabled=true;b.textContent="下書きに反映済み";
      dAdd("sysn","✅ 下書き欄に反映しました");
      setTimeout(closeDraftChat,500);};}
  card.appendChild(b);dMsgsEl.appendChild(card);dMsgsEl.scrollTop=dMsgsEl.scrollHeight;return card;}
function dNewCard(draft){const entry={type:"card",draft,applied:false};dLog.push(entry);dDraftCard(entry);return entry;}
function openDraftChat(){if(!current)return;const c=DATA.find(x=>x.id===current);if(!c)return;
  dMsgsEl.innerHTML="";
  const s=dSessions[current];
  if(s&&s.ts===c.ts){ // 会話に動きがなければ前回の続きから再開
    dHist=s.hist;dLog=s.log;
    dLog.forEach(e=>{if(e.type==="card")dDraftCard(e);else dRender(e.type,e.text);});
  }else{
    dHist=[];dLog=[];dSessions[current]={hist:dHist,log:dLog,ts:c.ts};
    const cur=(document.getElementById("draft")?document.getElementById("draft").value:"").trim()||String(c.draft||"").trim();
    if(cur){
      dAdd("ai","お客様とのやり取りを踏まえて、この下書きを用意しています。");
      dNewCard(cur);
      dAdd("ai","どう変えていきますか？（例：「もっと簡潔に」「予約確定メールに記載の院に来てと案内して」）");
      dHist.push({role:"assistant",content:cur});
    }else{
      dAdd("ai","まだ下書きがありません。どんな返信にしたいか教えてください。お客様との会話は読み込み済みです。");
    }
  }
  document.getElementById("dpanel").style.display="block";
  setTimeout(()=>{const t=document.getElementById("dText");if(t)t.focus();},50);}
function slideClose(pid,cid){const p=document.getElementById(pid),c=document.getElementById(cid);if(!p||!c)return;
  const mob=window.matchMedia("(max-width:760px)").matches;
  c.style.animation=(mob?"slideoutY":"slideoutX")+" .22s ease forwards";
  setTimeout(()=>{p.style.display="none";c.style.animation="";},220);}
function closeDraftChat(){slideClose("dpanel","dCard");}
function dChip(t){const x=document.getElementById("dText");x.value=t;dSend();}
async function dSend(){const x=document.getElementById("dText");const txt=x.value.trim();if(!txt)return;x.value="";
  dAdd("user",txt);dHist.push({role:"user",content:txt});
  const ph=spinAdd(dMsgsEl,"書き直し中…");
  try{
    const r=await api("/api/draft-chat",{id:current,messages:dHist});
    const j=await r.json();ph.remove();
    if(j.ok&&j.draft){
      if(j.reply)dAdd("ai",j.reply);
      dNewCard(j.draft);
      dHist.push({role:"assistant",content:j.draft});
      if(j.memory)dAdd("sysn","🧠 記憶しました：「"+j.memory+"」（今後の全返信に適用します。設定→スタッフの記憶 で確認・削除できます）");
    }else dAdd("sysn","エラー: "+(j.error||"不明"));
  }catch(e){ph.remove();dAdd("sysn","通信エラーが発生しました");}}
// ---- みぎうで君 (rulebook editing chat) ----
let asstHist=[],asstCtx=null;
const asstEl=document.getElementById("asst"),asstMsgsEl=document.getElementById("asstMsgs");
function spinAdd(el,label){const d=document.createElement("div");d.className="am ai";const sp=document.createElement("span");sp.className="spin";d.appendChild(sp);d.appendChild(document.createTextNode(label));el.appendChild(d);el.scrollTop=el.scrollHeight;return d;}
function amAdd(role,text){const d=document.createElement("div");d.className="am "+role;d.textContent=text;asstMsgsEl.appendChild(d);asstMsgsEl.scrollTop=asstMsgsEl.scrollHeight;return d;}
function amCardAdd(p){const card=document.createElement("div");card.className="amcard";
  const head=p.op==="delete"?"🗑 削除案: ":(p.op==="update"?"✏️ 修正案: ":"➕ 追加案: ");
  card.innerHTML='<div class="t">'+head+esc(p.title||("ルール "+(p.id||"")))+'</div>'+(p.content?'<div class="c">'+esc(p.content)+'</div>':"");
  const b=document.createElement("button");b.textContent="📥 ルールブックに反映";
  b.onclick=async()=>{b.disabled=true;b.textContent="反映中…";
    try{const r=await api("/api/rules-apply",{items:[p]});const j=await r.json();
      if(j.ok&&(j.applied||[]).length){b.textContent="✅ 反映済み";j.applied.forEach(a=>amAdd("sysn","✅ ルールブック更新: "+a));}
      else{b.textContent="反映に失敗";b.disabled=false;}
    }catch(e){b.textContent="反映に失敗";b.disabled=false;}};
  card.appendChild(b);asstMsgsEl.appendChild(card);asstMsgsEl.scrollTop=asstMsgsEl.scrollHeight;return card;}
function openAsst(ctx){asstHist=[];asstCtx=ctx||null;asstMsgsEl.innerHTML="";asstEl.style.display="block";
  if(ctx){
    asstHist.push({role:"user",content:"（スタッフが返信を送信しました。会話と返信内容から学習すべき点を読み取って、ルール案を提案してください）"});
    const ph=spinAdd(asstMsgsEl,"送った返信を確認しています…");asstCall(ph);
  }else{
    const greet="ルールブックの編集をお手伝いします。回答をどう変えたいか教えてください。\\n📎ボタンで価格表などの資料（画像・PDF・CSV）を読み込ませて一括学習もできます。「今の料金ルールどうなってる？」のように現状を聞くこともできます。";
    amAdd("ai",greet);asstHist.push({role:"assistant",content:greet});
  }
  setTimeout(()=>{const t=document.getElementById("asstText");if(t)t.focus();},50);}
function closeAsst(){slideClose("asst","asstCard");asstCtx=null;asstHist=[];}
async function asstCall(ph){
  try{const r=await api("/api/assistant",{messages:asstHist,context:asstCtx});const j=await r.json();if(ph)ph.remove();
    if(j.ok){amAdd("ai",j.reply||"");asstHist.push({role:"assistant",content:j.reply||""});(j.proposals||[]).forEach(p=>amCardAdd(p));(j.applied||[]).forEach(a=>amAdd("sysn","✅ ルールブック更新: "+a));}
    else amAdd("sysn","エラー: "+(j.error||"不明"));
  }catch(e){if(ph)ph.remove();amAdd("sysn","通信エラーが発生しました");}}
async function asstSend(){const t=document.getElementById("asstText");const txt=t.value.trim();if(!txt)return;t.value="";
  amAdd("user",txt);asstHist.push({role:"user",content:txt});
  const ph=spinAdd(asstMsgsEl,"考え中…");asstCall(ph);}
function asstAttach(){const inp=document.createElement("input");inp.type="file";inp.accept="image/*,.pdf,.csv,.txt";
  inp.onchange=async()=>{const f=inp.files[0];if(!f)return;
    if(f.size>14*1024*1024){alert("14MB以下のファイルにしてください");return;}
    amAdd("user","📎 "+f.name);const ph=spinAdd(asstMsgsEl,"資料を読み込んでいます…（少し時間がかかります）");
    try{
      const b64=await new Promise((res2,rej)=>{const rd=new FileReader();rd.onload=()=>res2(String(rd.result).split(",")[1]);rd.onerror=rej;rd.readAsDataURL(f);});
      const r=await api("/api/assistant-file",{name:f.name,mime:f.type||"",data:b64});const j=await r.json();ph.remove();
      if(j.ok){
        amAdd("ai",j.reply||"資料を読み取りました。");
        asstHist.push({role:"user",content:"（資料「"+f.name+"」をアップロードした）"});
        asstHist.push({role:"assistant",content:(j.reply||"資料を読み取りました").slice(0,1500)});
        const props=j.proposals||[];props.forEach(p=>amCardAdd(p));
        if(props.length>1){
          const all=document.createElement("button");all.className="cbtn send";all.style.alignSelf="center";all.style.margin="4px 0";all.textContent="📥 すべて反映（"+props.length+"件）";
          all.onclick=async()=>{all.disabled=true;all.textContent="反映中…";
            try{const r2=await api("/api/rules-apply",{items:props});const j2=await r2.json();
              all.textContent="✅ "+(j2.applied||[]).length+"件反映しました";
              amAdd("sysn","✅ ルールブック更新: "+(j2.applied||[]).length+"件（現在 全"+j2.ruleCount+"件）");
            }catch(e){all.textContent="失敗しました";all.disabled=false;}};
          asstMsgsEl.appendChild(all);asstMsgsEl.scrollTop=asstMsgsEl.scrollHeight;
        }
      }else amAdd("sysn","読み込み失敗: "+(j.error==="too_large"?"ファイルが大きすぎます":j.error==="unsupported"?"対応していない形式です（画像・PDF・CSV・テキストのみ）":(j.error||"不明")));
    }catch(e){ph.remove();amAdd("sysn","読み込みに失敗しました");}};
  inp.click();}
// スタッフの記憶（恒久ルール）の一覧描画・追加・削除
function renderPrefs(prefs){const el=document.getElementById("prefList");if(!el)return;const a=Array.isArray(prefs)?prefs:[];if(!a.length){el.innerHTML='<span style="color:#9ca3af;">まだ記憶はありません。</span>';return;}el.innerHTML=a.map(p=>{const id=(p&&p.id!=null)?p.id:"";const tx=(typeof p==="string")?p:((p&&p.text)||"");return '<div style="display:flex;align-items:center;gap:6px;padding:3px 0;"><span style="flex:1;">・'+esc(tx)+'</span><button onclick="delPref('+JSON.stringify(id)+')" style="border:none;background:transparent;color:#dc2626;cursor:pointer;font-size:14px;">×</button></div>';}).join("");}
async function addPref(){const inp=document.getElementById("prefInput");const text=(inp&&inp.value||"").trim();if(!text)return;try{const r=await api("/api/pref-add",{text});const j=await r.json();if(j.ok){if(inp)inp.value="";renderPrefs(j.prefs||[]);}}catch(e){alert("追加に失敗しました");}}
async function delPref(id){try{const r=await api("/api/pref-delete",{id});const j=await r.json();if(j.ok)renderPrefs(j.prefs||[]);}catch(e){}}
// 学習トースト：下書きを修正して送った直後だけ「✓学習しました」と控えめに表示。特例だった場合は「学習しない」で今保存した例を取り消せる。
let learnToastTimer=null;
function showLearnToast(id){ const b=document.getElementById("learnToast"); if(!b)return; b.innerHTML='✓ この対応を学習しました'+(id?' ・ <span style="text-decoration:underline;cursor:pointer;color:#a7f3d0;" onclick="undoLearn('+id+')">特例だった（学習しない）</span>':''); b.style.display="block"; clearTimeout(learnToastTimer); learnToastTimer=setTimeout(()=>{b.style.display="none";}, id?6000:2500); }
async function undoLearn(id){ try{ await api("/api/example-delete",{id}); }catch(e){} const b=document.getElementById("learnToast"); if(b){ b.innerHTML='↩ 学習を取り消しました（特例として記録しません）'; clearTimeout(learnToastTimer); learnToastTimer=setTimeout(()=>{b.style.display="none";},2000); } }
// 矛盾の確認：前の答えと今回の答えが食い違った時に出す。基準を選ぶと不要な方の対応例を削除。
let conflictData=null;
function showConflict(c){ conflictData=c; const o=document.getElementById("conflictOld"),n=document.getElementById("conflictNew"); if(o)o.textContent=c.oldFinal||""; if(n)n.textContent=c.newFinal||""; const p=document.getElementById("conflictPop"); if(p)p.style.display="flex"; }
async function resolveConflict(mode){ const c=conflictData; conflictData=null; const p=document.getElementById("conflictPop"); if(p)p.style.display="none"; if(!c)return; try{ if(mode==="new"){ await api("/api/example-delete",{id:c.oldId}); } else if(mode==="exception"){ await api("/api/example-delete",{id:c.newId}); } else if(mode==="chat"){ await api("/api/example-delete",{id:c.oldId}); await api("/api/example-delete",{id:c.newId}); openConflictChat(c); } }catch(e){} }
// 「どちらでもない」→ みぎうで君を開き、食い違った2案を背景に、正しい案内をチャットで決めてルール化する
function openConflictChat(c){ openAsst(null); try{ asstHist.push({role:"user",content:"（背景）似た質問で過去の回答が食い違っていました。前の回答:「"+(c.oldFinal||"")+"」／今回の回答:「"+(c.newFinal||"")+"」。どちらも正解ではありません。これからスタッフが正しい案内を教えるので、それを既存ルールと矛盾しない形でルール化する提案をしてください。"}); }catch(e){} amAdd("sysn","過去の回答が食い違っていました。正しい案内を教えてください——内容をルールにします。"); }
// ---- settings popup ----
function renderRuleGauge(){
  const info=window.__rules; const bar=document.getElementById("ruleGaugeBar"); if(!bar) return;
  const pctEl=document.getElementById("ruleGaugePct"), txt=document.getElementById("ruleGaugeText"), warn=document.getElementById("ruleGaugeWarn");
  if(!info){ if(txt) txt.textContent="—"; return; }
  const eng=(document.getElementById("setEngine").value)||"claude";
  const budget=(info.budgets&&info.budgets[eng])||info.budget||150000;
  const used=info.chars||0;
  const ratio=budget>0?used/budget:0;
  bar.style.width=Math.min(100,Math.round(ratio*100))+"%";
  let color="#16a34a"; if(ratio>=0.9) color="#dc2626"; else if(ratio>=0.7) color="#f59e0b";
  bar.style.background=color;
  if(pctEl){ pctEl.textContent=Math.round(ratio*100)+"%"; pctEl.style.color=color; }
  const eName=({claude:"Claude",gpt:"GPT",gemini:"Gemini"})[eng]||eng;
  if(txt) txt.textContent="ルール"+(info.count||0)+"件 ・ "+used.toLocaleString()+"文字 / 枠"+budget.toLocaleString()+"文字（"+eName+"）";
  if(warn){
    if(ratio>=1){ warn.style.display="block"; warn.style.color="#dc2626"; warn.textContent="⚠ 枠を超えています。各返信では質問に関連度の高いルールから枠まで読み込み、入りきらないルールは除外されます。"; }
    else if(ratio>=0.9){ warn.style.display="block"; warn.style.color="#f59e0b"; warn.textContent="残りわずかです。これ以上増やすと一部ルールが読み込まれない場合があります。"; }
    else { warn.style.display="none"; }
  }
}
async function openSet(){try{const r=await fetch("/api/settings");const s=await r.json();document.getElementById("setAuto").checked=!!s.autoReply;document.getElementById("setLevel").value=s.level||"high";document.getElementById("setTone").value=s.tone||"";document.getElementById("setEngine").value=s.engine||"gemini";document.getElementById("setDelay").value=(s.autoDelayMin!=null?s.autoDelayMin:0);window.__rules=s.rules||null;renderRuleGauge();renderPrefs(s.prefs||[]);
  if(s.engines){const n=document.getElementById("engineNote");n.textContent="文章作成は選択中のAIで生成（GPT"+(s.engines.gpt?"✓":"⚠キー未設定")+"・Gemini"+(s.engines.gemini?"✓":"⚠")+"・Claude"+(s.engines.claude?"✓":"⚠")+"）。キー未設定のエンジンを選ぶと安全のためClaudeで生成します。";}}catch(e){}
  refreshModelAlert();
  try{const cr=await fetch("/api/conn");const c=await cr.json();document.getElementById("connStat").textContent=(c.lineConfigured?"LINE✓ ":"LINE未 ")+(c.mailConfigured?"メール✓":"メール未");document.getElementById("cSmtpHost").value=c.smtpHost||"";document.getElementById("cSmtpPort").value=c.smtpPort||"";document.getElementById("cSmtpUser").value=c.smtpUser||"";document.getElementById("cImapHost").value=c.imapHost||"";document.getElementById("cImapPort").value=c.imapPort||"";document.getElementById("cImapUser").value=c.imapUser||"";document.getElementById("cEmailInternal").checked=!!c.emailInternal;renderAccts(c);}catch(e){}
  document.getElementById("setPop").style.display="flex";}
function renderAccts(c){const el=document.getElementById("acctList");if(!el)return;let h="";
  (c.extraLines||[]).forEach((a,i)=>{h+='<div style="display:flex;justify-content:space-between;align-items:center;padding:3px 0;"><span>📱 '+esc(a.name)+'</span><button class="cbtn" onclick="delAcct(&quot;line&quot;,'+i+')">削除</button></div>';});
  (c.extraMails||[]).forEach((a,i)=>{h+='<div style="display:flex;justify-content:space-between;align-items:center;padding:3px 0;"><span>✉ '+esc(a.name)+' <span style="color:#9ca3af;">'+esc(a.smtpUser)+'</span></span><button class="cbtn" onclick="delAcct(&quot;mail&quot;,'+i+')">削除</button></div>';});
  el.innerHTML=h||'<div style="color:#9ca3af;">追加アカウントはまだありません</div>';}
async function addLineAcct(){
  const name=prompt("表示名（例：銀座7丁目院LINE）");if(!name)return;
  const token=prompt("チャネルアクセストークン（LINE Developersからコピー）");if(!token)return;
  const secret=prompt("チャネルシークレット");if(!secret)return;
  try{const r=await api("/api/conn-add",{kind:"line",name,token:token.trim(),secret:secret.trim()});const j=await r.json();
    if(j.ok){alert("LINEアカウントを追加しました。\\nLINE Developersのそのチャネルに、このアプリと同じWebhook URLを設定してください。");openSet();}
    else alert("追加失敗: "+(j.error==="bad_token"?"トークンが正しくありません":j.error||"不明"));
  }catch(e){alert("追加に失敗しました");}}
async function addMailAcct(){
  const name=prompt("表示名（例：本院メール）");if(!name)return;
  const u=prompt("メールアドレス");if(!u)return;
  const p=prompt("アプリパスワード（送受信共通）");if(!p)return;
  const host=prompt("SMTPホスト（Gmailなら空欄のままOK）","");if(host===null)return;
  const ihost=host?prompt("IMAPホスト","")||"":"";
  try{const body={kind:"mail",name,smtpUser:u.trim(),smtpPass:p.trim()};if(host)body.smtpHost=host.trim();if(ihost)body.imapHost=ihost.trim();
    const r=await api("/api/conn-add",body);const j=await r.json();
    if(j.ok){alert("メールアカウントを追加しました。受信監視も自動で始まります。");openSet();}
    else alert("追加失敗: "+(j.error||"不明"));
  }catch(e){alert("追加に失敗しました");}}
async function delAcct(kind,i){if(!confirm("この連携を削除しますか？（この連携で届く新着が止まります）"))return;
  try{await api("/api/conn-del",{kind,i});}catch(e){}openSet();}
async function saveConn(){const g=id=>document.getElementById(id).value.trim();const body={lineSecret:g("cLineSecret"),lineToken:g("cLineToken"),smtpHost:g("cSmtpHost"),smtpPort:g("cSmtpPort"),smtpUser:g("cSmtpUser"),smtpPass:g("cSmtpPass"),imapHost:g("cImapHost"),imapPort:g("cImapPort"),imapUser:g("cImapUser"),imapPass:g("cImapPass"),emailInternal:document.getElementById("cEmailInternal").checked};try{const r=await api("/api/conn",body);const j=await r.json();if(j.ok){alert("連携設定を保存しました。\\nLINE: "+(j.lineConfigured?"設定済み":"未設定")+" / メール: "+(j.mailConfigured?"設定済み":"未設定")+" / メール直接監視: "+(j.emailInternal?"オン":"オフ"));["cLineSecret","cLineToken","cSmtpPass","cImapPass"].forEach(id=>document.getElementById(id).value="");}else alert("保存に失敗しました");}catch(e){alert("保存に失敗しました");}}
function closeSet(){document.getElementById("setPop").style.display="none";}
async function saveSet(){const autoReply=document.getElementById("setAuto").checked;const level=document.getElementById("setLevel").value;const tone=document.getElementById("setTone").value;const engine=document.getElementById("setEngine").value;const autoDelayMin=Math.min(60,Math.max(0,Math.round(Number(document.getElementById("setDelay").value)||0)));try{await api("/api/settings",{autoReply,level,tone,engine,autoDelayMin});alert("設定を保存しました");}catch(e){alert("保存に失敗しました");}closeSet();}
async function changeLoginId(){
  const next=prompt("新しいログインID（半角英数字3〜30文字。スタッフ全員のログインに使います）");if(!next)return;
  try{const r=await api("/api/change-loginid",{next:next.trim()});const j=await r.json();
    if(j.ok)alert("ログインIDを「"+j.loginId+"」に変更しました。スタッフに共有してください");
    else alert(j.error==="id_taken"?"このIDは既に使われています":j.error==="bad_id"?"半角英数字3〜30文字にしてください":"変更に失敗しました");
  }catch(e){alert("変更に失敗しました");}}
async function changePass(){
  const cur=prompt("現在のパスワードを入力してください");if(cur===null)return;
  const np=prompt("新しいパスワード（8文字以上）を入力してください");if(np===null)return;
  try{const r=await api("/api/change-pass",{current:cur,next:np});
    if(r.ok){alert("パスワードを変更しました。他のスタッフにも新しいパスワードを共有してください（各端末で次回ログインし直しが必要です）。");}
    else{const j=await r.json().catch(()=>({}));alert(j.error==="wrong_current"?"現在のパスワードが違います":j.error==="too_short"?"8文字以上にしてください":"変更に失敗しました");}
  }catch(e){alert("変更に失敗しました");}
}
async function doLogout(){if(!confirm("ログアウトしますか？"))return;try{await api("/api/logout",{});}catch(e){}location.reload();}
// ---- push notifications ----
if("serviceWorker" in navigator){navigator.serviceWorker.register("/sw.js").catch(()=>{});}
function ub64(s){const p="=".repeat((4-s.length%4)%4);const b=(s+p).replace(/-/g,"+").replace(/_/g,"/");const r=atob(b);const a=new Uint8Array(r.length);for(let i=0;i<r.length;i++)a[i]=r.charCodeAt(i);return a;}
async function enablePush(){
  try{
    if(!("serviceWorker" in navigator)||!("PushManager" in window)){alert("この端末・ブラウザは通知に対応していません");return;}
    const ios=/iP(hone|ad|od)/.test(navigator.userAgent);
    if(ios && !window.matchMedia("(display-mode: standalone)").matches){alert("iPhoneの場合：\\n1. Safariの共有ボタン（□↑）→「ホーム画面に追加」\\n2. ホーム画面のアイコンから開く\\n3. もう一度🔔を押す\\nの順でお願いします");return;}
    const reg=await navigator.serviceWorker.register("/sw.js");
    const perm=await Notification.requestPermission();
    if(perm!=="granted"){alert("通知が許可されませんでした。端末の設定から許可してください。");return;}
    const kr=await fetch("/api/push-key");const kj=await kr.json();
    if(!kj.key){alert("サーバー側の通知設定が未完了です");return;}
    const sub=await reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:ub64(kj.key)});
    await api("/api/subscribe",{sub:JSON.parse(JSON.stringify(sub))});
    const b=document.getElementById("bellBtn");if(b)b.textContent="🔔ON";
    alert("通知をオンにしました。新しい問い合わせが届くとこの端末に通知されます。");
  }catch(e){alert("通知設定に失敗しました: "+e.message);}
}
async function refreshModelAlert(){
  try{
    const r=await fetch("/api/model-check"); const m=await r.json();
    const dot=document.getElementById("newModelDot"); const box=document.getElementById("modelAlert");
    if(m&&m.newer){
      if(dot)dot.style.display="inline";
      if(box){box.style.display="block";box.innerHTML="🆕 新しいAIモデル <b>"+esc(m.latest)+"</b> が出ています（現在: "+esc(m.current)+"）。<br>▶ 試す: RailwayのVariablesで OPENAI_MODEL を「"+esc(m.latest)+"」に変えてDeploy。<br>↩ 戻す: 使い勝手が悪ければ OPENAI_MODEL を「"+esc(m.current)+"」に戻すだけ。";}
    }else{ if(dot)dot.style.display="none"; if(box)box.style.display="none"; }
  }catch(e){}
}
load(); setInterval(load, 6000); refreshModelAlert();
</script>
</body>
</html>`;
