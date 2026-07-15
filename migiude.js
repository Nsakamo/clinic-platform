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
app.use(express.urlencoded({ extended: false, limit: "2mb", verify: (req, res, buf) => { req.rawBody = buf; } }));
const PORT = process.env.PORT || 3000;
// 秘密鍵の定数時間比較（タイミング攻撃対策）。長さ不一致は即false（timingSafeEqualは同長が前提）。
function safeEq(a, b) {
  a = String(a || ""); b = String(b || "");
  const ab = Buffer.from(a), bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}
// デフォルト鍵は廃止（未設定なら空＝下流のfail-closedで常に401）。シークレットは環境変数で必須。
const INGEST_KEY = process.env.INGEST_KEY || "";
const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY || ""; // 全テナント共通（運営持ち）
// ===== 受付くん（SmileMedi Cloud）連携 =====
const PARTNER_KEY = process.env.PLATFORM_SECRET || ""; // パートナーAPI共有キー（x-partner-key）。未設定なら連携は無効
const PARTNER_HOOK_URL = process.env.PARTNER_HOOK_URL || "https://smilemedi-cloud-web.vercel.app/api/hooks/migiude"; // 受信イベントの転送先
const PARTNER_BOOKING_URL = process.env.PARTNER_BOOKING_URL || "https://smilemedi-cloud-web.vercel.app/api/partner/booking"; // AI下書き前の予約照会
const PARTNER_BASE = PARTNER_BOOKING_URL.replace(/\/booking$/, ""); // うけつけるんパートナーAPIのベース（/api/partner）
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || process.env.APP_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? "https://" + process.env.RAILWAY_PUBLIC_DOMAIN : "");
// Slackは共通AppのOAuthで法人ごとに通知先を選ぶ。未設定環境では従来Webhook入力をフォールバックとして残す。
const SLACK_OAUTH = {
  clientId: process.env.SLACK_CLIENT_ID || "",
  clientSecret: process.env.SLACK_CLIENT_SECRET || "",
  stateSecret: process.env.SLACK_OAUTH_STATE_SECRET || "",
  signingSecret: process.env.SLACK_SIGNING_SECRET || ""
};
// パスワード再設定メールは患者対応用メールとは分離できる。未設定時だけ当該テナントのSMTPへ後方互換フォールバック。
const RESET_SMTP = {
  host: process.env.RESET_SMTP_HOST || "smtp.gmail.com",
  port: +(process.env.RESET_SMTP_PORT || 465),
  user: process.env.RESET_SMTP_USER || "",
  pass: process.env.RESET_SMTP_PASS || "",
  from: process.env.RESET_SMTP_FROM || process.env.RESET_SMTP_USER || ""
};

// ---------- Postgres ----------
let pool = null;
if (process.env.DATABASE_URL) {
  try { const { Pool } = require("pg"); pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false, max: 6 }); }
  catch (e) { console.error("pg init failed:", e.message); pool = null; }
}

// ---------- tenant model ----------
// TEN: slug -> t = { slug, name, config, store:{}, rules:{}, ruleSeq, alerts:[], alertSeq, push:{} }
// t.config（tenantsテーブルのjsonbに永続化）:
//   passHash, loginId, accountEmail, passwordReset:{hash,exp}, conn:{lineToken,lineSecret,smtp*,imap*,emailInternal,lines[],mails[],seenIds,mailCutoff,lineBotId,lineName,mailName},
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
  if (typeof config.settings.bookingActions !== "boolean") config.settings.bookingActions = false; // 予約自動受付（うけつけるん連携でのキャンセル・変更・LINE連携）。既定OFF
  if (typeof config.settings.slackEnabled !== "boolean") config.settings.slackEnabled = false; // 要対応のSlack通知。右腕くん単体で完結
  if (!["review_all", "exceptions"].includes(config.settings.slackReplyMode)) config.settings.slackReplyMode = "exceptions";
  return { slug, name: name || slug, config, store: {}, rules: {}, ruleSeq: 1, examples: {}, exampleSeq: 1, alerts: [], alertSeq: 1, push: {} };
}
async function saveTenantConfig(t) {
  try { encryptConnSecrets(t.config.conn); } catch (e) { console.error("encryptConnSecrets:", e.message); } // 保存直前にメール/LINE資格情報を暗号化（CRED_KEY未設定なら平文のまま）
  if (pool) await pool.query("UPDATE tenants SET name=$2, config=$3 WHERE slug=$1", [t.slug, t.name, t.config]);
}

// ===== 自動化ダッシュボード用の日次カウンタ（受信トレイ上部の帯に使う） =====
// in=患者からの受信数 / auto=AIが自動送信した返信数 / staff=スタッフが送信した返信数 / rules=学習・更新した店舗ルール数
function statBump(t, key, n) {
  try {
    const day = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });
    const all = (t.config.statsDaily = t.config.statsDaily || {});
    const d = (all[day] = all[day] || {});
    d[key] = (d[key] || 0) + (n || 1);
    const keys = Object.keys(all).sort();
    while (keys.length > 60) delete all[keys.shift()]; // 直近60日だけ保持
    saveTenantConfig(t).catch(() => {});
  } catch (e) {}
}

// 接続設定アクセサ（テナントは全てUIで設定する。環境変数へのフォールバックは無し。ホスト/ポートのみGmail既定値）
function cf(t, k) { const v = t.config.conn[k]; return v == null ? "" : String(v); }
// 資格情報フィールドは decField 経由で読む（enc:v1: なら復号、平文ならそのまま）。ホスト/ユーザー/ポートは平文のまま。
function cfSec(t, k) { return decField(cf(t, k)); }
const C = {
  lineToken: (t) => cfSec(t, "lineToken"),
  lineSecret: (t) => cfSec(t, "lineSecret"),
  smtpHost: (t) => cf(t, "smtpHost") || "smtp.gmail.com",
  smtpPort: (t) => +(cf(t, "smtpPort") || 465),
  smtpUser: (t) => cf(t, "smtpUser"),
  smtpPass: (t) => cfSec(t, "smtpPass"),
  imapHost: (t) => cf(t, "imapHost") || "imap.gmail.com",
  imapPort: (t) => +(cf(t, "imapPort") || 993),
  imapUser: (t) => cf(t, "imapUser") || cf(t, "smtpUser"),
  imapPass: (t) => cfSec(t, "imapPass") || cfSec(t, "smtpPass"),
  slackWebhook: (t) => cfSec(t, "slackWebhook"),
  slackBotToken: (t) => cfSec(t, "slackBotToken"),
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
  if (!pool || !c) return Promise.resolve(false);
  return pool.query("INSERT INTO convos (tenant,id,ts,data) VALUES ($1,$2,$3,$4) ON CONFLICT (tenant,id) DO UPDATE SET ts=EXCLUDED.ts, data=EXCLUDED.data",
    [t.slug, c.id, c.ts || 0, c]).then(() => true).catch(e => { console.error("dbSave:", e.message); return false; });
}

// ---------- 資格情報保護ヘルパー（後方互換最優先） ----------
// bcrypt（純JS実装。ネイティブビルド不要）。存在しない環境でも起動は止めない（下でnullフォールバック）。
let bcrypt = null;
try { bcrypt = require("bcryptjs"); } catch (e) { console.warn("bcryptjs 未インストール: パスワードは従来のSHA-256のまま動作します（ログインは壊れません）"); }
const BCRYPT_COST = 10;
function isBcrypt(s) { return typeof s === "string" && /^\$2[aby]\$/.test(s); }
function hashPassword(plain) { // 新規/変更時のハッシュ生成。bcryptが無ければ従来SHA-256にフォールバック
  if (bcrypt) { try { return bcrypt.hashSync(String(plain), BCRYPT_COST); } catch (e) { console.error("bcrypt hash:", e.message); } }
  return sha(String(plain));
}
// ログイン照合。bcrypt形式ならbcrypt.compare、そうでなければ従来 sha(input)===stored。
// 従来ハッシュで一致した場合、呼び出し側が lazy migration できるよう { ok, legacy } を返す。
function verifyPassword(input, stored) {
  input = String(input == null ? "" : input);
  stored = String(stored == null ? "" : stored);
  if (!stored) return { ok: false, legacy: false };
  if (isBcrypt(stored)) {
    let ok = false; try { ok = bcrypt && bcrypt.compareSync(input, stored); } catch (e) { ok = false; }
    return { ok: !!ok, legacy: false };
  }
  // 従来: 無塩SHA-256の定数時間比較
  const ok = safeEq(sha(input), stored);
  return { ok, legacy: ok }; // legacy=true のとき、成功していればbcryptへ再ハッシュして保存する（lazy migration）
}
// ===== メール/LINE資格情報の at-rest 暗号化（AES-256-GCM） =====
// CRED_KEY（32バイト鍵。hex64桁 または base64）。未設定なら暗号化はスキップ＝平文動作（起動は止めない）。
const CRED_KEY = (function () {
  const raw = String(process.env.CRED_KEY || "").trim();
  if (!raw) return null;
  try {
    let buf = null;
    if (/^[0-9a-fA-F]{64}$/.test(raw)) buf = Buffer.from(raw, "hex");
    else { const b = Buffer.from(raw, "base64"); if (b.length === 32) buf = b; }
    if (buf && buf.length === 32) return buf;
    console.warn("CRED_KEY が32バイト(hex64/base64)ではありません: メール/LINE資格情報の暗号化は無効（平文動作）");
    return null;
  } catch (e) { console.warn("CRED_KEY の解釈に失敗: 暗号化は無効（平文動作）"); return null; }
})();
const ENC_PREFIX = "enc:v1:";
// 平文 -> "enc:v1:"+base64(iv(12)|tag(16)|ciphertext)。CRED_KEY未設定なら平文そのまま返す（後方互換）。
function encField(plain) {
  if (plain == null) return plain;
  const s = String(plain);
  if (!s) return s;                       // 空文字はそのまま
  if (!CRED_KEY) return s;                // 鍵なし=平文動作
  if (s.startsWith(ENC_PREFIX)) return s; // 既に暗号化済みは二重暗号化しない
  try {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", CRED_KEY, iv);
    const ct = Buffer.concat([cipher.update(s, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return ENC_PREFIX + Buffer.concat([iv, tag, ct]).toString("base64");
  } catch (e) { console.error("encField:", e.message); return s; } // 失敗時は平文で保存（動作継続）
}
// "enc:v1:..." なら復号、無ければ平文とみなしそのまま返す（後方互換: 既存の平文値も読める）。
function decField(stored) {
  if (stored == null) return stored;
  const s = String(stored);
  if (!s.startsWith(ENC_PREFIX)) return s; // 平文フォールバック
  if (!CRED_KEY) { console.error("decField: 暗号化された値があるがCRED_KEY未設定"); return ""; }
  try {
    const buf = Buffer.from(s.slice(ENC_PREFIX.length), "base64");
    const iv = buf.subarray(0, 12), tag = buf.subarray(12, 28), ct = buf.subarray(28);
    const decipher = crypto.createDecipheriv("aes-256-gcm", CRED_KEY, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  } catch (e) { console.error("decField:", e.message); return ""; }
}
// conn配下の資格情報フィールドを保存直前に暗号化する（メイン＋追加アカウント lines[]/mails[]）。冪等（enc:済みは再暗号化しない）。
const ENC_CONN_KEYS = ["lineToken", "lineSecret", "smtpPass", "imapPass", "slackWebhook", "slackBotToken"];
function encryptConnSecrets(conn) {
  if (!conn || typeof conn !== "object" || !CRED_KEY) return; // 鍵なしなら平文のまま（後方互換）
  ENC_CONN_KEYS.forEach(k => { if (typeof conn[k] === "string" && conn[k]) conn[k] = encField(conn[k]); });
  if (Array.isArray(conn.lines)) conn.lines.forEach(a => { if (a) { if (a.token) a.token = encField(a.token); if (a.secret) a.secret = encField(a.secret); } });
  if (Array.isArray(conn.mails)) conn.mails.forEach(a => { if (a) { if (a.smtpPass) a.smtpPass = encField(a.smtpPass); if (a.imapPass) a.imapPass = encField(a.imapPass); } });
}

// ===== Slack要対応通知（右腕くん単体で完結） =====
// Incoming Webhook URLはテナント設定へ暗号化保存し、APIレスポンス・ログへ値を出さない。
function validSlackWebhook(value) {
  try {
    const u = new URL(String(value || "").trim());
    return u.protocol === "https:" && u.hostname === "hooks.slack.com" && /^\/services\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/.test(u.pathname);
  } catch (e) { return false; }
}
function slackOAuthReady() { return !!(SLACK_OAUTH.clientId && SLACK_OAUTH.clientSecret && SLACK_OAUTH.stateSecret && SLACK_OAUTH.signingSecret && /^https:\/\//i.test(PUBLIC_BASE_URL)); }
function b64url(value) { return Buffer.from(value).toString("base64url"); }
function slackStateSignature(payload) { return crypto.createHmac("sha256", SLACK_OAUTH.stateSecret).update(payload).digest("base64url"); }
function issueSlackState(req, t) {
  const body = b64url(JSON.stringify({ slug: t.slug, session: sha(cookies(req).sess || ""), exp: Date.now() + 10 * 60 * 1000, nonce: crypto.randomBytes(16).toString("hex") }));
  return body + "." + slackStateSignature(body);
}
function verifySlackState(req, value) {
  if (!slackOAuthReady()) return null;
  const parts = String(value || "").split(".");
  if (parts.length !== 2 || !safeEq(parts[1], slackStateSignature(parts[0]))) return null;
  let data; try { data = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")); } catch (e) { return null; }
  const t = tenantFromReq(req);
  if (!t || data.slug !== t.slug || data.exp < Date.now() || !safeEq(data.session, sha(cookies(req).sess || ""))) return null;
  return t;
}
function publicConversationUrl(c) {
  const base = String(PUBLIC_BASE_URL || "").trim().replace(/\/$/, "");
  if (!/^https:\/\//i.test(base)) return "";
  return base + "/?conv=" + encodeURIComponent(c.id);
}
async function postSlackWebhook(webhook, payload) {
  if (!validSlackWebhook(webhook)) return { ok: false, error: "invalid_webhook" };
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => { try { ctrl.abort(); } catch (e) {} }, 8000);
    let r;
    try { r = await fetch(webhook, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload), signal: ctrl.signal }); }
    finally { clearTimeout(timer); }
    return r && r.ok ? { ok: true } : { ok: false, error: "slack_http_error" };
  } catch (e) { return { ok: false, error: "slack_unreachable" }; }
}
function slackReviewAll(t) {
  return !!(S(t).autoReply && S(t).slackEnabled && S(t).slackReplyMode === "review_all");
}
async function slackApi(t, method, body) {
  const token = C.slackBotToken(t);
  if (!token) return { ok: false, error: "no_bot_token" };
  try {
    const r = await fetch("https://slack.com/api/" + method, { method: "POST", headers: { "Authorization": "Bearer " + token, "Content-Type": "application/json; charset=utf-8" }, body: JSON.stringify(body || {}) });
    const j = await r.json();
    return r.ok && j.ok ? j : { ok: false, error: (j && j.error) || "slack_api_error" };
  } catch (e) { return { ok: false, error: "slack_unreachable" }; }
}
function slackApprovalById(id) {
  for (const t of Object.values(TEN)) for (const c of Object.values(t.store || {})) {
    if (c && c.slackApproval && c.slackApproval.id === id) return { t, c, approval: c.slackApproval };
  }
  return null;
}
function slackApprovalByThread(teamId, channelId, threadTs) {
  for (const t of Object.values(TEN)) {
    if (String(t.config.conn.slackTeamId || "") !== String(teamId || "")) continue;
    for (const c of Object.values(t.store || {})) {
      const a = c && c.slackApproval;
      if (a && a.status === "pending" && a.channelId === channelId && a.threadTs === threadTs) return { t, c, approval: a };
    }
  }
  return null;
}
function slackHistoryText(c) {
  return (c.msgs || []).slice(-10).map(m => (m.from === "them" ? "患者" : "スタッフ") + ": " + String(m.text || (m.media ? "［" + m.media + "］" : "")).slice(0, 500)).join("\n");
}
function slackMrkdwn(value) { return String(value || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
async function slackSummary(t, c) {
  const history = slackHistoryText(c);
  if (!history) return "新しい問い合わせです。";
  try {
    const out = await aiChat(t, "患者との会話をスタッフが30秒で把握できるよう、事実だけを日本語で3文以内に要約する。医療判断や推測はしない。患者への返信文は書かない。", [{ role: "user", content: history }], 300);
    if (out) return String(out).trim().slice(0, 1200);
  } catch (e) {}
  return history.slice(-1200);
}
function slackApprovalBlocks(c, summary, draft, reason, id) {
  const safeSummary = slackMrkdwn(String(summary || "").slice(0, 2800)), safeDraft = slackMrkdwn(String(draft || "").slice(0, 2800));
  return [
    { type: "header", text: { type: "plain_text", text: "右腕くん：返信の確認", emoji: true } },
    { type: "section", text: { type: "mrkdwn", text: "*お客様:* " + slackMrkdwn(String(c.name || "名称未取得").slice(0, 120)) + "（" + (c.channel === "mail" ? "メール" : "LINE") + "）\n*確認理由:* " + slackMrkdwn(String(reason || "送信前の確認").slice(0, 300)) } },
    { type: "section", text: { type: "mrkdwn", text: "*これまでのやり取り:*\n" + safeSummary } },
    { type: "section", text: { type: "mrkdwn", text: "*患者様への返信案:*\n```" + safeDraft.replace(/```/g, "'''") + "```" } },
    { type: "actions", elements: [
      { type: "button", action_id: "migiude_send", text: { type: "plain_text", text: "この内容で送信", emoji: true }, style: "primary", value: id },
      { type: "button", action_id: "migiude_info", text: { type: "plain_text", text: "患者・予約情報を確認", emoji: true }, value: id },
      { type: "button", action_id: "migiude_cancel", text: { type: "plain_text", text: "今回は送信しない", emoji: true }, style: "danger", value: id }
    ] },
    { type: "context", elements: [{ type: "mrkdwn", text: "修正する場合は、このメッセージのスレッドへ「もう少し柔らかく」などと返信してください。最終送信には必ず上の承認ボタンが必要です。" }] }
  ];
}
async function slackRequestApproval(t, c, reason) {
  const draft = String(c && c.draft || "").trim();
  const channel = String(t.config.conn.slackChannelId || "");
  if (!S(t).slackEnabled || !draft || !channel || !C.slackBotToken(t)) return false;
  const latest = (c.msgs || []).slice().reverse().find(m => m && m.from === "them") || {};
  const eventKey = sha([c.id, latest.time || "", latest.text || "", draft].join("|"));
  if (c.slackApproval && c.slackApproval.eventKey === eventKey && c.slackApproval.status === "pending") return true;
  const id = crypto.randomBytes(18).toString("hex");
  const summary = await slackSummary(t, c);
  const blocks = slackApprovalBlocks(c, summary, draft, reason, id);
  const r = await slackApi(t, "chat.postMessage", { channel, text: "右腕くん：" + (c.name || "お客様") + "への返信確認", blocks });
  if (!r.ok || !r.ts) return false;
  c.slackApproval = { id, eventKey, draft, draftHash: sha(draft), status: "pending", createdAt: Date.now(), expiresAt: Date.now() + 24 * 60 * 60 * 1000, channelId: channel, threadTs: String(r.ts) };
  c.status = "todo"; c.flag = true; dbSave(t, c);
  return true;
}
async function slackReviseDraft(t, c, instruction) {
  const history = slackHistoryText(c);
  let booking = ""; try { booking = await fetchBooking(t, c); } catch (e) {}
  const sys = "あなたは店舗の受付スタッフ。会話、現在の返信案、スタッフの修正指示を踏まえ、患者へ送る返信本文だけを作る。医療判断や情報の推測はしない。" + (booking ? "\n予約システムの確認結果:\n" + booking : "");
  const content = "会話:\n" + history + "\n\n現在の返信案:\n" + String(c.draft || "") + "\n\nスタッフの修正指示:\n" + String(instruction || "").slice(0, 1200);
  const out = await aiChat(t, sys, [{ role: "user", content }], 1800);
  return String(out || "").trim();
}
async function slackUpdateApproval(t, channel, ts, text) {
  return slackApi(t, "chat.update", { channel, ts, text, blocks: [{ type: "section", text: { type: "mrkdwn", text } }] });
}
const slackInFlight = new Set();
async function slackEscalate(t, c, reason) {
  const webhook = C.slackWebhook(t);
  if (!S(t).slackEnabled || !validSlackWebhook(webhook) || !c) return false;
  const incoming = (c.msgs || []).slice().reverse().find(m => m && m.from === "them") || {};
  const eventKey = sha([c.id, incoming.time || "", incoming.text || "", incoming.media || ""].join("|"));
  if (c.slackLastEventKey === eventKey || slackInFlight.has(t.slug + ":" + eventKey)) return false;
  const lockKey = t.slug + ":" + eventKey;
  slackInFlight.add(lockKey);
  const link = publicConversationUrl(c);
  const channel = c.channel === "mail" ? "メール" : "LINE";
  const latest = String(incoming.text || (incoming.media ? "［" + incoming.media + "］" : "新着メッセージ")).slice(0, 700);
  const title = "🙋 右腕くんでスタッフ対応が必要です";
  const lines = [
    "*" + title + "*",
    "*店舗:* " + String(t.name || t.slug).slice(0, 120),
    "*お客様:* " + String(c.name || "名称未取得").slice(0, 120) + "（" + channel + "）",
    "*理由:* " + String(reason || "AIが要対応と判定").slice(0, 200),
    "*最新メッセージ:*\n" + latest
  ];
  if (link) lines.push("*右腕くんで開く:* " + link);
  const result = await postSlackWebhook(webhook, { text: title + "\n" + lines.slice(1).join("\n") });
  slackInFlight.delete(lockKey);
  if (!result.ok) return false;
  c.slackLastEventKey = eventKey;
  c.slackLastNotifiedAt = Date.now();
  dbSave(t, c);
  return true;
}

// ---------- auth（旧platform方式: セッションcookie sess=base64(slug).token） ----------
function sha(s) { return crypto.createHash("sha256").update(s).digest("hex"); }
function cookies(req) { const o = {}; (req.headers.cookie || "").split(";").forEach(p => { const i = p.indexOf("="); if (i > 0) o[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); }); return o; }
// ===== ログインのブルートフォース保護（単一プロセスのExpressなのでモジュール内Mapで確実に効く）=====
// key = ip+"|"+loginId。直近15分で10回失敗したら15分ロック。
const LOGIN_FAIL_WINDOW_MS = 15 * 60 * 1000, LOGIN_FAIL_MAX = 10;
const loginFails = new Map(); // key -> { fails:number[], lockedUntil:number }
function loginLocked(key) {
  const e = loginFails.get(key);
  if (!e) return false;
  if (e.lockedUntil && Date.now() < e.lockedUntil) return true;
  return false;
}
function loginFail(key) {
  const now = Date.now();
  const e = loginFails.get(key) || { fails: [], lockedUntil: 0 };
  e.fails = e.fails.filter(t => now - t < LOGIN_FAIL_WINDOW_MS);
  e.fails.push(now);
  if (e.fails.length >= LOGIN_FAIL_MAX) e.lockedUntil = now + LOGIN_FAIL_WINDOW_MS;
  loginFails.set(key, e);
}
function loginReset(key) { loginFails.delete(key); }
// 旧: 決定的トークン（失効不可）。後方互換フォールバックのため照合ロジックだけ残す。
// TODO: 次リリースで決定的トークンのフォールバック（legacySessToken / tenantFromReq内のlegacy判定）を削除する。
function legacySessToken(slug, passHash) { return sha("sess|" + slug + "|" + passHash); }
// ===== 新: ランダムなセッションID方式（失効可・有効期限あり）。jsonb config内に保持しスキーマ変更を回避 =====
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30日
function sessions(t) { // t.config.sessions = { [tokenHash]: { created, exp, ua } }
  if (!t.config.sessions || typeof t.config.sessions !== "object") t.config.sessions = {};
  return t.config.sessions;
}
function pruneSessions(t) { // 期限切れを掃除。件数上限で古いものから破棄（暴走防止）
  const s = sessions(t); const now = Date.now();
  for (const h of Object.keys(s)) { const e = s[h]; if (!e || !e.exp || e.exp < now) delete s[h]; }
  const keys = Object.keys(s);
  if (keys.length > 50) { keys.sort((a, b) => (s[a].created || 0) - (s[b].created || 0)); while (Object.keys(s).length > 50) delete s[keys.shift()]; }
}
// 新規セッション発行: ランダム32バイト→cookieには生トークン、DBにはそのハッシュを保存。cookie文字列を返す。
function issueSession(t, ua) {
  const raw = crypto.randomBytes(32).toString("hex");
  const h = sha(raw);
  const s = sessions(t);
  s[h] = { created: Date.now(), exp: Date.now() + SESSION_TTL_MS, ua: String(ua || "").slice(0, 200) };
  pruneSessions(t);
  saveTenantConfig(t).catch(() => {}); // セッション集合を永続化（fire-and-forget）
  return raw;
}
function destroyAllSessions(t) { t.config.sessions = {}; saveTenantConfig(t).catch(() => {}); }
function setSess(res, t) {
  const raw = issueSession(t, res.req && res.req.headers && res.req.headers["user-agent"]);
  res.set("Set-Cookie", "sess=" + Buffer.from(t.slug).toString("base64") + "." + raw + "; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000");
}
function tenantFromReq(req) {
  const sess = cookies(req).sess || "";
  const dot = sess.lastIndexOf(".");
  if (dot < 1) return null;
  let slug; try { slug = Buffer.from(sess.slice(0, dot), "base64").toString("utf8"); } catch (e) { return null; }
  const tok = sess.slice(dot + 1);
  const t = TEN[slug];
  if (!t || !t.config.passHash) return null;
  if (t.config.suspended) return null; // 運営側で停止中
  // 新方式: 送られたトークンのハッシュがテナントのセッション集合に存在し、かつ未失効か
  const s = sessions(t); const h = sha(tok); const e = s[h];
  if (e) {
    if (e.exp && e.exp < Date.now()) { delete s[h]; saveTenantConfig(t).catch(() => {}); return null; } // 失効
    return t;
  }
  // 後方互換フォールバック: 旧決定的トークン（本番の突然のログアウトを避けるため当面受理）。TODO: 次リリースで削除。
  if (safeEq(tok, legacySessToken(slug, t.config.passHash))) return t;
  return null;
}
function guard(req, res, next) { const t = tenantFromReq(req); if (!t) return res.status(401).json({ error: "auth" }); req.tenant = t; next(); }
function slugify(name) { const base = String(name || "clinic").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 20) || "clinic"; return base + "-" + crypto.randomBytes(2).toString("hex"); }

function loginIdTaken(id, exceptSlug){
  return Object.values(TEN).some(x => x.slug !== exceptSlug && ((x.config.loginId || x.slug) === id));
}
function normalizeEmail(value){
  const email = String(value || "").trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : "";
}
function tenantAccount(t){
  return {
    name: t.name || t.slug,
    loginId: t.config.loginId || t.slug,
    accountEmail: normalizeEmail(t.config.accountEmail),
    resetEmailReady: !!(RESET_SMTP.user && RESET_SMTP.pass) || mailAccounts(t).length > 0
  };
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
  const config = { passHash: hashPassword(pass), loginId, conn: {}, settings: { autoReply: false, level: "high", tone: "" } };
  const t = TEN[slug] = newTenant(slug, name, config);
  if (pool) { try { await pool.query("INSERT INTO tenants (slug,name,config) VALUES ($1,$2,$3)", [slug, name, t.config]); } catch (e) { delete TEN[slug]; return res.status(500).json({ ok: false, error: "db" }); } }
  seedTenant(t); // 本番と同様、新規テナントにはデモ会話を入れて空っぽにしない
  setSess(res, t);
  res.json({ ok: true, slug });
});
app.post("/api/login", async (req, res) => {
  const loginId = String(req.body.loginId || req.body.company || "").trim();
  const pass = String(req.body.password || "");
  // ブルートフォース保護: ip+loginId 単位で失敗を数え、直近15分で10回失敗したら15分ロック。
  const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";
  const flKey = ip + "|" + loginId;
  if (loginLocked(flKey)) return res.status(429).json({ ok: false, error: "too_many" });
  // ログインIDでマッチ（未設定テナントはslugがID代わり）。パスワード照合は bcrypt/legacy 両対応の verifyPassword。
  const cand = Object.values(TEN).find(x => (x.config.loginId || x.slug) === loginId && x.config.passHash);
  const vr = cand ? verifyPassword(pass, cand.config.passHash) : { ok: false, legacy: false };
  const t = vr.ok ? cand : null;
  if (!t) { loginFail(flKey); return res.status(401).json({ ok: false }); }
  loginReset(flKey);
  if (t.config.suspended) return res.status(403).json({ ok: false, error: "suspended" });
  if (vr.legacy) { try { t.config.passHash = hashPassword(pass); await saveTenantConfig(t); } catch (e) { console.error("lazy-migrate:", e.message); } } // 従来SHA-256で成功→bcryptへ自動移行
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
app.get("/api/account", guard, (req, res) => res.json(tenantAccount(req.tenant)));
app.post("/api/account", guard, async (req, res) => {
  const t = req.tenant;
  const email = normalizeEmail(req.body.accountEmail);
  if (!email) return res.status(400).json({ ok:false, error:"bad_email" });
  t.config.accountEmail = email;
  try { await saveTenantConfig(t); }
  catch (e) { return res.status(500).json({ ok:false, error:"save" }); }
  res.json({ ok:true, account:tenantAccount(t) });
});
app.post("/api/logout", (req, res) => {
  // このcookieのセッションだけをサーバ側集合から破棄（他端末のログインは維持）
  try {
    const sess = cookies(req).sess || ""; const dot = sess.lastIndexOf(".");
    if (dot > 0) { const slug = Buffer.from(sess.slice(0, dot), "base64").toString("utf8"); const t = TEN[slug]; if (t) { const h = sha(sess.slice(dot + 1)); if (sessions(t)[h]) { delete sessions(t)[h]; saveTenantConfig(t).catch(() => {}); } } }
  } catch (e) {}
  res.set("Set-Cookie", "sess=; Path=/; HttpOnly; Max-Age=0"); res.json({ ok: true });
});
app.post("/api/change-pass", guard, async (req, res) => {
  const t = req.tenant;
  const cur = String(req.body.current || ""), next = String(req.body.next || "");
  if (!verifyPassword(cur, t.config.passHash).ok) return res.status(401).json({ ok: false, error: "wrong_current" });
  if (next.length < 8) return res.status(400).json({ ok: false, error: "too_short" });
  t.config.passHash = hashPassword(next);
  destroyAllSessions(t); // パスワード変更で既存セッションを全破棄
  try { await saveTenantConfig(t); } catch (e) { return res.status(500).json({ ok: false, error: "save" }); }
  setSess(res, t); // 変更した本人には新しいセッションを発行し直す
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
// ===== ルール蒸留（自動ナレッジ化） =====
// スタッフの返信・編集チャットの指示から「他の患者への返信にも再利用できる事実・規定」を抽出し、店舗ルールへ自動登録する。
// 対応例（参考扱い）と違い、店舗ルールは生成時に最優先で従う知識なので、一度学習した内容は言い回しが違う質問にも効く。
// 既存ルールと照合して add / update / skip を判定し、重複登録・古い内容の放置を防ぐ。
async function distillRules(t, c, opts) {
  try {
    const q = String((opts && opts.q) || "").slice(0, 800);
    const finalText = String((opts && opts.final) || "").slice(0, 1500);
    if (!finalText) return [];
    const related = rulesSearch(t, q + " " + finalText, 8);
    const relatedTxt = related.length ? related.map(r => "[ID:" + r.id + "] " + r.title + ": " + String(r.content).slice(0, 200)).join("\n") : "（関連ルールなし）";
    const instrTxt = String((opts && opts.instr) || "").slice(0, 800);
    const notesTxt = notesBlock(c);
    const sys = "あなたはクリニック受付のナレッジ管理者。スタッフが患者に送った返信と、その作成時の指示から、『他の患者への返信にもそのまま再利用できる、店舗の事実・規定・方針』だけを抽出してルール化する。"
      + "\n抽出してよいもの: 料金・所要時間・可否（できる/できない）・場所・アクセス・持ち物・営業/受付時間・支払い方法・案内先（URL/窓口）・手順・キャンセルや変更の規定など、誰に聞かれても毎回同じ答えになる情報。"
      + "\n絶対に抽出しないもの: この患者固有の事情（氏名・個別の予約日時・体調・経過）、今回限りの特別対応、推測やあいまいな内容、挨拶・言い回しだけの違い。"
      + "\n既存ルールと同じ趣旨で内容も同じ → 出力しない。同じ趣旨だが内容が変わった/正確になった → そのルールIDへの update（本文全体を書き直す）。既存に無い新しい事実 → add。"
      + "\n出力は必ず次のJSONのみ: {\"rules\":[{\"action\":\"add|update\",\"targetId\":数値またはnull,\"title\":\"短い見出し（例: 駐車場）\",\"content\":\"事実を簡潔に（です・ます不要）\"}]}"
      + "\n抽出できる確実な事実が無ければ {\"rules\":[]}。最大2件。迷ったら出力しない。";
    const u = "【患者の問い合わせ】\n" + (q || "（なし）")
      + "\n\n【スタッフが実際に送った返信】\n" + finalText
      + (instrTxt ? "\n\n【スタッフが返信作成時に出した指示（ここに事実が含まれることが多い）】\n" + instrTxt : "")
      + (notesTxt ? "\n\n【この会話でのスタッフ指示メモ】\n" + notesTxt : "")
      + "\n\n【既存の関連ルール】\n" + relatedTxt;
    const raw = await aiChat(t, sys, [{ role: "user", content: u }], 1500);
    if (!raw) return [];
    let out = null; try { const m = raw.match(/\{[\s\S]*\}/); out = JSON.parse(m ? m[0] : raw); } catch (e) { console.error("distillRules parse:", String(raw).slice(0, 120)); return []; }
    const items = (Array.isArray(out && out.rules) ? out.rules : []).slice(0, 2);
    const applied = [];
    for (const it of items) {
      const title = String((it && it.title) || "").trim().slice(0, 100);
      const content = String((it && it.content) || "").trim().slice(0, 1000);
      if (!title || !content) continue;
      // update はAIに提示した関連ルールのIDに限定（幻覚IDで無関係なルールを上書きしない）
      const tid = Number(it.targetId);
      if (it.action === "update" && it.targetId != null && related.some((r) => r.id === tid) && t.rules[tid]) {
        const r = await ruleUpdate(t, tid, title, content);
        if (r) applied.push({ action: "update", id: r.id, title });
      } else if (it.action === "add" || it.action === "update") { // 対象不明のupdateはaddに降格（重複ガードで弾かれ得る）
        // 二重登録ガード（AIが既存を見落とした場合の保険）：ほぼ同文のルールがあれば登録しない
        const dup = rulesSearch(t, title + " " + content, 1)[0];
        if (dup && similarEnough(dup.title + dup.content, title + content)) continue;
        const r = await ruleAdd(t, title, content);
        if (r) applied.push({ action: "add", id: r.id, title });
      }
    }
    if (applied.length) statBump(t, "rules", applied.length);
    return applied;
  } catch (e) { console.error("distillRules:", e && e.message); return []; }
}
// 2つのテキストがほぼ同内容か（bigram重なり率）。ルールの二重登録ガード用。
function similarEnough(a, b) {
  const A = bigrams(a), B = bigrams(b);
  if (!A.size || !B.size) return false;
  let n = 0; A.forEach(x => { if (B.has(x)) n++; });
  return n / Math.min(A.size, B.size) > 0.8;
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

// aiChatのストリーミング版。onDelta(text片)を呼びながら全文を返す。（編集チャットのGPT風リアルタイム表示用）
// gpt/gemini はOpenAI互換SSE、Claude(保険)はAnthropic SSE。ストリーム不可ならnullを返し、呼び出し側がaiChatにフォールバックする。
async function aiChatStream(t, system, messages, maxTokens, onDelta){
  const eng = (S(t).engine || "gemini");
  async function openaiCompat(url, key, model, extra){
    const r = await fetch(url, { method:"POST",
      headers: { "Content-Type":"application/json", "Authorization":"Bearer "+key },
      body: JSON.stringify(Object.assign({ model, stream: true, messages: [{role:"system",content:system}].concat(messages) }, extra)) });
    if(!r.ok || !r.body){ console.error("stream:", r.status, (await r.text().catch(()=>"")).slice(0,200)); return null; }
    let full = "", buf = ""; const dec = new TextDecoder();
    for await (const chunk of r.body){
      buf += dec.decode(chunk, { stream: true });
      let i;
      while((i = buf.indexOf("\n")) >= 0){
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if(!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if(!data || data === "[DONE]") continue;
        try{ const d = JSON.parse(data); const tx = d.choices && d.choices[0] && d.choices[0].delta && d.choices[0].delta.content; if(tx){ full += tx; onDelta(tx); } }catch(e){}
      }
    }
    return full || null;
  }
  try{
    if(eng === "gpt" && process.env.OPENAI_KEY){
      const model = process.env.OPENAI_MODEL || "gpt-5.4";
      const out = await openaiCompat("https://api.openai.com/v1/chat/completions", process.env.OPENAI_KEY, model, { max_completion_tokens: maxTokens, reasoning_effort: "medium" });
      if(out) return out;
    }
    if(eng === "gemini" && process.env.GEMINI_KEY){
      const model = process.env.GEMINI_MODEL || "gemini-3-flash";
      const out = await openaiCompat("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", process.env.GEMINI_KEY, model, { max_tokens: maxTokens, reasoning_effort: "medium" });
      if(out) return out;
    }
    if(ANTHROPIC_KEY){
      const r = await fetch("https://api.anthropic.com/v1/messages", { method:"POST",
        headers: { "Content-Type":"application/json", "x-api-key":ANTHROPIC_KEY, "anthropic-version":"2023-06-01" },
        body: JSON.stringify({ model:"claude-sonnet-4-6", max_tokens:maxTokens, system, messages, stream: true }) });
      if(!r.ok || !r.body) return null;
      let full = "", buf = ""; const dec = new TextDecoder();
      for await (const chunk of r.body){
        buf += dec.decode(chunk, { stream: true });
        let i;
        while((i = buf.indexOf("\n")) >= 0){
          const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
          if(!line.startsWith("data:")) continue;
          try{ const d = JSON.parse(line.slice(5).trim()); const tx = d.type === "content_block_delta" && d.delta && d.delta.text; if(tx){ full += tx; onDelta(tx); } }catch(e){}
        }
      }
      return full || null;
    }
  }catch(e){ console.error("aiChatStream:", e.message); }
  return null;
}

// このお客様への対応でスタッフが出した指示のメモ（会話オブジェクトに保存 → 以後の自動生成にも反映）
function noteAdd(c, txt){
  txt = String(txt || "").trim().slice(0, 300);
  if(!txt || txt.length < 4) return;
  c.aiNotes = Array.isArray(c.aiNotes) ? c.aiNotes : [];
  if(c.aiNotes.includes(txt)) return;
  c.aiNotes.push(txt);
  while(c.aiNotes.length > 12) c.aiNotes.shift();
}
function notesBlock(c){
  const a = Array.isArray(c && c.aiNotes) ? c.aiNotes : [];
  return a.length ? a.slice(-8).map(s => "・" + s).join("\n") : "";
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

// ===== 予約自動受付（うけつけるん連携）: 本人確認＋二段階承認つきで予約の確認・キャンセル・変更・LINE連携を自動処理 =====
// 設計: うけつけるん側 POST /api/partner/appointment-actions が本人確認・確認待ち依頼(30分期限)・実行時再検証まで持つ。
// 右腕くん側は (1) 会話から操作意図をAIが抽出(action) → propose → 確認文を送る、
//              (2) 次の患者返信が明確な「はい/いいえ」のときだけ confirm → 結果文を送る、の2段階のみ。
// 曖昧な返信では絶対に実行しない。確認文・結果文はうけつけるん生成の定型文をそのまま送る（AIが改変しない）。
const BA_URL = PARTNER_BASE + "/appointment-actions";
function baEnabled(t) { return !!S(t).bookingActions; }
async function baCall(t, c, action, extra, timeoutMs) {
  try {
    if (!PARTNER_KEY) return null;
    const body = Object.assign({ action, slug: t.slug, channel: c.channel === "mail" ? "mail" : "line", userId: c.userId }, extra || {});
    if (body.phone == null && c.ba && c.ba.phone) body.phone = c.ba.phone; // メールの本人確認済み電話番号を常に添付
    const ctrl = new AbortController();
    // 既定20秒: うけつけるん（Vercel）のコールドスタートは数秒〜十数秒かかることがある。
    // Webhookは受信時に200を返却済み（処理は非同期）なので、ここで待っても再送・重複は起きない。
    const timer = setTimeout(() => { try { ctrl.abort(); } catch (e) {} }, timeoutMs || 20000);
    let r;
    try { r = await fetch(BA_URL, { method: "POST", headers: { "Content-Type": "application/json", "x-partner-key": PARTNER_KEY }, body: JSON.stringify(body), signal: ctrl.signal }); }
    finally { clearTimeout(timer); }
    if (!r) return null;
    return await r.json().catch(() => null);
  } catch (e) { return null; }
}

// AI用のシステムプロンプト断片（本人確認の状態・予約一覧・actionの出し方）
function baPromptBlock(ctx) {
  if (!ctx || ctx.ok === false) return "";
  let s = "\n\n【予約自動受付（うけつけるん連携・最優先で従う）】\n";
  if (ctx.verified) {
    s += "本人確認: 済み（" + ((ctx.patient && ctx.patient.name) || "") + " 様 / 診察券番号 " + ((ctx.patient && ctx.patient.patientNo) || "") + "）\n";
    const list = Array.isArray(ctx.appointments) ? ctx.appointments : [];
    s += list.length
      ? "直近のご予約:\n" + list.map(a => "・[ID:" + a.id + "] " + a.label + "〜 " + a.menu + (a.location ? "＠" + a.location : "") + "（" + a.statusJa + (a.changeable ? "・変更/キャンセル可" : "・受付期限外につき変更不可") + "）" + (a.feeNote ? "※" + a.feeNote : "")).join("\n") + "\n"
      : "直近のご予約はありません。\n";
    s += "予約内容の案内はこの情報の範囲で答えてよい。「どこの医院・店舗か」を聞かれたら＠以降の拠点名で答える。拠点名の無い予約では「指定がない」等の言及はせず、拠点に触れずに答える（単一院の扱い）。キャンセル・日時変更は自分で完了を宣言せず、必ず action を出す（正式な確認文はシステムが送る）。\n";
  } else if (ctx.reason === "unavailable") {
    s += "本人確認: 不可（自動受付をご利用いただけないお客様）。予約に関する個人情報は一切伝えず、actionも一切出さない（typeは常にnone）。ご用件はクリニックへ直接お問い合わせいただくよう丁寧に案内する。理由の説明はしない。\n";
  } else if (ctx.reason === "not_linked") {
    s += "本人確認: 未（このLINEアカウントは患者台帳と未連携）。予約に関する個人情報（予約の有無・日時・氏名等）は一切伝えない。\n";
    s += "予約の確認・変更・キャンセルを希望されたら、ご本人確認のためご登録の電話番号とメールアドレスの2点を尋ねる。両方が会話に出そろったら action {type:\"link\", phone, email} を出す（連携の確認文はシステムが送る）。\n";
    s += "ただし、一度 link を試して一致しなかった電話番号・メールアドレスの組み合わせでは、再び link を出さない（同じ結果になるだけ）。患者が新しい番号・メールを出したときだけ再度 link を出す。直接予約ではなく外部の予約サービス・クーポンサイト経由のご予約は台帳に登録が無いことがあるため、その話が出たら link は出さず、ご予約のお名前と日時を伺って needs_human を true にする（スタッフが確認して対応する旨を伝える。特定のサービス名はこちらから挙げない）。\n";
  } else {
    s += "本人確認: 未（メールアドレスだけでは確認できない）。予約に関する個人情報は一切伝えない。\n";
    s += "予約の確認・変更・キャンセルを希望されたら、ご本人確認のためご登録の電話番号を尋ねる。番号が会話に出たら action {type:\"verify\", phone} を出す。\n";
  }
  s += "新規予約はここでは受け付けず、予約サイト " + (ctx.bookingUrl || "") + " を必ず案内する。\n";
  if (ctx.cancelFeePolicy) s += "クリニックの規定 → " + ctx.cancelFeePolicy + "。キャンセル・日時変更の話題でこの規定に該当し得る場合は必ず言及する。ここに無い金額・条件は推測せず「クリニックへお問い合わせください」と案内する。免除・除外やお支払い以外の対応（チケット消化等）は「そういう対応が可能な場合がある」ことの案内までに留め、適用をあなたが約束・確定しない（最終判断はスタッフ。needs_humanをtrueにしてスタッフから折り返す旨を伝える）。キャンセル料の支払いリンクはキャンセル確定時にシステムが自動送付するので、あなたはURLを書かない。\n";
  s += "actionの出し方（出力JSONの \"action\"。操作が不要なら {\"type\":\"none\"}）:\n"
    + "・キャンセル希望が明確 → {\"type\":\"cancel\",\"appointmentId\":\"上の[ID:…]\"}（対象が複数あり特定できなければ draft で質問し type:none）\n"
    + "・変更希望で日付＋時刻が具体的 → {\"type\":\"reschedule\",\"appointmentId\":\"ID\",\"newDateTime\":\"YYYY-MM-DDTHH:MM\"}（日本時間。「明日」「来週金曜」は本日から計算。過去日時は出さない）\n"
    + "・空き時間の質問・日付だけ決まった変更希望・条件付きの空き照会（「一番遅い時間」「18時以降で」「直近の土日」など） → {\"type\":\"slots\",\"appointmentId\":\"ID\",\"dates\":[\"YYYY-MM-DD\"]}（条件に合いそうな日付を本日基準・近い順に最大7つ。単日の質問なら1つ。結果はシステムが取得し、あなたが次の生成で条件に沿って答える）\n"
    + "・LINE連携（電話・メール2点がそろったら） → {\"type\":\"link\",\"phone\":\"…\",\"email\":\"…\"}\n"
    + "・メールの本人確認（電話番号が出たら） → {\"type\":\"verify\",\"phone\":\"…\"}\n"
    + "actionを出すとき、draftは短い繋ぎ文でよい（システムが正式な確認文・結果文を患者に送る）。";
  return s;
}

// 患者の返信が確認への明確な承認/拒否かを判定。まず厳格な定型一致、だめならAIで分類。曖昧は other（実行しない）。
async function classifyApproval(t, confirmText, text) {
  const s = String(text || "").trim().replace(/[\s　。．、，！!？?〜～ー・…]+/g, "");
  if (s && s.length <= 12) {
    if (/^(はい|ハイ|はーい|ok|ｏｋ|オッケー|オッケ|おけ|おねがいします|お願いします|それでおねがいします|それでお願いします|承認します|同意します|はいお願いします|はいおねがいします)$/i.test(s)) return "yes";
    if (/^(いいえ|いえ|いや|やめます|やめる|やめときます|やめておきます|しないでください|しないで|取り消さないでください|不要です|なしで|キャンセルしません)$/i.test(s)) return "no";
  }
  try {
    const sys = "あなたは分類器。患者に次の確認メッセージを送った直後の返信を分類する。確認メッセージ:「" + String(confirmText || "").slice(0, 300) + "」。返信がこの確認への明確な同意（実行してよい）なら yes、明確な拒否なら no、別の話題・条件の変更・曖昧・判断に迷う場合は other。必ず yes / no / other のうち1語だけを出力する。";
    const raw = await aiChat(t, sys, [{ role: "user", content: String(text || "").slice(0, 500) }], 10);
    const a = String(raw || "").toLowerCase();
    if (/\byes\b/.test(a)) return "yes";
    if (/\bno\b/.test(a)) return "no";
  } catch (e) {}
  return "other"; // 判定不能は実行しない側に倒す
}

// 定型文をそのまま患者へ送る（自動送信扱い）。送れたら会話を更新して true。
async function baDeliver(t, c, text) {
  const r = await deliverText(t, c, text);
  if (r && r.sent) {
    statBump(t, "auto");
    c.msgs.push({ from: "us", text, auto: true, time: nowt() });
    c.draft = ""; c.draft0 = ""; c.status = "done"; c.lastAuto = true;
    c.time = nowt(); c.ts = Date.now(); c.last = lastText(c); dbSave(t, c);
    try { notifyAll(t, "🤖 予約自動受付: " + (c.name || ""), String(text).slice(0, 90)); } catch (e) {}
    return true;
  }
  return false;
}

// 「スタッフが対応します」と患者へ案内したうえで、実際に要対応（フラグ付き）としてスタッフへ引き継ぐ。
// 案内だけして誰も見ない、を防ぐ（自動受付の行き止まりは必ずここを通す）。
async function baHandoff(t, c, text) {
  const lastUs = (c.msgs || []).slice().reverse().find(m => m && m.from === "us");
  const already = lastUs && lastUs.auto && String(lastUs.text || "").trim() === String(text || "").trim();
  if (!already) {
    const ok = await baDeliver(t, c, text);
    if (!ok) { c.draft = text; c.draft0 = text; }
  }
  c.status = "todo"; c.flag = true; c.time = nowt(); c.ts = Date.now(); dbSave(t, c);
  try { notifyAll(t, "🙋 予約自動受付: スタッフ対応に切替: " + (c.name || ""), (lastText(c) || "").slice(0, 90)); } catch (e) {}
  slackEscalate(t, c, "予約の自動受付を継続できないため、スタッフ確認へ切り替えました").catch(() => {});
  return true;
}

// 定型文を送り、送信に失敗したら「下書きに残す＋要対応(todo)＋スタッフ通知」でエスカレーション。
// 予約操作は既に実行/受付済みのことがあるため、送信失敗でも AI下書きで上書きせず必ずスタッフへ引き継ぐ。
async function baDeliverOrEscalate(t, c, text, opts) {
  // 同じ自動返信を2回続けて送らない（定型文ループ防止）。2回目からは自動対応を打ち切り、スタッフ引き継ぎに切り替える。
  const lastUs0 = (c.msgs || []).slice().reverse().find(m => m && m.from === "us");
  if (lastUs0 && lastUs0.auto && String(lastUs0.text || "").trim() === String(text || "").trim()) {
    return await baHandoff(t, c, "たびたび恐れ入ります。こちらの件は担当スタッフが確認のうえ、こちらからあらためてご連絡いたします。お手数をおかけしますが、このままお待ちくださいませ。");
  }
  const sent = await baDeliver(t, c, text);
  if (sent) return true;
  if (opts && opts.clearPendingOnFail && c.ba) c.ba.pending = null; // 患者が見ていない確認への「はい」を防ぐ（サーバー側の依頼は30分で自然失効）
  c.draft = text; c.draft0 = text; c.status = "todo"; c.time = nowt(); c.ts = Date.now(); dbSave(t, c);
  try { notifyAll(t, "⚠️ 予約自動受付: 自動送信に失敗（要対応）: " + (c.name || ""), String(text).slice(0, 90)); } catch (e) {}
  slackEscalate(t, c, "予約自動受付の返信送信に失敗しました").catch(() => {});
  return true;
}

// 確認待ち（c.ba.pending）がある会話への返信を処理。明確な yes/no のときだけ confirm を呼ぶ。
async function baHandlePending(t, c) {
  const ba = c.ba;
  if (!ba || !ba.pending) return false;
  if (!ba.pending.expiresAt || Date.parse(ba.pending.expiresAt) < Date.now()) { ba.pending = null; dbSave(t, c); return false; }
  const lastMsg = c.msgs[c.msgs.length - 1];
  const text = String((lastMsg && lastMsg.text) || "").trim();
  if (!text) return false;
  const cls = await classifyApproval(t, ba.pending.confirmText, text);
  if (cls !== "yes" && cls !== "no") return false; // 曖昧 → 実行せず通常の下書きへ（確認は期限まで有効）
  const requestId = ba.pending.requestId;
  // うけつけるん側はコールドスタート＋通知送信で時間がかかることがある。30秒待つ（confirmは排他制御済みで二重実行しない）。
  let r = await baCall(t, c, "confirm", { requestId, approve: cls === "yes" }, 30000);
  ba.pending = null; dbSave(t, c);
  if (!r) {
    // タイムアウト＝実行されたか不明。少し待って「結果照会（読み取りのみ）」で実際どうなったかを確かめる。
    for (let i = 0; i < 3 && !r; i++) {
      await new Promise(res => setTimeout(res, 4000));
      const chk = await baCall(t, c, "result", { requestId }, 10000);
      if (chk && chk.ok && chk.status === "executed" && chk.text) { r = { ok: true, done: true, text: chk.text }; break; }
      if (chk && chk.ok && chk.status === "declined") { r = { ok: true, done: false, text: "かしこまりました。変更は行っておりませんので、ご安心ください。" }; break; }
      if (chk && chk.ok && chk.status === "failed") break; // 実行失敗が確定 → 下の不明時案内ではなく失敗案内にしたいが詳細不明のためスタッフへ
    }
  }
  if (!r) {
    // 結果照会でも確定できない。誤った「失敗しました」案内をせず、要対応フラグでスタッフへ引き継ぐ。
    try { notifyAll(t, "⚠️ 予約自動受付: 実行結果不明（要確認）: " + (c.name || ""), "confirm応答が取れませんでした。予約状況を確認してください。"); } catch (e) {}
    await baDeliver(t, c, "恐れ入ります、お手続きの確認にお時間をいただいております。念のため担当者が確認し、必要に応じてご連絡いたします。");
    c.status = "todo"; c.flag = true; dbSave(t, c);
    return true;
  }
  let reply = r.text ? String(r.text) : null;
  if (!reply) {
    if (r.ok) reply = cls === "yes" ? "お手続きが完了しました。" : "かしこまりました。変更は行っておりませんので、ご安心ください。";
    else reply = "申し訳ありません、お手続きを完了できませんでした。担当スタッフが確認してご対応いたしますので、お手数ですがこのままお待ちくださいませ。";
  }
  if (r.ok === false && Array.isArray(r.alternatives) && r.alternatives.length) {
    reply += "\n空いているお時間: " + r.alternatives.map(x => x.label).join(" / ");
    return await baDeliverOrEscalate(t, c, reply); // 代替枠あり＝会話を続けられるのでスタッフ引き継ぎ不要
  }
  if (r.ok === false && ["not_found", "not_changeable", "line_bound_other", "bad_request"].includes(String(r.error || ""))) {
    return await baHandoff(t, c, reply); // 自動では進められない失敗＝案内したうえで実際にスタッフへ引き継ぐ
  }
  return await baDeliverOrEscalate(t, c, reply);
}

// AIが出した action を実行（propose→確認文送信 / verify / slots）。処理して返信まで送れたら true。
async function baAction(t, c, act, baCtx) {
  const type = String((act && act.type) || "none");
  if (type === "none") return false;
  c.ba = c.ba || {};
  const changeable = (baCtx && Array.isArray(baCtx.appointments)) ? baCtx.appointments.filter(a => a.changeable) : [];
  const apptId = String(act.appointmentId || "") || (changeable.length === 1 ? changeable[0].id : "");

  if (type === "verify") { // メール経路: 電話番号でメール＋電話の両方一致を確認
    const phone = String(act.phone || "").trim();
    if (!phone || phone.replace(/\D/g, "").length < 8) return false;
    const r = await baCall(t, c, "context", { phone });
    if (r && r.ok && r.verified) {
      c.ba.phone = phone; dbSave(t, c);
      const list = Array.isArray(r.appointments) ? r.appointments : [];
      const lines = list.length ? "直近のご予約:\n" + list.map(a => "・" + a.label + "〜 " + a.menu + "（" + a.statusJa + "）").join("\n") : "現在、直近のご予約はございません。";
      return await baDeliverOrEscalate(t, c, "ご本人様の確認がとれました。\n" + lines + "\nご予約の変更・キャンセルをご希望の場合は、ご希望の内容をお送りください。");
    }
    return await baDeliverOrEscalate(t, c, "申し訳ありません、ご登録の情報との一致を確認できませんでした。お手数ですが、ご登録のお電話番号をもう一度お確かめのうえお送りくださいませ。");
  }

  if (type === "link") { // LINE未連携: 電話＋メール両方一致で特定できたら連携の確認を送る
    const phone = String(act.phone || "").trim();
    const email = String(act.email || "").trim();
    if (!phone || !email || !email.includes("@")) return false;
    const r = await baCall(t, c, "propose", { kind: "line_link", linkPhone: phone, linkEmail: email });
    if (r && r.ok && r.requestId) {
      c.ba.phone = phone; c.ba.email = email;
      c.ba.pending = { requestId: r.requestId, confirmText: r.confirmText, expiresAt: r.expiresAt };
      dbSave(t, c);
      return await baDeliverOrEscalate(t, c, r.confirmText, { clearPendingOnFail: true });
    }
    if (r && (r.error === "line_bound_other" || r.error === "patient_has_line")) {
      return await baHandoff(t, c, "申し訳ありません、このLINEアカウントの連携はこちらでの確認が必要です。担当スタッフが確認してご対応いたしますので、お手数ですがこのままお待ちくださいませ。");
    }
    return await baDeliverOrEscalate(t, c, "申し訳ありません、頂戴したお電話番号・メールアドレスに一致するご登録が見つかりませんでした。お手数ですが、もう一度お確かめのうえお送りくださいませ。\nなお、当院へ直接のご予約ではなく、外部の予約サービスやクーポンサイトを通じてご予約いただいた場合は、こちらにご登録が無いことがございます。その場合は担当スタッフがご対応いたしますので、ご予約のお名前とご予約日時をこのままお知らせください。");
  }

  if (!apptId) return false; // 対象の予約を特定できない → AIの下書き（どの予約か質問）に任せる

  if (type === "slots") {
    let dates = Array.isArray(act.dates) ? act.dates.map(String) : [];
    if (act.date) dates.push(String(act.date)); // 旧形式との互換
    dates = Array.from(new Set(dates.filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)))).slice(0, 7);
    if (!dates.length) return false;
    const fmtD = (ds) => { const d = new Date(ds + "T00:00:00+09:00"); return (d.getMonth() + 1) + "月" + d.getDate() + "日(" + "日月火水木金土"[d.getDay()] + ")"; };
    const results = [];
    for (const ds of dates) {
      const r = await baCall(t, c, "slots", { appointmentId: apptId, date: ds });
      if (r && r.ok) results.push({ date: ds, slots: Array.isArray(r.slots) ? r.slots : [] });
    }
    if (!results.length) return false;
    const slotsTxt = results.map(x => fmtD(x.date) + ": " + (x.slots.length ? x.slots.map(s => s.label).join(" ") : "空きなし")).join("\n");
    // 2パス目: 照会結果をAIに渡し、患者の条件（一番遅い・◯時以降・土日など）に沿った回答を作らせる
    try {
      const g2 = await genDraft(t, c, { baSlotsTxt: slotsTxt });
      if (g2 && g2.action && typeof g2.action === "object" && ["cancel", "reschedule"].includes(String(g2.action.type))) {
        // 条件から具体的な変更確定まで進んだ場合は通常の操作経路へ（確認文が送られる）
        const done2 = await baAction(t, c, g2.action, g2.baCtx);
        if (done2) return true;
      }
      if (g2 && g2.draft && String(g2.draft).trim() && String(g2.needs_human) !== "true") {
        return await baDeliverOrEscalate(t, c, String(g2.draft).trim());
      }
    } catch (e) { console.error("ba slots 2nd pass:", e && e.message); }
    // フォールバック: 定型の一覧（AI生成が使えないときも空き情報は届ける）
    const lines = results.map(x => fmtD(x.date) + ": " + (x.slots.length ? x.slots.slice(0, 12).map(s => s.label).join(" / ") : "空きなし"));
    return await baDeliverOrEscalate(t, c, "空き状況はこちらです:\n" + lines.join("\n") + "\nご希望のお時間をお知らせください。");
  }

  if (type === "cancel") {
    let r = await baCall(t, c, "propose", { kind: "cancel", appointmentId: apptId });
    if (!r) r = await baCall(t, c, "propose", { kind: "cancel", appointmentId: apptId }); // 一時失敗（コールドスタート等）は一度だけ再試行（proposeは再実行しても安全）
    if (r && r.ok && r.requestId) {
      c.ba.pending = { requestId: r.requestId, confirmText: r.confirmText, expiresAt: r.expiresAt };
      dbSave(t, c);
      return await baDeliverOrEscalate(t, c, r.confirmText, { clearPendingOnFail: true });
    }
    if (r && r.error === "not_changeable") {
      return await baHandoff(t, c, "申し訳ありません、このご予約は自動受付でのキャンセル期限を過ぎております。担当スタッフが確認してご対応いたしますので、お手数ですがこのままお待ちくださいませ。");
    }
    return false;
  }

  if (type === "reschedule") {
    const ndt = String(act.newDateTime || "");
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(ndt)) return false;
    const dt = new Date(ndt.slice(0, 16) + ":00+09:00");
    if (isNaN(dt.getTime()) || dt.getTime() < Date.now()) return false;
    let r = await baCall(t, c, "propose", { kind: "reschedule", appointmentId: apptId, newStartsAt: dt.toISOString() });
    if (!r) r = await baCall(t, c, "propose", { kind: "reschedule", appointmentId: apptId, newStartsAt: dt.toISOString() }); // 一時失敗は一度だけ再試行（proposeは再実行しても安全）
    if (r && r.ok && r.requestId) {
      c.ba.pending = { requestId: r.requestId, confirmText: r.confirmText, expiresAt: r.expiresAt };
      dbSave(t, c);
      return await baDeliverOrEscalate(t, c, r.confirmText, { clearPendingOnFail: true });
    }
    if (r && r.error === "slot_taken") {
      const alts = Array.isArray(r.alternatives) ? r.alternatives.map(x => x.label).join(" / ") : "";
      return await baDeliverOrEscalate(t, c, "申し訳ありません、ご希望のお時間は埋まっております。" + (alts ? "\n同じ日の空き時間はこちらです:\n" + alts + "\nご希望のお時間をお知らせください。" : "別の日時のご希望をお知らせください。"));
    }
    if (r && r.error === "not_changeable") {
      return await baHandoff(t, c, "申し訳ありません、このご予約は自動受付での変更期限を過ぎております。担当スタッフが確認してご対応いたしますので、お手数ですがこのままお待ちくださいませ。");
    }
    return false;
  }
  return false;
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
      if (slackReviewAll(t)) { await slackRequestApproval(t, cur, "毎回確認モードのため、送信前に承認が必要です"); return; }
      if (cur.status === "done" || cur.flag) return; // 既に対応済み/フラグ付き
      if (!cur.draft || cur.draft.trim() !== draftText) return; // 下書きが変わった/消えた
      const lastMsg = cur.msgs[cur.msgs.length - 1];
      if (!lastMsg || lastMsg.from !== "them") return; // 待機中に誰かが返信した
      const r = await deliverText(t, cur, draftText);
      if (r.sent) {
        statBump(t, "auto");
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
  // 予約自動受付: 本人確認つきコンテキスト。未確認の相手には既存の照会テキストも渡さない（個人情報を出させない）。
  let baCtx = null, baTxt = "";
  if (baEnabled(t) && PARTNER_KEY) {
    try { baCtx = await baCall(t, c, "context", { email: (c.ba && c.ba.email) || undefined }); } catch (e) { baCtx = null; }
    baTxt = baPromptBlock(baCtx);
    // 本人確認が取れていない相手（照会失敗も含む）には既存の照会テキストも渡さない（個人情報を出させない）
    if (!(baCtx && baCtx.ok && baCtx.verified)) bookingTxt = "";
    if (c.ba && c.ba.pending && c.ba.pending.expiresAt && Date.parse(c.ba.pending.expiresAt) > Date.now()) {
      baTxt += "\n現在、次の確認への返信待ち:「" + String(c.ba.pending.confirmText || "").slice(0, 120) + "」。患者が別の話をしていればそれに答えつつ、手続きを続ける場合は「はい」と返信いただくよう最後に一言添える。";
    }
    if (opts.baSlotsTxt) {
      baTxt += "\n\n【空き枠の照会結果（システムが今取得した実データ。この範囲だけを根拠に答える）】\n" + opts.baSlotsTxt
        + "\n患者の質問・条件（一番遅い/早い・◯時以降・土日など）に沿って、この結果から計算して端的に答える。全枠の羅列はせず、条件に合う候補を最大6件まで。条件に合う枠が無ければ正直に無いと伝え、近い代替を提案する。回答の最後に、ご希望が決まればこのまま日時変更できる旨を一言添える。追加の空き照会（type:slots）はもう出さない。";
    }
  }
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
    + (notesBlock(c) ? "\n\n【このお客様への対応でスタッフが出した指示メモ（編集チャットでの指示。今回の返信でも引き続き従う。ただし明らかに“その時限り”の内容は無視してよい）】\n" + notesBlock(c) : "")
    + (bookingTxt ? "\n\n【この方の情報（うけつけるん＝予約システムからの照会結果。氏名・会員ランク・ポイント・予約・回数券・最終来院などの参考。日付判断・キャンセル可否・来院案内に使う。ここに無い内容は推測しない。カルテ・診療内容は含まれない）】\n" + bookingTxt : "")
    + baTxt
    + "\n\n" + JP_QUALITY
    + "\n\n出力は必ず次のJSONのみ（前後に説明や```やかぎ括弧を付けない）: {\"draft\":\"お客様への返信文\",\"confidence\":\"high|medium|low\",\"is_urgent\":true|false,\"needs_human\":true|false,\"site_alert\":\"遅刻|当日キャンセル|緊急来院|none\",\"site_summary\":\"現場向け一行要約。site_alertがnoneなら空文字\",\"topics\":[{\"q\":\"短い質問ラベル\",\"need\":true}]"
    + (baTxt ? ",\"action\":{\"type\":\"none|cancel|reschedule|slots|link|verify\",\"appointmentId\":\"\",\"newDateTime\":\"\",\"dates\":[\"YYYY-MM-DD\"],\"phone\":\"\",\"email\":\"\"}" : "")
    + "}"
    + "\nconfidence: ルールと会話から自信を持って答えられればhigh、判断に迷う/情報不足ならlow。"
    + (baTxt
        ? "\nneeds_human: クレーム・支払いトラブル・偽物疑惑・キャンセル料の例外判断などスタッフの人間判断が必要ならtrue。予約の確認・キャンセル・日時変更は上の【予約自動受付】のactionで処理できるため、それだけならfalseでよい。"
        : "\nneeds_human: 予約状況の確認・キャンセル例外判断・クレーム・支払いトラブル・偽物疑惑などスタッフ確認が必要ならtrue。")
    + "\nis_urgent: 痛み・出血・腫れ・強い不調など緊急性があればtrue。"
    + "\ntopics: お客様の直近メッセージにある「返信すべき質問・依頼」を、それぞれ短い日本語ラベル(q)で列挙する（最大5件）。状況連絡・挨拶・お礼や、時間が経って既に解決済みと思われるもの（例: かなり前に届いた『遅れます』）は need:false。それ以外は need:true。質問が1つだけなら1件でよい。";
  try {
    const raw = await aiChat(t, sys, msgsArr, 4000);
    if (!raw) return null;
    let out = null; try { const m = raw.match(/\{[\s\S]*\}/); out = JSON.parse(m ? m[0] : raw); } catch (e) { out = { draft: salvageDraft(raw), confidence: "low", is_urgent: false, needs_human: true, site_alert: "none", site_summary: "" }; }
    if (out && typeof out === "object") out.baCtx = baCtx; // 予約自動受付: actionの対象特定に使う
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
  statBump(t, "in");
  if (opts.subject) c.subject = String(opts.subject).slice(0, 300);
  c.status = "todo"; c.time = nowt(); c.ts = Date.now(); c.last = lastText(c); dbSave(t, c);

  let confidence = opts.confidence, needsHuman = opts.needsHuman, urgent = opts.urgent, siteAlert = opts.siteAlert, siteSummary = opts.siteSummary;

  // ===== 予約自動受付: 確認待ちへの「はい/いいえ」を最優先で処理（明確な返答のときだけ実行） =====
  let baDone = false;
  if (!med && typeof opts.draft !== "string" && baEnabled(t) && PARTNER_KEY) {
    try { baDone = await baHandlePending(t, c); } catch (e) { console.error("ba pending:", e && e.message); }
  }

  if (typeof opts.draft === "string") { c.draft = opts.draft; c.draft0 = opts.draft; }
  else if (!med && !baDone) { // generate draft in-app for text messages
    const g = await genDraft(t, c);
    if (g) { c.draft = String(g.draft || ""); c.draft0 = c.draft; confidence = g.confidence; needsHuman = g.needs_human; urgent = g.is_urgent; siteAlert = g.site_alert; siteSummary = g.site_summary; c.topics = Array.isArray(g.topics) ? g.topics : []; }
    // ===== 予約自動受付: AIが操作依頼(action)を出したら、確認文の送信までを自動処理 =====
    if (g && !slackReviewAll(t) && baEnabled(t) && PARTNER_KEY && g.action && typeof g.action === "object" && g.action.type && g.action.type !== "none") {
      try { baDone = await baAction(t, c, g.action, g.baCtx); } catch (e) { console.error("ba action:", e && e.message); }
      if (baDone) { c.draft = ""; c.draft0 = ""; }
      else if (String(needsHuman) !== "true" && String(urgent) !== "true") {
        // 予約操作の会話で「沈黙」「数分の待ち時間」を作らない：
        // actionを処理できなかったら、AIの繋ぎ下書きを待ち時間なしで即送信（下書きも無ければ定型の案内）。
        // 通常フローに落とすと繋ぎ文が自動返信の待ち時間キューに入り、患者には無反応に見えるため。
        const fallback = (c.draft && c.draft.trim())
          ? c.draft.trim()
          : "恐れ入ります、ただいまお手続きの処理に少しお時間がかかっております。お手数ですが、もう一度ご希望（例: 「7月18日 14時に変更」）をお送りくださいませ。";
        try { baDone = await baDeliverOrEscalate(t, c, fallback); } catch (e) { console.error("ba fallback:", e && e.message); }
      }
    }
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
    if (!baDone && S(t).autoReply && !slackReviewAll(t) && confOk && safe && c.draft && c.draft.trim()) {
      const draftText = c.draft.trim();
      const delayMin = Number(S(t).autoDelayMin || 0);
      if (delayMin > 0 && (recvAt + delayMin * 60000 - Date.now()) > 0) {
        // 受信からdelayMin分が経過していない → 残り時間だけ待ってから送信（生成が設定時間を超えていれば即時）
        scheduleAutoReply(t, c, draftText, recvAt, delayMin);
        autoScheduled = true;
      } else {
        const r = await deliverText(t, c, draftText);
        if (r.sent) { statBump(t, "auto"); c.msgs.push({ from: "us", text: draftText, auto: true, time: nowt() }); c.draft = ""; c.draft0 = ""; c.status = "done"; c.lastAuto = true; c.time = nowt(); c.ts = Date.now(); c.last = lastText(c); dbSave(t, c); autoSent = true; }
      }
    }
  } catch (e) {}
  try { if (autoSent) notifyAll(t, "🤖 自動返信済み: " + (c.name || ""), (c.last || "").slice(0, 90)); else if (!baDone) notifyAll(t, c.name || "新着メッセージ", (c.last || "新しいメッセージが届きました").slice(0, 90)); } catch (e) {}
  const confForSlack = String(confidence || "").toLowerCase();
  const confOkForSlack = confForSlack === "high" || (S(t).level === "medium" && confForSlack === "medium");
  const safeForSlack = String(needsHuman) !== "true" && String(urgent) !== "true" && !c.flag && !med;
  const exceptionNeedsReview = S(t).autoReply && S(t).slackReplyMode === "exceptions" && !baDone && c.draft && c.draft.trim() && (!confOkForSlack || !safeForSlack);
  if (slackReviewAll(t) && !baDone && c.draft && c.draft.trim()) {
    slackRequestApproval(t, c, "毎回確認モードのため、送信前に承認が必要です").catch(() => {});
  } else if (exceptionNeedsReview || String(needsHuman) === "true" || String(urgent) === "true" || c.flag) {
    const reason = String(urgent) === "true" ? "緊急性のある問い合わせとAIが判定しました" : (c.flag ? "要対応フラグが付いています" : (!confOkForSlack ? "自動送信に必要な確信率を満たさないため確認が必要です" : "AIが人による判断を必要と判定しました"));
    if (c.draft && c.draft.trim() && S(t).slackReplyMode === "exceptions" && C.slackBotToken(t)) slackRequestApproval(t, c, reason).catch(() => {});
    else slackEscalate(t, c, reason).catch(() => {});
  }
  try { forwardToPartner(t, c, { autoSent: autoSent || baDone, autoScheduled }); } catch (e) {} // 受付くんへ受信イベントを転送
  return { id, autoSent: autoSent || baDone, autoScheduled };
}

// ===== 複数アカウント対応: メイン（conn直下）＋追加分（conn.lines / conn.mails） =====
function lineAccounts(t) {
  const arr = [];
  const conn = t.config.conn;
  if (C.lineToken(t)) arr.push({ name: conn.lineName || "メイン", token: C.lineToken(t), secret: C.lineSecret(t), botId: conn.lineBotId || "", main: true });
  (Array.isArray(conn.lines) ? conn.lines : []).forEach(a => { if (a && a.token) arr.push({ name: a.name || "LINE", token: decField(a.token), secret: a.secret ? decField(a.secret) : "", botId: a.botId || "" }); });
  return arr;
}
function mailAccounts(t) {
  const arr = [];
  const conn = t.config.conn;
  if (C.smtpUser(t) && C.smtpPass(t)) arr.push({ name: conn.mailName || "メイン", smtpHost: C.smtpHost(t), smtpPort: C.smtpPort(t), smtpUser: C.smtpUser(t), smtpPass: C.smtpPass(t), imapHost: C.imapHost(t), imapPort: C.imapPort(t), imapUser: C.imapUser(t), imapPass: C.imapPass(t), main: true });
  (Array.isArray(conn.mails) ? conn.mails : []).forEach(a => {
    if (a && a.smtpUser && a.smtpPass) arr.push({ name: a.name || "メール", smtpHost: a.smtpHost || "smtp.gmail.com", smtpPort: +(a.smtpPort || 465), smtpUser: a.smtpUser, smtpPass: decField(a.smtpPass), imapHost: a.imapHost || "imap.gmail.com", imapPort: +(a.imapPort || 993), imapUser: a.imapUser || a.smtpUser, imapPass: a.imapPass ? decField(a.imapPass) : decField(a.smtpPass) });
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
  // fail-closed: チャネルシークレット未登録のアカウントは署名検証成功にしない（=Webhookは401）。
  // 以前は secret 未設定で return true としていたため、未登録アカウント宛の偽装Webhookを受理する恐れがあった。
  const sigOk = (a) => { if (!a.secret) return false; try { return safeEq(sig, crypto.createHmac("sha256", a.secret).update(req.rawBody || Buffer.from("")).digest("base64")); } catch (e) { return false; } };
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
    else { const raw = (conn.lines || []).find(x => decField(x.token) === acct.token); if (raw) raw.botId = dest; }
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
  // fail-closed: INGEST_KEY未設定なら常に拒否。鍵はヘッダ x-key のみ受理（bodyのkey受理は廃止）。定数時間比較。
  if (!INGEST_KEY || !safeEq(req.headers["x-key"], INGEST_KEY)) return res.status(401).json({ error: "bad key" });
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

// 自動化ダッシュボード：直近7日（日本時間）の集計を返す
app.get("/api/stats", guard, (req, res) => {
  const t = req.tenant;
  const all = (t.config && t.config.statsDaily) || {};
  const sum = { in: 0, auto: 0, staff: 0, rules: 0 };
  for (let i = 0; i < 7; i++) {
    const dk = new Date(Date.now() - i * 86400000).toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });
    const d = all[dk] || {};
    sum.in += d.in || 0; sum.auto += d.auto || 0; sum.staff += d.staff || 0; sum.rules += d.rules || 0;
  }
  const replies = sum.auto + sum.staff;
  res.json({ ok: true, week: { in: sum.in, auto: sum.auto, staff: sum.staff, rules: sum.rules, autoRate: replies ? Math.round(sum.auto * 100 / replies) : null } });
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

const sendLocks = new Set(); // 二重送信ガード（法人＋会話単位の実行中ロック）
app.post("/api/send", guard, async (req, res) => {
  const t = req.tenant;
  const c = t.store[req.body.id]; if (!c) return res.status(404).json({ error: "no" });
  cancelAutoReply(t, c.id); // スタッフが手動返信したので保留中の自動返信は取り消す
  const text = (req.body.text || "").trim(); if (!text) return res.status(400).json({ error: "empty" });
  // 二重押し対策1: 同じ会話への送信が実行中なら受け付けない（1通目の結果に相乗り）
  const sendLockKey = t.slug + "::" + c.id;
  if (sendLocks.has(sendLockKey)) return res.json({ ok: true, sent: true, dup: true });
  // 二重押し対策2: 直近60秒以内に同一本文を送信済みなら再送しない
  const lastUs = (c.msgs || []).slice().reverse().find((m) => m && m.from === "us");
  if (lastUs && String(lastUs.text || "").trim() === text && Date.now() - (c.ts || 0) < 60000) {
    return res.json({ ok: true, sent: true, dup: true });
  }
  sendLocks.add(sendLockKey);
  let sent = false, sendErr = null;
  try { ({ sent, sendErr } = await deliverText(t, c, text)); }
  finally { sendLocks.delete(sendLockKey); }
  let learnedId = null, conflict = null, learnedRules = [];
  if (sent) {
    const draft0 = String(c.draft0 || "").trim(); // 学習判定用に、消す前のAI初回下書きを確保
    c.msgs.push({ from: "us", text, time: nowt() }); c.draft = ""; c.status = "done"; c.flag = false; c.lastAuto = false; c.time = nowt(); c.ts = Date.now(); c.last = lastText(c); dbSave(t, c);
    statBump(t, "staff");
    const q0 = c.msgs.filter(m => m.from === "them").slice(-3).map(m => m.text || "").join(" ").trim();
    // ルール蒸留：スタッフの返信＋編集チャットの指示から、再利用できる事実・規定を店舗ルールへ自動登録。
    // （対応例の保存・矛盾チェックと並列で回して送信応答を遅くしない）
    const distillP = (text !== draft0 || String(req.body.instr || "").trim())
      ? distillRules(t, c, { q: q0, final: text, draft0, instr: req.body.instr || "" })
      : Promise.resolve([]);
    // 自動メモリ：AIの下書きと違う返信（＝スタッフの貢献）だけを対応例として自動保存。送信したそのままは保存しない。
    if (text !== draft0 && q0) {
      const ex = await exampleAdd(t, { q: q0, final: text, draft0, instr: req.body.instr || "" });
      if (ex) {
        learnedId = ex.id;
        const cf = await checkConflict(t, q0, text, ex.id); // 似た過去の対応例と矛盾していないか
        if (cf) conflict = { oldId: cf.oldId, oldFinal: cf.oldFinal, newId: ex.id, newFinal: text };
      }
    }
    // 蒸留が遅い場合は6秒で応答を返す（学習自体は裏で完走してルール保存される。トーストが出ないだけ）
    try { learnedRules = await Promise.race([distillP, new Promise((r) => setTimeout(() => r([]), 6000))]); } catch (e) { learnedRules = []; }
  }
  res.json({ ok: true, sent, sendErr, learnedId, conflict, learnedRules });
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
function publicSettings(t) {
  return Object.assign({}, S(t), {
    slackConfigured: validSlackWebhook(C.slackWebhook(t)),
    slackOAuthAvailable: slackOAuthReady(),
    slackConnection: validSlackWebhook(C.slackWebhook(t)) ? {
      team: String(t.config.conn.slackTeamName || "").slice(0, 120),
      channel: String(t.config.conn.slackChannelName || "").slice(0, 120),
      oauth: t.config.conn.slackConnectionType === "oauth"
    } : null,
    slackInteractive: !!(C.slackBotToken(t) && t.config.conn.slackChannelId),
    publicUrlConfigured: !!publicConversationUrl({ id: "preview" }),
    engines: { claude: !!ANTHROPIC_KEY, gpt: !!process.env.OPENAI_KEY, gemini: !!process.env.GEMINI_KEY },
    rules: { chars: rulesCharTotal(t), count: rulesList(t).length, budget: ruleBudget(t), budgets: RULE_BUDGETS }
  });
}
app.get("/api/settings", guard, (req, res) => res.json(publicSettings(req.tenant)));
app.get("/api/slack/oauth/start", guard, (req, res) => {
  if (!slackOAuthReady()) return res.status(503).send("Slack OAuth is not configured");
  const state = issueSlackState(req, req.tenant);
  const redirectUri = PUBLIC_BASE_URL.replace(/\/$/, "") + "/api/slack/oauth/callback";
  const q = new URLSearchParams({ client_id: SLACK_OAUTH.clientId, scope: "incoming-webhook,chat:write,channels:history,groups:history", redirect_uri: redirectUri, state });
  res.redirect("https://slack.com/oauth/v2/authorize?" + q.toString());
});
app.get("/api/slack/oauth/callback", async (req, res) => {
  const t = verifySlackState(req, req.query.state);
  const base = PUBLIC_BASE_URL.replace(/\/$/, "");
  if (!t || !req.query.code) return res.redirect(base + "/?slack=error");
  try {
    const redirectUri = base + "/api/slack/oauth/callback";
    const body = new URLSearchParams({ client_id: SLACK_OAUTH.clientId, client_secret: SLACK_OAUTH.clientSecret, code: String(req.query.code), redirect_uri: redirectUri });
    const r = await fetch("https://slack.com/api/oauth.v2.access", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
    const j = await r.json();
    const incoming = j && j.incoming_webhook;
    if (!r.ok || !j.ok || !incoming || !validSlackWebhook(incoming.url) || !String(j.access_token || "")) throw new Error("oauth_failed");
    t.config.conn.slackWebhook = incoming.url;
    t.config.conn.slackBotToken = String(j.access_token || "");
    t.config.conn.slackConnectionType = "oauth";
    t.config.conn.slackTeamId = String((j.team && j.team.id) || "").slice(0, 80);
    t.config.conn.slackTeamName = String((j.team && j.team.name) || "").slice(0, 120);
    t.config.conn.slackChannelId = String(incoming.channel_id || "").slice(0, 80);
    t.config.conn.slackChannelName = String(incoming.channel || "").replace(/^#/, "").slice(0, 120);
    S(t).slackEnabled = false; // 接続先を画面で確認してから明示的にONにする
    await saveTenantConfig(t);
    const label = (t.config.conn.slackTeamName || "Slack") + " / #" + (t.config.conn.slackChannelName || "通知先");
    await postSlackWebhook(C.slackWebhook(t), { text: "✅ 右腕くんを接続しました\n接続先: " + label + "\n右腕くんの設定画面で接続先を確認し、通知を有効にしてください。" });
    return res.redirect(base + "/?slack=connected");
  } catch (e) { return res.redirect(base + "/?slack=error"); }
});
function verifySlackRequest(req) {
  const ts = String(req.headers["x-slack-request-timestamp"] || "");
  const sig = String(req.headers["x-slack-signature"] || "");
  if (!SLACK_OAUTH.signingSecret || !/^\d+$/.test(ts) || Math.abs(Date.now() / 1000 - Number(ts)) > 300 || !req.rawBody) return false;
  const expected = "v0=" + crypto.createHmac("sha256", SLACK_OAUTH.signingSecret).update("v0:" + ts + ":").update(req.rawBody).digest("hex");
  return safeEq(sig, expected);
}
const slackEventSeen = new Map();
app.post("/api/slack/events", async (req, res) => {
  if (!verifySlackRequest(req)) return res.status(401).send("invalid signature");
  if (req.body && req.body.type === "url_verification") return res.json({ challenge: req.body.challenge });
  res.sendStatus(200);
  const eventId = String(req.body && req.body.event_id || "");
  if (eventId) {
    if (slackEventSeen.has(eventId)) return;
    slackEventSeen.set(eventId, Date.now());
    if (slackEventSeen.size > 1000) for (const [k, v] of slackEventSeen) if (Date.now() - v > 10 * 60 * 1000 || slackEventSeen.size > 900) slackEventSeen.delete(k);
  }
  const ev = req.body && req.body.event;
  if (!ev || ev.type !== "message" || ev.subtype || ev.bot_id || !ev.thread_ts || !String(ev.text || "").trim()) return;
  const found = slackApprovalByThread(req.body.team_id, ev.channel, String(ev.thread_ts));
  if (!found || found.approval.expiresAt < Date.now()) return;
  const instruction = String(ev.text || "").trim().slice(0, 1200);
  try {
    if (/^(それで|それでいい|この内容で|その内容で|そのまま)(送って|送信して|大丈夫|いい|お願いします)?[。！!\s]*$/.test(instruction)) {
      await slackApi(found.t, "chat.postMessage", { channel: ev.channel, thread_ts: ev.thread_ts, text: "安全のため、返信案にある「この内容で送信」ボタンを押して確定してください。" });
      return;
    }
    if (/(患者|予約|来院|顧客).*(確認|情報|教え|見せ)|情報.*(患者|予約)/.test(instruction)) {
      let info = "予約システムに確認できる情報がありません。";
      try { info = (await fetchBooking(found.t, found.c)) || info; } catch (e) {}
      await slackApi(found.t, "chat.postMessage", { channel: ev.channel, thread_ts: ev.thread_ts, text: "確認結果です。\n" + String(info).slice(0, 2800), mrkdwn: false });
      return;
    }
    const revised = await slackReviseDraft(found.t, found.c, instruction);
    if (!revised) throw new Error("no_draft");
    found.c.draft = revised;
    found.approval.status = "revised";
    const nextId = crypto.randomBytes(18).toString("hex");
    const next = { id: nextId, eventKey: found.approval.eventKey, draft: revised, draftHash: sha(revised), status: "pending", createdAt: Date.now(), expiresAt: Date.now() + 24 * 60 * 60 * 1000, channelId: ev.channel, threadTs: ev.thread_ts };
    found.c.slackApproval = next; dbSave(found.t, found.c);
    await slackApi(found.t, "chat.postMessage", { channel: ev.channel, thread_ts: ev.thread_ts, text: "修正した返信案です。", blocks: slackApprovalBlocks(found.c, "スタッフの修正指示：「" + instruction + "」", revised, "修正後の再確認", nextId) });
  } catch (e) { await slackApi(found.t, "chat.postMessage", { channel: ev.channel, thread_ts: ev.thread_ts, text: "返信案を修正できませんでした。右腕くんの画面で確認してください。" }); }
});
app.post("/api/slack/actions", async (req, res) => {
  if (!verifySlackRequest(req)) return res.status(401).send("invalid signature");
  let p; try { p = JSON.parse(req.body.payload || "{}"); } catch (e) { return res.status(400).send("bad payload"); }
  const action = p.actions && p.actions[0];
  const found = action && slackApprovalById(String(action.value || ""));
  res.status(200).send();
  if (!found || found.approval.status !== "pending") return;
  const channel = p.channel && p.channel.id, ts = p.message && p.message.ts;
  if (found.approval.expiresAt < Date.now()) {
    found.approval.status = "expired"; dbSave(found.t, found.c);
    return void slackUpdateApproval(found.t, channel, ts, "⌛ この承認依頼は期限切れです。右腕くんで最新の返信案を確認してください。");
  }
  if (action.action_id === "migiude_cancel") {
    found.approval.status = "cancelled"; dbSave(found.t, found.c);
    return void slackUpdateApproval(found.t, channel, ts, "⛔ 今回は送信しませんでした。下書きは右腕くんに残っています。");
  }
  if (action.action_id === "migiude_info") {
    let info = "予約システムに確認できる情報がありません。";
    try { info = (await fetchBooking(found.t, found.c)) || info; } catch (e) {}
    return void slackApi(found.t, "chat.postMessage", { channel, thread_ts: found.approval.threadTs, text: "患者・予約情報の確認結果です。\n" + String(info).slice(0, 2800), mrkdwn: false });
  }
  if (action.action_id !== "migiude_send" || sha(String(found.c.draft || "").trim()) !== found.approval.draftHash) return;
  const lockKey = found.t.slug + "::" + found.c.id;
  if (sendLocks.has(lockKey)) return;
  sendLocks.add(lockKey); found.approval.status = "sending"; dbSave(found.t, found.c);
  try {
    const text = String(found.c.draft || "").trim();
    const r = await deliverText(found.t, found.c, text);
    if (!r.sent) {
      found.approval.status = "pending"; dbSave(found.t, found.c);
      return void slackUpdateApproval(found.t, channel, ts, "⚠️ 送信に失敗しました。患者様には送られていません。右腕くんで送信設定を確認してください。");
    }
    found.c.msgs.push({ from: "us", text, auto: false, approvedVia: "slack", approvedBy: String(p.user && p.user.id || ""), time: nowt() });
    found.c.draft = ""; found.c.draft0 = ""; found.c.status = "done"; found.c.flag = false; found.c.lastAuto = false; found.c.time = nowt(); found.c.ts = Date.now(); found.c.last = lastText(found.c); found.approval.status = "sent"; dbSave(found.t, found.c); statBump(found.t, "staff");
    return void slackUpdateApproval(found.t, channel, ts, "✅ 承認した内容を患者様へ送信しました。\n承認者: <@" + String(p.user && p.user.id || "") + ">");
  } finally { sendLocks.delete(lockKey); }
});
app.post("/api/slack/disconnect", guard, async (req, res) => {
  const t = req.tenant;
  S(t).slackEnabled = false;
  ["slackWebhook", "slackBotToken", "slackConnectionType", "slackTeamId", "slackTeamName", "slackChannelId", "slackChannelName"].forEach(k => { delete t.config.conn[k]; });
  try { await saveTenantConfig(t); } catch (e) { return res.status(500).json({ ok: false }); }
  res.json({ ok: true });
});
app.post("/api/settings", guard, async (req, res) => {
  const t = req.tenant;
  if (typeof req.body.autoReply === "boolean") S(t).autoReply = req.body.autoReply;
  if (typeof req.body.bookingActions === "boolean") S(t).bookingActions = req.body.bookingActions;
  if (req.body.slackWebhookClear === true) {
    ["slackWebhook", "slackBotToken", "slackConnectionType", "slackTeamId", "slackTeamName", "slackChannelId", "slackChannelName"].forEach(k => { delete t.config.conn[k]; });
  }
  if (typeof req.body.slackWebhook === "string" && req.body.slackWebhook.trim()) {
    if (!validSlackWebhook(req.body.slackWebhook)) return res.status(400).json({ ok: false, error: "invalid_slack_webhook" });
    t.config.conn.slackWebhook = req.body.slackWebhook.trim();
    t.config.conn.slackConnectionType = "manual";
    ["slackBotToken", "slackTeamId", "slackTeamName", "slackChannelId", "slackChannelName"].forEach(k => { delete t.config.conn[k]; });
  }
  const nextSlackMode = ["review_all", "exceptions"].includes(req.body.slackReplyMode) ? req.body.slackReplyMode : S(t).slackReplyMode;
  if (typeof req.body.slackEnabled === "boolean") {
    if (req.body.slackEnabled && !validSlackWebhook(C.slackWebhook(t))) return res.status(400).json({ ok: false, error: "slack_not_configured" });
    if (req.body.slackEnabled && nextSlackMode === "review_all" && !(C.slackBotToken(t) && t.config.conn.slackChannelId)) return res.status(400).json({ ok: false, error: "slack_interactive_required" });
    S(t).slackEnabled = req.body.slackEnabled;
  }
  S(t).slackReplyMode = nextSlackMode;
  if (req.body.level === "high" || req.body.level === "medium") S(t).level = req.body.level;
  if (typeof req.body.tone === "string") S(t).tone = req.body.tone.slice(0, 1500);
  if (req.body.autoDelayMin != null && isFinite(Number(req.body.autoDelayMin))) S(t).autoDelayMin = Math.min(60, Math.max(0, Math.round(Number(req.body.autoDelayMin))));
  if (["claude", "gpt", "gemini"].includes(req.body.engine)) S(t).engine = req.body.engine;
  try { await saveTenantConfig(t); } catch (e) {}
  res.json(Object.assign({ ok: true }, publicSettings(t)));
});
app.post("/api/slack-test", guard, async (req, res) => {
  const t = req.tenant;
  const supplied = typeof req.body.webhook === "string" ? req.body.webhook.trim() : "";
  const webhook = supplied || C.slackWebhook(t);
  if (!validSlackWebhook(webhook)) return res.status(400).json({ ok: false, error: "invalid_slack_webhook" });
  const link = publicConversationUrl({ id: "preview" });
  const text = "✅ 右腕くんのSlack連携テスト\n店舗: " + String(t.name || t.slug).slice(0, 120)
    + "\n要対応の問い合わせが発生した際、このチャンネルへ通知します。"
    + (link ? "\n右腕くん: " + link.replace(/\?conv=preview$/, "") : "\n※ Railwayに PUBLIC_BASE_URL を設定すると会話への直接リンクが付きます。");
  const result = await postSlackWebhook(webhook, { text });
  res.status(result.ok ? 200 : 502).json(result);
});
app.post("/api/done", guard, (req, res) => { const t = req.tenant; const c = t.store[req.body.id]; if (!c) return res.status(404).json({ error: "no" }); cancelAutoReply(t, c.id); c.status = "done"; c.flag = false; dbSave(t, c); res.json({ ok: true }); });
app.post("/api/done-all", guard, (req, res) => { const t = req.tenant; let count = 0; Object.values(t.store).forEach(c => { if (c.status !== "done" || c.flag) { cancelAutoReply(t, c.id); c.status = "done"; c.flag = false; dbSave(t, c); count++; } }); res.json({ ok: true, count }); });
app.post("/api/tag", guard, (req, res) => { const t = req.tenant; const c = t.store[req.body.id]; if (!c) return res.status(404).json({ error: "no" }); c.flag = !c.flag; if (c.flag) { c.order = Math.max(0, ...Object.values(t.store).filter(x => x.flag).map(x => x.order || 0)) + 1; c.status = "todo"; } dbSave(t, c); res.json({ ok: true, flag: c.flag }); });

// ルール蒸留トーストの「取り消す」用。学習直後のルールを1件削除する。
app.post("/api/rule-undo", guard, async (req, res) => {
  const t = req.tenant; const id = Number(req.body.id);
  const ok = t.rules[id] ? await ruleDelete(t, id) : false;
  res.json({ ok });
});
app.get("/api/learning-data", guard, (req, res) => {
  const t = req.tenant;
  const prefs = (Array.isArray(S(t).prefs) ? S(t).prefs : []).map((p, i) => ({
    key: p && typeof p === "object" && p.id != null ? String(p.id) : "legacy:" + i,
    text: String(typeof p === "string" ? p : ((p && p.text) || ""))
  })).filter(p => p.text);
  const examples = Object.values(t.examples || {}).sort((a, b) => (b.ts || 0) - (a.ts || 0) || b.id - a.id).map(e => ({
    id: e.id, q: e.q || "", final: e.final || "", draft0: e.draft0 || "", instr: e.instr || "", ts: e.ts || 0
  }));
  res.json({ ok: true, rules: rulesList(t).map(r => ({ id: r.id, title: r.title || "", content: r.content || "" })), prefs, examples });
});
app.post("/api/rule-save", guard, async (req, res) => {
  const t = req.tenant; const title = String(req.body.title || "").trim().slice(0, 100); const content = String(req.body.content || "").trim().slice(0, 2000);
  if (!title || !content) return res.status(400).json({ ok: false, error: "required" });
  try {
    const id = req.body.id == null || req.body.id === "" ? null : Number(req.body.id);
    const rule = id == null ? await ruleAdd(t, title, content) : await ruleUpdate(t, id, title, content);
    if (!rule) return res.status(404).json({ ok: false, error: "not_found" });
    res.json({ ok: true, rule });
  } catch (e) { res.status(500).json({ ok: false, error: "save" }); }
});
app.post("/api/rule-delete", guard, async (req, res) => {
  try { const ok = await ruleDelete(req.tenant, Number(req.body.id)); res.status(ok ? 200 : 404).json({ ok, error: ok ? undefined : "not_found" }); }
  catch (e) { res.status(500).json({ ok: false, error: "delete" }); }
});
app.post("/api/example-update", guard, async (req, res) => {
  const t = req.tenant; const id = Number(req.body.id); const ex = t.examples && t.examples[id];
  if (!ex) return res.status(404).json({ ok: false, error: "not_found" });
  const q = String(req.body.q || "").trim().slice(0, 600); const final = String(req.body.final || "").trim().slice(0, 1500); const instr = String(req.body.instr || "").trim().slice(0, 800);
  if (!q || !final) return res.status(400).json({ ok: false, error: "required" });
  ex.q = q; ex.final = final; ex.instr = instr;
  try { if (pool) await pool.query("UPDATE examples SET q=$1,final=$2,instr=$3 WHERE tenant=$4 AND id=$5", [q, final, instr, t.slug, id]); }
  catch (e) { return res.status(500).json({ ok: false, error: "save" }); }
  res.json({ ok: true, example: ex });
});
app.post("/api/example-delete", guard, (req, res) => { const t = req.tenant; const id = Number(req.body.id); if (t.examples && t.examples[id]) { delete t.examples[id]; if (pool) pool.query("DELETE FROM examples WHERE tenant=$1 AND id=$2", [t.slug, id]).catch(() => {}); } res.json({ ok: true }); });
app.post("/api/pref-add", guard, (req, res) => { const t = req.tenant; const text = String(req.body.text || "").trim().slice(0, 200); if (!text) return res.json({ ok: false }); const cur = (Array.isArray(S(t).prefs)) ? S(t).prefs : (S(t).prefs = []); if (!cur.some(p => (typeof p === "string" ? p : p.text) === text)) { cur.push({ id: Date.now(), text }); while (cur.length > 40) cur.shift(); saveTenantConfig(t).catch(() => {}); } res.json({ ok: true, prefs: S(t).prefs }); });
app.post("/api/pref-update", guard, async (req, res) => {
  const t = req.tenant; const key = String(req.body.key || ""); const text = String(req.body.text || "").trim().slice(0, 200); const cur = Array.isArray(S(t).prefs) ? S(t).prefs : [];
  if (!text) return res.status(400).json({ ok: false, error: "required" });
  let i = key.startsWith("legacy:") ? Number(key.slice(7)) : cur.findIndex(p => p && typeof p === "object" && String(p.id) === key);
  if (!Number.isInteger(i) || i < 0 || i >= cur.length) return res.status(404).json({ ok: false, error: "not_found" });
  const old = cur[i]; cur[i] = { id: old && typeof old === "object" && old.id != null ? old.id : Date.now(), text }; S(t).prefs = cur;
  try { await saveTenantConfig(t); } catch (e) { return res.status(500).json({ ok: false, error: "save" }); }
  res.json({ ok: true, prefs: S(t).prefs });
});
app.post("/api/pref-delete", guard, async (req, res) => {
  const t = req.tenant; const key = String(req.body.key != null ? req.body.key : req.body.id); const cur = Array.isArray(S(t).prefs) ? S(t).prefs : [];
  const i = key.startsWith("legacy:") ? Number(key.slice(7)) : cur.findIndex(p => p && typeof p === "object" && String(p.id) === key);
  if (Number.isInteger(i) && i >= 0 && i < cur.length) cur.splice(i, 1); S(t).prefs = cur;
  try { await saveTenantConfig(t); } catch (e) { return res.status(500).json({ ok: false, error: "save" }); }
  res.json({ ok: true, prefs: S(t).prefs });
});

// ---------- うけつけるん 顧客情報パネル（中継: guard付き、パートナーAPIへ x-partner-key で転送） ----------
async function partnerGet(path) {
  if (!PARTNER_KEY) return { ok: false, status: 0, json: null };
  try {
    const r = await fetch(PARTNER_BASE + path, { headers: { "x-partner-key": PARTNER_KEY }, signal: AbortSignal.timeout(8000) });
    return { ok: r.ok, status: r.status, json: await r.json().catch(() => null) };
  } catch (e) { return { ok: false, status: 0, json: null }; }
}
async function partnerPost(path, body) {
  if (!PARTNER_KEY) return { ok: false, status: 0, json: null };
  try {
    const r = await fetch(PARTNER_BASE + path, { method: "POST", headers: { "x-partner-key": PARTNER_KEY, "Content-Type": "application/json" }, body: JSON.stringify(body || {}), signal: AbortSignal.timeout(8000) });
    return { ok: r.ok, status: r.status, json: await r.json().catch(() => null) };
  } catch (e) { return { ok: false, status: 0, json: null }; }
}
app.get("/api/customer-context", guard, async (req, res) => {
  const t = req.tenant; const c = t.store[req.query.id];
  if (!c) return res.json({ found: false });
  const enc = encodeURIComponent;
  const r = await partnerGet("/customer-context?slug=" + enc(t.slug) + "&channel=" + enc(c.channel || "") + "&userId=" + enc(c.userId || ""));
  if (!r.ok || !r.json) return res.json({ found: false });
  res.json(r.json);
});
app.get("/api/customer-search", guard, async (req, res) => {
  const t = req.tenant; const enc = encodeURIComponent;
  const r = await partnerGet("/customer-search?slug=" + enc(t.slug) + "&q=" + enc(String(req.query.q || "")));
  if (!r.ok || !r.json) return res.json({ candidates: [] });
  res.json(r.json);
});
app.post("/api/customer-link", guard, async (req, res) => {
  const t = req.tenant; const c = t.store[req.body.id];
  if (!c || c.channel !== "line" || !c.userId) return res.json({ ok: false, error: "not_line" });
  const r = await partnerPost("/customer-link", { slug: t.slug, patientId: req.body.patientId, lineUid: c.userId, action: req.body.action });
  if (!r.json) return res.json({ ok: false });
  res.json(r.json);
});
// GET/POST/PUT を1つで扱う汎用中継（partnerGet は GET専用、partnerPost は POST専用のため PUT用に追加）
async function partnerReq(method, path, body) {
  if (!PARTNER_KEY) return { ok: false, status: 0, json: null };
  try {
    const opt = { method, headers: { "x-partner-key": PARTNER_KEY }, signal: AbortSignal.timeout(8000) };
    if (body != null) { opt.headers["Content-Type"] = "application/json"; opt.body = JSON.stringify(body); }
    const r = await fetch(PARTNER_BASE + path, opt);
    return { ok: r.ok, status: r.status, json: await r.json().catch(() => null) };
  } catch (e) { return { ok: false, status: 0, json: null }; }
}
app.get("/api/customer-karte", guard, async (req, res) => {
  const t = req.tenant; const c = t.store[req.query.id];
  if (!c) return res.json({ found: false });
  const enc = encodeURIComponent;
  const pid = req.query.patientId;
  const path = pid ? ("/karte?slug=" + enc(t.slug) + "&patientId=" + enc(pid)) : ("/karte?slug=" + enc(t.slug) + "&channel=" + enc(c.channel || "") + "&userId=" + enc(c.userId || ""));
  const r = await partnerGet(path);
  if (!r.ok || !r.json) return res.json({ found: false });
  res.json(r.json);
});
// 未入力回答URLは押下時に1件だけ生成（customer-context の遅延化に対応）
app.get("/api/customer-unanswered", guard, async (req, res) => {
  const t = req.tenant; const conv = t.store[req.query.id];
  if (!conv) return res.json({ ok: false });
  const enc = encodeURIComponent;
  const r = await partnerGet("/unanswered-url?slug=" + enc(t.slug) + "&appointmentId=" + enc(String(req.query.apptId || "")));
  if (!r.ok || !r.json) return res.json({ ok: false });
  res.json(r.json);
});
app.post("/api/customer-karte", guard, async (req, res) => {
  const t = req.tenant; const c = t.store[req.body.id];
  if (!c) return res.json({ ok: false, error: "no" });
  const action = req.body.action;
  let r;
  if (action === "add") r = await partnerPost("/karte", { slug: t.slug, patientId: req.body.patientId, body: req.body.body });
  else if (action === "edit") r = await partnerReq("PUT", "/karte", { slug: t.slug, recordId: req.body.recordId, body: req.body.body });
  else return res.json({ ok: false, error: "bad_action" });
  if (!r.json) return res.json({ ok: false });
  res.json(r.json);
});
app.post("/api/customer-appt-cancel", guard, async (req, res) => {
  const t = req.tenant; const c = t.store[req.body.id];
  if (!c) return res.json({ ok: false, error: "no" });
  const r = await partnerPost("/appointment-cancel", { slug: t.slug, appointmentId: req.body.appointmentId, reason: req.body.reason });
  if (!r.json) return res.json({ ok: false });
  res.json(r.json);
});
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
    + (c && notesBlock(c) ? "\n【このお客様への対応でスタッフが以前出した指示メモ（引き続き守る）】\n" + notesBlock(c) : "")
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
    if (c) { noteAdd(c, idea); dbSave(t, c); } // 方向性メモを次回以降の自動生成にも反映
    res.json({ ok: true, text });
  } catch (e) { res.json({ ok: false, error: String(e.message || e).slice(0, 80) }); }
});

// AIで作り直す（会話型）: 下書きをスタッフと会話しながら磨き上げる。
// うけつけるん連携時は、現在開いている会話の本人確認済み患者だけを予約操作候補にできる。
function staffBookingPrompt(ctx) {
  if (!ctx || !ctx.ok || !ctx.verified) return "";
  const patient = (ctx.patient && ctx.patient.name) || "患者";
  const appointments = Array.isArray(ctx.appointments) ? ctx.appointments : [];
  const list = appointments.length ? appointments.map(a => "・[ID:" + a.id + "] " + a.label + " " + (a.menu || "") + "（" + (a.statusJa || a.status || "") + (a.changeable ? "・操作可" : "・操作不可") + "）").join("\n") : "・今後の予約なし";
  return "\n\n【スタッフ用・うけつけるん連携】\n現在開いている会話は本人確認済みの " + patient + " 様です。対象予約:\n" + list
    + "\nスタッフが予約情報の確認を求めたら action type=context。特定日（YYYY-MM-DD）の空き枠を尋ねたら type=slots。キャンセルや日時変更を明確に依頼したら type=cancel/reschedule。"
    + "\n書き込み操作はactionを出しても即実行されず、画面に対象患者・予約・内容の確認カードが出る。スタッフがそのカードで実行を承認した時だけ処理される。"
    + "\n対象予約が複数あり特定できない、日付・時刻が不足、操作不可、または患者名を別人として指定している場合はactionをnoneにし、必要な確認をスタッフへ質問する。推測でIDや日時を補わない。";
}
// 共通部（会話文脈＋ルール＋方針）。出力形式だけ通常版(JSON)とストリーミング版(マーカー)で変える。
async function draftChatPrep(t, body) {
  const c = t.store[body.id] || null;
  if (!c) return { error: "no_conv" };
  const edits = (Array.isArray(body.messages) ? body.messages : []).slice(-14)
    .filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .map(m => ({ role: m.role, content: m.content.slice(0, 4000) }));
  while (edits.length && edits[0].role === "assistant") {
    edits[0] = { role: "user", content: "【現在の下書き（あなたが既に作成済み）】\n" + edits[0].content };
    if (edits[1] && edits[1].role === "user") { edits[0].content += "\n\n" + edits[1].content; edits.splice(1, 1); }
    break;
  }
  if (!edits.length || edits[edits.length - 1].role !== "user") return { error: "empty" };
  const conv = c.msgs.slice(-20).map(m => (m.from === "them" ? "お客様" : "クリニック") + ": " + (m.text || (m.media ? "［" + m.media + "］" : ""))).join("\n").slice(0, 6000);
  const lastQ = c.msgs.filter(m => m.from === "them").slice(-1).map(m => m.text || "").join("");
  const editTxt = edits.map(e => e.content).join(" ");
  const rel = rulesRanked(t, (lastQ + " " + editTxt).slice(0, 1500));
  const rulesTxt = rel.length ? rulesBlock(rel, ruleBudget(t)) : "";
  const today = new Date().toLocaleDateString("ja-JP", { year: "numeric", month: "long", day: "numeric", weekday: "short" });
  const sig = c.channel === "mail" ? "メールなので下書きの最後に改行して「" + (t.name || "クリニック") + " サポート」と署名を付ける。" : "LINEなので署名は付けない。";
  let baCtx = null;
  if (baEnabled(t) && PARTNER_KEY) {
    try { baCtx = await baCall(t, c, "context", {}, 12000); } catch (e) { baCtx = null; }
  }
  const base = "あなたは「" + (t.name || "クリニック") + "」の受付スタッフの返信作成アシスタントです。"
    + "スタッフと会話しながら、お客様への返信下書きを一緒に磨き上げます。あなたと会話しているのはスタッフで、下書きを送る相手はお客様です。"
    + "\n\n【お客様との会話履歴（この最新メッセージへの返信を作っている。必ず全体を読み込み、文脈を正確に踏まえること）】\n" + conv
    + "\n\n本日は" + today + "です。キャンセル料など日付が関わる案内は、本日と予約日の差から判断する。憶測で日付を決めない。"
    + "医療判断・診断はしない。断定的表現や絵文字は使わない。" + sig
    + (rulesTxt ? "\n\n【店舗ルール（料金・規定・対応可否はここに従い、推測で答えない）】\n" + rulesTxt : "")
    + (S(t).tone && S(t).tone.trim() ? "\n\n【トーン指示】\n" + S(t).tone.trim().slice(0, 1000) : "")
    + (prefsBlock(t) ? "\n\n【スタッフが記憶させた指示（全返信で必ず守る）】\n" + prefsBlock(t) : "")
    + (notesBlock(c) ? "\n\n【このお客様への対応でスタッフが以前出した指示メモ（引き続き守る）】\n" + notesBlock(c) : "")
    + staffBookingPrompt(baCtx)
    + "\n\n" + JP_QUALITY
    + "\n\nスタッフの指示がどんなに短くても（「あってる」「もっと短く」「優しく」等）、お客様との会話の文脈に当てはめて意味を解釈すること。"
    + "\n\n【会話の仕方】ChatGPTのような自然な会話相手として振る舞う。スタッフが指示ではなく質問・相談をしてきた場合（例:「キャンセル料っていくらだっけ？」「どっちの言い方がいいと思う？」）は、店舗ルールと会話文脈を踏まえて返事で普通に答え、下書きは変えなくてよい。指示が曖昧なら、解釈した上で作りつつ、返事で一言確認する。"
    + "\n\n【書き方の最重要方針】(1)スタッフの指示は的確に反映する。(2)指示されていない部分の内容・構成・言い回しは、むやみに書き換えない（前の下書きを土台に、指示箇所だけ直す。つながりが不自然になる場合の最小限の調整は可）。勝手に情報を足したり削ったりしない。(3)全体は優秀な受付スタッフが書くような、自然で読みやすく簡潔な文にする。形式的な前置き・保険表現を詰め込まない（店舗ルールで必須の情報がある時だけ補う）。";
  const engLabel = (S(t).engine === "gpt" && process.env.OPENAI_KEY) ? "GPT" : (S(t).engine === "gemini" && process.env.GEMINI_KEY) ? "Gemini" : (ANTHROPIC_KEY ? "Claude(保険)" : "AI");
  return { c, edits, base, engLabel, baCtx };
}

function normalizeStaffBookingAction(p, raw) {
  if (!p || !p.baCtx || !p.baCtx.ok || !p.baCtx.verified || !raw || typeof raw !== "object") return null;
  const type = String(raw.type || "none");
  if (!["context", "slots", "cancel", "reschedule"].includes(type)) return null;
  const appointments = Array.isArray(p.baCtx.appointments) ? p.baCtx.appointments : [];
  if (type === "context") return { type };
  const appointmentId = String(raw.appointmentId || "");
  const appointment = appointments.find(a => String(a.id) === appointmentId);
  if (!appointment) return null;
  if (type === "slots") {
    const date = String(raw.date || "");
    return /^\d{4}-\d{2}-\d{2}$/.test(date) ? { type, appointmentId, date } : null;
  }
  if (!appointment.changeable) return null;
  if (type === "cancel") return { type, appointmentId };
  const newDateTime = String(raw.newDateTime || "");
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(newDateTime)) return null;
  const dt = new Date(newDateTime + ":00+09:00");
  return !isNaN(dt.getTime()) && dt.getTime() > Date.now() ? { type, appointmentId, newDateTime } : null;
}
const DRAFTCHAT_MEMORY_RULE = "memory: スタッフの指示の中に『他の返信でも再利用できる、書き方・対応の方針』が含まれていれば、簡潔なルール文にして入れる。『今後』『常に』と明示していなくても、再利用できる方針なら拾う（例:「冒頭に様を付けない」「短めにする」「絵文字を使わない」「結論から書く」「予約はWeb予約に誘導する」「謝罪を一言入れる」等）。"
  + "ただし次は絶対にmemoryに入れない（空にする）: (1)その問い合わせ固有の事実・数値・個別判断（例:「この件は3営業日」「今回はキャンセル無料」「この人には◯◯と伝える」）。 (2)『今は』『今回は』『一旦』『今だけ』『この返信は』『とりあえず』など“今回限り・一時的”を少しでも示す指示。スタッフが今回だけのつもりで言った可能性が少しでもあれば入れない。明確に毎回・恒久的に守るべき方針だと確信できる時だけ入れる。"
  + "複数あれば最も方針性が高い1つだけ。再利用できる恒久方針が無ければ空にする。";
// 編集チャットからの「店舗の事実・規定」抽出ルール（memoryが書き方の方針を拾うのに対し、こちらは事実を店舗ルールへ）
const DRAFTCHAT_RULE_RULE = "rule: スタッフの指示の中に『店舗の事実・規定』（料金・可否・場所・アクセス・時間・持ち物・支払い方法・案内先・キャンセルや変更の規定など、他の患者への返信にも毎回そのまま使える情報）が含まれていれば、{\"title\":\"短い見出し\",\"content\":\"事実を簡潔に\"} の形で入れる。"
  + "患者固有の事情（氏名・個別の予約日時・体調）・今回限りの対応・推測は絶対に入れない。書き方やトーンの指示は rule ではなく memory の対象。確実な事実が無ければ null。";
// 編集チャットで出た事実を店舗ルールへ保存（ほぼ同文の既存ルールがあれば登録しない）
async function draftChatSaveRule(t, ruleObj) {
  try {
    if (typeof ruleObj === "string") { try { ruleObj = JSON.parse(ruleObj); } catch (e) { return null; } }
    if (!ruleObj || typeof ruleObj !== "object") return null;
    const title = String(ruleObj.title || "").trim().slice(0, 100);
    const content = String(ruleObj.content || "").trim().slice(0, 1000);
    if (!title || !content) return null;
    const dup = rulesSearch(t, title + " " + content, 1)[0];
    if (dup && similarEnough(dup.title + dup.content, title + content)) return null;
    const r = await ruleAdd(t, title, content);
    if (r) statBump(t, "rules");
    return r ? { id: r.id, title: r.title } : null;
  } catch (e) { return null; }
}
// 恒久メモリ（スタッフの記憶）への保存
function draftChatSaveMemory(t, memTxt) {
  memTxt = String(memTxt || "").trim().slice(0, 200);
  if (!memTxt) return "";
  const cur = (S(t).prefs && Array.isArray(S(t).prefs)) ? S(t).prefs : (S(t).prefs = []);
  if (cur.some(p => (typeof p === "string" ? p : p.text) === memTxt)) return "";
  cur.push({ id: Date.now(), text: memTxt }); while (cur.length > 40) cur.shift();
  saveTenantConfig(t).catch(() => {});
  return memTxt;
}
// このお客様向けの指示メモを更新（次回以降の自動下書きにも反映される）
function draftChatNote(t, c, edits) {
  const lastUser = edits.slice().reverse().find(m => m.role === "user");
  if (!lastUser) return;
  const txt = String(lastUser.content || "").replace(/^【[^】]*】\n?/, "").trim();
  if (!txt || /^(あってる|大丈夫|OK|ok|おけ|それでいい|いいね|良い)$/i.test(txt)) return;
  noteAdd(c, txt);
  dbSave(t, c);
}

app.post("/api/draft-chat", guard, async (req, res) => {
  const t = req.tenant;
  if (!ANTHROPIC_KEY && !process.env.OPENAI_KEY && !process.env.GEMINI_KEY) return res.json({ ok: false, error: "no_ai_key" });
  const p = await draftChatPrep(t, req.body);
  if (p.error) return res.json({ ok: false, error: p.error });
  const sys = p.base
    + "\n毎回、返信下書きの完成形の全文をdraftに入れる（下書きを変えない時は前と同じ全文）。replyにはスタッフへの返事（何をどう変えたか、または質問への答え。1〜3文。敬語でなくてよい）。"
    + "出力は必ず次のJSONのみ: {\"reply\":\"スタッフへの返事\",\"draft\":\"お客様への返信下書き全文\",\"memory\":\"\",\"rule\":null,\"action\":{\"type\":\"none|context|slots|cancel|reschedule\",\"appointmentId\":\"\",\"date\":\"YYYY-MM-DD\",\"newDateTime\":\"YYYY-MM-DDTHH:MM\"}}"
    + " actionは上のスタッフ用うけつけるん連携に該当する明確な依頼だけに使い、それ以外は必ずtype:none。"
    + "\n" + DRAFTCHAT_MEMORY_RULE
    + "\n" + DRAFTCHAT_RULE_RULE;
  try {
    const raw = await aiChat(t, sys, p.edits, 4000);
    if (!raw) return res.json({ ok: false, error: "ai_failed" });
    let out = { reply: "", draft: "" };
    try { const m = raw.match(/\{[\s\S]*\}/); out = JSON.parse(m ? m[0] : raw); } catch (e) { out = { reply: "", draft: salvageDraft(raw) }; }
    const savedMem = draftChatSaveMemory(t, out.memory);
    const savedRule = await draftChatSaveRule(t, out.rule); // 指示に含まれた店舗の事実をその場でルール学習
    const staffAction = normalizeStaffBookingAction(p, out.action);
    if (!staffAction) draftChatNote(t, p.c, p.edits); // 予約の一回限りの実行命令は恒久的な患者メモへ残さない
    res.json({ ok: true, reply: String(out.reply || "").slice(0, 600) + " 〔" + p.engLabel + "で作成〕", draft: String(out.draft || "").slice(0, 4000), memory: savedMem, rule: savedRule, action: staffAction });
  } catch (e) { res.json({ ok: false, error: String(e.message || e).slice(0, 80) }); }
});

// ストリーミング版（GPT風にリアルタイムで文字が流れる）。@@REPLY@@/@@DRAFT@@/@@MEMORY@@ のマーカー区切りテキストを
// chunked responseでそのまま流し、最後に @@META@@{json} を1行付ける。クライアントは逐次パースして表示する。
app.post("/api/draft-chat-stream", guard, async (req, res) => {
  const t = req.tenant;
  if (!ANTHROPIC_KEY && !process.env.OPENAI_KEY && !process.env.GEMINI_KEY) { res.status(400).end("no_ai_key"); return; }
  const p = await draftChatPrep(t, req.body);
  if (p.error) { res.status(400).end(p.error); return; }
  const sys = p.base
    + "\n\n【出力形式（厳守）】JSONではなく、次の4セクションをこの順で出力する。各マーカーは必ず行頭に単独で書く。"
    + "\n@@REPLY@@\n（スタッフへの返事。何をどう変えたか、または質問への答え。1〜3文。敬語でなくてよい）"
    + "\n@@DRAFT@@\n（お客様への返信下書きの完成形全文。下書きを変えない時は前と同じ全文。スタッフの質問に答えただけで下書き不要な時はこのセクションごと省略してよい）"
    + "\n@@MEMORY@@\n（" + DRAFTCHAT_MEMORY_RULE + "無ければこの行のあとに何も書かない）"
    + "\n@@RULE@@\n（" + DRAFTCHAT_RULE_RULE + " ある場合のみ {\"title\":\"…\",\"content\":\"…\"} のJSON1行。無ければこの行のあとに何も書かない）"
    + "\n@@ACTION@@\n（スタッフが上のうけつけるん操作を明確に依頼した場合のみ {\"type\":\"context|slots|cancel|reschedule\",\"appointmentId\":\"…\",\"date\":\"YYYY-MM-DD\",\"newDateTime\":\"YYYY-MM-DDTHH:MM\"} のJSON1行。それ以外は {\"type\":\"none\"}）";
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("X-Accel-Buffering", "no");
  try {
    let full = await aiChatStream(t, sys, p.edits, 4000, (d) => { try { res.write(d); } catch (e) {} });
    if (!full) { // ストリーム不可時は非ストリームで生成して一括送信
      full = await aiChat(t, sys, p.edits, 4000);
      if (full) res.write(full);
    }
    let savedMem = "", savedRule = null, staffAction = null;
    if (full) {
      const mm = full.match(/@@MEMORY@@\s*([\s\S]*)$/);
      savedMem = draftChatSaveMemory(t, mm ? mm[1].split(/@@/)[0] : "");
      const rm = full.match(/@@RULE@@\s*([\s\S]*)$/); // 指示に含まれた店舗の事実をその場でルール学習
      if (rm) {
        const rtxt = rm[1].split(/@@/)[0].trim();
        const jm = rtxt.match(/\{[\s\S]*?\}/); // 非貪欲：万一2個出力されても先頭の1個を拾う
        if (jm) savedRule = await draftChatSaveRule(t, jm[0]);
      }
      const am = full.match(/@@ACTION@@\s*([\s\S]*)$/);
      if (am) {
        const atxt = am[1].split(/@@/)[0].trim();
        const aj = atxt.match(/\{[\s\S]*?\}/);
        if (aj) { try { staffAction = normalizeStaffBookingAction(p, JSON.parse(aj[0])); } catch (e) {} }
      }
      if (!staffAction) draftChatNote(t, p.c, p.edits); // 予約の一回限りの実行命令は恒久的な患者メモへ残さない
    }
    res.write("\n@@META@@" + JSON.stringify({ ok: !!full, memory: savedMem, rule: savedRule, engine: p.engLabel, action: staffAction }));
  } catch (e) {
    try { res.write("\n@@META@@" + JSON.stringify({ ok: false, error: String(e.message || e).slice(0, 80) })); } catch (e2) {}
  }
  res.end();
});

function staffAppointmentById(ctx, id) {
  return ctx && Array.isArray(ctx.appointments) ? ctx.appointments.find(a => String(a.id) === String(id || "")) : null;
}
function staffContextText(ctx) {
  const patient = (ctx.patient && ctx.patient.name) || "患者";
  const list = Array.isArray(ctx.appointments) ? ctx.appointments : [];
  if (!list.length) return patient + "様の今後の予約はありません。";
  return patient + "様の予約:\n" + list.map(a => "・" + a.label + " " + (a.menu || "") + "（" + (a.statusJa || a.status || "") + "）").join("\n");
}
async function staffBookingContext(t, c) {
  if (!baEnabled(t) || !PARTNER_KEY) return { error: "not_linked" };
  const ctx = await baCall(t, c, "context", {}, 15000);
  if (!ctx || !ctx.ok) return { error: "partner_unavailable" };
  if (!ctx.verified) return { error: "patient_not_verified" };
  return { ctx };
}

app.get("/api/staff-booking-pending", guard, (req, res) => {
  const c = req.tenant.store[String(req.query.id || "")];
  if (!c || !c.staffBookingPending) return res.json({ ok: true, pending: null });
  if (!c.staffBookingPending.expiresAt || Date.parse(c.staffBookingPending.expiresAt) <= Date.now()) {
    c.staffBookingPending = null; dbSave(req.tenant, c); return res.json({ ok: true, pending: null });
  }
  res.json({ ok: true, pending: Object.assign({ kind: "confirm", conversationId: c.id, warning: "まだ実行されていません。対象患者・予約・内容を確認してください。" }, c.staffBookingPending) });
});

// スタッフチャットからの予約操作。読み取りは即時、書き込みはproposeまでで止め、別APIの明示承認を必須にする。
app.post("/api/staff-booking-action", guard, async (req, res) => {
  const t = req.tenant;
  const c = t.store[String(req.body.id || "")];
  if (!c) return res.status(404).json({ ok: false, error: "no_conv" });
  const type = String(req.body.type || "");
  if (!["context", "slots", "cancel", "reschedule"].includes(type)) return res.status(400).json({ ok: false, error: "bad_action" });
  const checked = await staffBookingContext(t, c);
  if (checked.error) return res.status(400).json({ ok: false, error: checked.error });
  const ctx = checked.ctx;
  if (type === "context") return res.json({ ok: true, kind: "info", text: staffContextText(ctx) });
  const appointmentId = String(req.body.appointmentId || "");
  const appt = staffAppointmentById(ctx, appointmentId);
  if (!appt) return res.status(400).json({ ok: false, error: "appointment_mismatch" });
  if (type === "slots") {
    const date = String(req.body.date || "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ ok: false, error: "bad_date" });
    const out = await baCall(t, c, "slots", { appointmentId, date }, 20000);
    if (!out || !out.ok) return res.status(502).json({ ok: false, error: (out && out.error) || "partner_unavailable" });
    const slots = Array.isArray(out.slots) ? out.slots : [];
    const text = slots.length ? date + " の空き枠:\n" + slots.map(x => "・" + x.label).join("\n") : date + " に空き枠はありません。";
    return res.json({ ok: true, kind: "info", text });
  }
  if (!appt.changeable) return res.status(400).json({ ok: false, error: "not_changeable" });
  if (c.ba && c.ba.pending) return res.status(409).json({ ok: false, error: "patient_confirmation_pending" });
  if (c.staffBookingPending && c.staffBookingPending.expiresAt && Date.parse(c.staffBookingPending.expiresAt) > Date.now()) return res.status(409).json({ ok: false, error: "staff_confirmation_pending" });
  if (c.staffBookingPending) { c.staffBookingPending = null; dbSave(t, c); }
  let extra = { kind: type, appointmentId };
  let operation = type === "cancel" ? "キャンセル" : "日時変更";
  if (type === "reschedule") {
    const newDateTime = String(req.body.newDateTime || "");
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(newDateTime)) return res.status(400).json({ ok: false, error: "bad_datetime" });
    const dt = new Date(newDateTime + ":00+09:00");
    if (isNaN(dt.getTime()) || dt.getTime() <= Date.now()) return res.status(400).json({ ok: false, error: "bad_datetime" });
    extra.newStartsAt = dt.toISOString();
    operation += " → " + dt.toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", month: "long", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit" });
  }
  const proposed = await baCall(t, c, "propose", Object.assign({ actor: "staff" }, extra), 20000);
  if (!proposed || !proposed.ok || !proposed.requestId) return res.status(400).json({ ok: false, error: (proposed && proposed.error) || "partner_unavailable", alternatives: proposed && proposed.alternatives });
  const patientName = (ctx.patient && ctx.patient.name) || c.name || "患者";
  const summary = "対象患者: " + patientName + "様\n対象予約: " + appt.label + " " + (appt.menu || "") + "\n実行内容: " + operation;
  c.staffBookingPending = { requestId: proposed.requestId, expiresAt: proposed.expiresAt, summary, type, appointmentId };
  dbSave(t, c);
  res.json({ ok: true, kind: "confirm", conversationId: c.id, requestId: proposed.requestId, expiresAt: proposed.expiresAt, summary, warning: "まだ実行されていません。対象患者・予約・内容を確認してください。" });
});

app.post("/api/staff-booking-confirm", guard, async (req, res) => {
  const t = req.tenant;
  const c = t.store[String(req.body.id || "")];
  if (!c) return res.status(404).json({ ok: false, error: "no_conv" });
  const pending = c.staffBookingPending;
  const requestId = String(req.body.requestId || "");
  if (!pending || !requestId || pending.requestId !== requestId) return res.status(409).json({ ok: false, error: "no_pending" });
  if (!pending.expiresAt || Date.parse(pending.expiresAt) <= Date.now()) { c.staffBookingPending = null; dbSave(t, c); return res.status(409).json({ ok: false, error: "expired" }); }
  const approve = req.body.approve === true;
  let out = await baCall(t, c, "confirm", { requestId, approve, actor: "staff" }, 25000);
  if (!out && approve) {
    for (let i = 0; i < 2 && !out; i++) {
      await new Promise(resolve => setTimeout(resolve, 2000));
      const result = await baCall(t, c, "result", { requestId }, 8000);
      if (result && result.ok && result.status === "executed") out = { ok: true, done: true, text: result.text };
      else if (result && result.ok && result.status === "failed") out = { ok: false, error: "failed" };
    }
  }
  if (!out) return res.status(504).json({ ok: false, error: "result_unknown", text: "結果を確認できません。うけつけるんの予約詳細で状態を確認してください。" });
  c.staffBookingPending = null;
  dbSave(t, c);
  if (!approve) return res.json({ ok: true, done: false, text: "実行を取り消しました。予約は変更していません。" });
  if (!out.ok) return res.status(400).json({ ok: false, error: out.error || "failed", text: out.text || "処理できませんでした。うけつけるんで予約状態を確認してください。", alternatives: out.alternatives });
  res.json({ ok: true, done: true, text: out.text || "予約操作が完了しました。" });
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
  // fail-closed: INGEST_KEY未設定なら常に拒否。鍵はヘッダ x-key のみ受理（bodyのkey受理は廃止）。定数時間比較。
  if (!INGEST_KEY || !safeEq(req.headers["x-key"], INGEST_KEY)) return res.status(401).json({ error: "bad key" });
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
  // fail-closed: INGEST_KEY未設定なら常に拒否。GETのためヘッダ x-key またはクエリ key を受理。定数時間比較。
  if (!INGEST_KEY || !safeEq(req.headers["x-key"] || req.query.key, INGEST_KEY)) return res.status(401).json({ error: "bad key" });
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
function partnerOk(req){ return !!ADMIN_SECRET && safeEq(req.headers["x-partner-key"], ADMIN_SECRET); }
function pGuard(req,res,next){ if(partnerOk(req)) return next(); res.status(401).json({error:"auth"}); }
const SSO_TOKENS = {}; // token -> {slug, exp}
const RESET_REQ_AT = {}; // email -> 最終リクエスト時刻(ms)。簡易レート制限
app.get("/api/partner/tenants", pGuard, (req,res)=>{
  res.json(Object.values(TEN).map(t=>({ slug:t.slug, name:t.name,
    convos:Object.keys(t.store||{}).length, rules:Object.keys(t.rules||{}).length,
    line: !!(t.config.conn&&t.config.conn.lineToken), mail: !!(t.config.conn&&t.config.conn.smtpUser),
    accountEmailConfigured: !!normalizeEmail(t.config.accountEmail),
    suspended: !!t.config.suspended })));
});
app.get("/api/partner/conn", pGuard, (req,res)=>{
  const t = TEN[String(req.query.slug||"")]; if(!t) return res.status(404).json({error:"no_tenant"});
  const cn = t.config.conn || {};
  res.json({ slug:t.slug, name:t.name, loginId:t.config.loginId||t.slug, accountEmail:normalizeEmail(t.config.accountEmail),
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
  const accountEmail = normalizeEmail(req.body.accountEmail);
  if(!accountEmail) return res.status(400).json({ok:false,error:"bad_email"});
  let slug = String(req.body.slug||"").trim().toLowerCase().replace(/[^a-z0-9-]/g,"").slice(0,30);
  if(slug && TEN[slug]) return res.status(409).json({ok:false,error:"slug_exists"});
  if(!slug){ slug = slugify(name); if(TEN[slug]) return res.status(409).json({ok:false,error:"slug_exists"}); }
  // パスワード未指定ならランダム生成（顧客はSSO経由で入る。後からパスワード設定も可能）
  const pass = String(req.body.password||"") || crypto.randomBytes(12).toString("hex");
  const config = { passHash: hashPassword(pass), accountEmail, conn: {}, settings: { autoReply: false, level: "high", tone: "" } };
  const t = TEN[slug] = newTenant(slug, name, config);
  if(pool){ try{ await pool.query("INSERT INTO tenants (slug,name,config) VALUES ($1,$2,$3)", [slug, name, t.config]); }catch(e){ delete TEN[slug]; return res.status(500).json({ok:false,error:"db"}); } }
  res.status(201).json({ slug, name, loginId:slug, accountEmailConfigured:true });
});
app.put("/api/partner/account", pGuard, async (req,res)=>{
  const t = TEN[String(req.body.slug||"")]; if(!t) return res.status(404).json({ok:false,error:"no_tenant"});
  const email = normalizeEmail(req.body.accountEmail);
  if(!email) return res.status(400).json({ok:false,error:"bad_email"});
  const prev = t.config.accountEmail; t.config.accountEmail = email;
  try{ await saveTenantConfig(t); }
  catch(e){ t.config.accountEmail = prev; return res.status(500).json({ok:false,error:"db"}); }
  res.json({ok:true,accountEmail:email,loginId:t.config.loginId||t.slug});
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
  t.config.passHash = hashPassword(pw);
  destroyAllSessions(t); // ログイン再発行で旧セッションを全破棄
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
// 受付くんが別経路で送ったLINE本文を右腕くんの会話履歴へ同期する。
// LINE側には送信履歴本文を取得するAPIがないため、送信元の成功ログをID付きで冪等に取り込む。
app.post("/api/partner/outbound-events", pGuard, async (req,res)=>{
  const t = TEN[String(req.body.slug||"")];
  if(!t) return res.status(404).json({ok:false,error:"no_tenant"});
  const input = Array.isArray(req.body.events) ? req.body.events.slice(0,200) : [];
  const accepted = [];
  const baseTs = new Map();
  // 既存履歴より古いバックフィルは新しい順にunshiftすると最終的に時系列順になる。新着は古い順にpushする。
  input.sort((a,b)=>Number(a&&a.ts||0)-Number(b&&b.ts||0));
  const old = [], fresh = [];
  for(const ev of input){
    const uid = String(ev&&ev.userId||"").trim();
    const c = t.store["line:"+uid];
    const cutoff = c ? Number(c.ts||0) : 0;
    (Number(ev&&ev.ts||0) > 0 && Number(ev.ts) <= cutoff ? old : fresh).push(ev);
  }
  const ordered = old.sort((a,b)=>Number(b.ts||0)-Number(a.ts||0)).concat(fresh.sort((a,b)=>Number(a.ts||0)-Number(b.ts||0)));
  for(const ev of ordered){
    const eventId = String(ev&&ev.id||"").trim().slice(0,200);
    const channel = String(ev&&ev.channel||"");
    const uid = String(ev&&ev.userId||"").trim().slice(0,200);
    const text = String(ev&&ev.text||"").trim().slice(0,5000);
    const sentAt = Number(ev&&ev.ts||0);
    if(!eventId || channel!=="line" || !uid || !text || !Number.isFinite(sentAt) || sentAt<=0) continue;
    const id = "line:"+uid;
    let c = t.store[id];
    if(!c){ c=t.store[id]={id,userId:uid,name:String(ev.name||"LINEのお客様").slice(0,120),channel:"line",color:colorFor(id),status:"done",flag:false,msgs:[],draft:"",ts:0}; }
    if(!baseTs.has(id)) baseTs.set(id, Number(c.ts||0));
    if((c.msgs||[]).some(m=>m&&(m.externalEventId===eventId||(Array.isArray(m.externalEventAliases)&&m.externalEventAliases.includes(eventId))))){ accepted.push(eventId); continue; }
    // 右腕くん経由send-lineの直後に同じmessage_logが再同期された場合は、既存1通へIDだけ付けて二重表示しない。
    const candidates = (c.msgs||[]).filter(m=>{ if(!m||m.from!=="us"||(m.via!=="partner"&&m.via!=="uketsukerun")) return false; const mt=String(m.text||"").trim(); const bodyMatch=mt===text||(Math.min(mt.length,text.length)>=8&&(mt.includes(text)||text.includes(mt))); return bodyMatch&&Math.abs(Number(m.sentAt||0)-sentAt)<120000; }).sort((a,b)=>Math.abs(Number(a.sentAt||0)-sentAt)-Math.abs(Number(b.sentAt||0)-sentAt));
    const same = candidates[0];
    if(same){ if(same.externalEventId&&same.externalEventId!==eventId){ same.externalEventAliases=Array.isArray(same.externalEventAliases)?same.externalEventAliases:[]; if(!same.externalEventAliases.includes(eventId)) same.externalEventAliases.push(eventId); }else same.externalEventId=eventId; same.via="uketsukerun"; if(ev.name&&(!c.name||c.name==="LINEのお客様")) c.name=String(ev.name).slice(0,120); if(!await dbSave(t,c)) return res.status(500).json({ok:false,error:"db"}); accepted.push(eventId); continue; }
    const d = new Date(sentAt);
    const time = Number.isFinite(d.getTime()) ? d.toLocaleTimeString("ja-JP",{timeZone:"Asia/Tokyo",hour:"2-digit",minute:"2-digit",hour12:false}) : nowt();
    const msg={from:"us",text,time,sentAt,via:"uketsukerun",externalEventId:eventId,template:String(ev.template||"").slice(0,120)};
    const cutoff = baseTs.get(id)||0;
    if(cutoff && sentAt<=cutoff) c.msgs.unshift(msg); else c.msgs.push(msg);
    if(sentAt>=Number(c.ts||0)){ c.ts=sentAt; c.time=time; c.last=lastText(c); }
    if(ev.name&&(!c.name||c.name==="LINEのお客様")) c.name=String(ev.name).slice(0,120);
    if(!await dbSave(t,c)) return res.status(500).json({ok:false,error:"db"}); accepted.push(eventId);
  }
  console.log("partner outbound-events:", t.slug, "received=" + input.length, "accepted=" + accepted.length);
  res.json({ok:true,accepted});
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
    if(c){ const sentAt=Date.now(); c.msgs.push({ from:"us", text, time: nowt(), sentAt, via:"partner" }); c.time = nowt(); c.ts = sentAt; c.last = lastText(c); dbSave(t, c); }
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
setInterval(()=>{ const now=Date.now(); for(const k of Object.keys(SSO_TOKENS)) if(SSO_TOKENS[k].exp < now) delete SSO_TOKENS[k]; }, 60000);

// ===== パスワードを忘れた方（顧客の自己解決リセット。右腕くん単独で完結） =====
function tenantByRecovery(loginId, email){
  const id = String(loginId || "").trim();
  const e = normalizeEmail(email);
  if(!id || !e) return null;
  const t = Object.values(TEN).find(x => !x.config.suspended && (x.config.loginId || x.slug) === id);
  if(!t) return null;
  const registered = normalizeEmail(t.config.accountEmail);
  if(registered) return safeEq(registered, e) ? t : null;
  // 従来テナントはアカウントメールが未登録なので、既存の送受信メールだけを移行用に許可する。
  return mailAccounts(t).some(a => normalizeEmail(a.smtpUser) === e || normalizeEmail(a.imapUser) === e) ? t : null;
}
function resetTokenTenant(token){
  const hash = sha(String(token || ""));
  return Object.values(TEN).find(t => t.config.passwordReset && t.config.passwordReset.exp > Date.now() && safeEq(t.config.passwordReset.hash, hash)) || null;
}
function resetMailAccount(t){
  if(RESET_SMTP.user && RESET_SMTP.pass) return { smtpHost:RESET_SMTP.host, smtpPort:RESET_SMTP.port, smtpUser:RESET_SMTP.user, smtpPass:RESET_SMTP.pass, from:RESET_SMTP.from };
  const a = mailAccounts(t)[0];
  return a ? Object.assign({ from:a.smtpUser }, a) : null;
}
async function sendResetEmail(t, toEmail, link){
  const a = resetMailAccount(t);
  if(!a) return "no_mail_config";
  try{
    const nodemailer = require("nodemailer");
    const tp = nodemailer.createTransport({ host:a.smtpHost, port:a.smtpPort, secure:a.smtpPort===465, auth:{user:a.smtpUser, pass:a.smtpPass} });
    const info = await tp.sendMail({
      from: (t.name || "右腕くん") + " <" + a.from + ">",
      to: toEmail,
      subject: "【受信トレイ】パスワード再設定のご案内",
      text: "受信トレイのパスワード再設定リクエストを受け付けました。\n下記リンクから新しいパスワードを設定してください（1時間有効・1回のみ）。\n\n" + link + "\n\nお心当たりが無い場合はこのメールを破棄してください。"
    });
    const accepted = Array.isArray(info.accepted) && info.accepted.some(x => normalizeEmail(x) === normalizeEmail(toEmail));
    if(!accepted) return "recipient_not_accepted";
    console.log("forgot: reset mail accepted for", t.slug);
    return "accepted";
  }catch(e){
    console.error("reset-mail:", e.message);
    if(e && e.code === "EAUTH") return "smtp_auth_failed";
    if(/sender/i.test(String(e && e.message || ""))) return "sender_rejected";
    if(/recipient/i.test(String(e && e.message || ""))) return "recipient_rejected";
    return "smtp_failed";
  }
}
async function issuePasswordReset(t, toEmail, baseUrl){
  const base = String(baseUrl || "").replace(/\/$/, "");
  if(!/^https:\/\//i.test(base)) return "invalid_base_url";
  const tok = crypto.randomBytes(24).toString("hex");
  t.config.passwordReset = { hash:sha(tok), exp:Date.now() + 60*60000 }; // raw tokenは保存しない
  await saveTenantConfig(t);
  const mailStatus = await sendResetEmail(t, toEmail, base + "/reset?token=" + tok);
  if(mailStatus !== "accepted"){
    delete t.config.passwordReset;
    await saveTenantConfig(t);
  }
  return mailStatus;
}
// 運営画面から登録済み管理者メールへ再設定リンクを送る。パスワードやトークンは返さない。
app.post("/api/partner/password-reset", pGuard, async (req,res)=>{
  const t = TEN[String(req.body.slug||"")];
  if(!t || t.config.suspended) return res.status(404).json({ok:false,error:"no_tenant"});
  const email = normalizeEmail(t.config.accountEmail);
  if(!email) return res.status(400).json({ok:false,error:"account_email_required"});
  try{
    const base = String(PUBLIC_BASE_URL || ("https://" + (req.headers["x-forwarded-host"] || req.headers.host || "")));
    const mailStatus = await issuePasswordReset(t, email, base);
    if(mailStatus !== "accepted") return res.status(502).json({ok:false,error:"reset_mail_unavailable"});
    console.log("partner password-reset: reset mail accepted for", t.slug);
    res.json({ok:true,loginId:t.config.loginId||t.slug});
  }catch(e){
    console.error("partner password-reset:", e.message);
    res.status(500).json({ok:false,error:"reset_failed"});
  }
});
app.get("/forgot", (req,res)=>{ res.set("Content-Type","text/html; charset=utf-8"); res.set("Cache-Control","no-store"); res.send(FORGOT_PAGE); });
app.post("/api/forgot", async (req,res)=>{
  const email = normalizeEmail(req.body.email);
  const loginId = String(req.body.loginId||"").trim();
  const requestHost = String(req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim().toLowerCase();
  const e2eDebug = requestHost === "clinic-platform-staging.up.railway.app" && req.get("x-e2e-test") === "rightarm-reset-test";
  let debug = "rate_limited";
  try{
    const now = Date.now();
    const rateKey = sha(loginId + "|" + email);
    if(email && loginId && !(RESET_REQ_AT[rateKey] && now - RESET_REQ_AT[rateKey] < 60000)){
      RESET_REQ_AT[rateKey] = now;
      const t = tenantByRecovery(loginId, email);
      if(t){
        const base = String(PUBLIC_BASE_URL || ("https://" + (req.headers["x-forwarded-host"] || req.headers.host || ""))).replace(/\/$/, "");
        const mailStatus = await issuePasswordReset(t, email, base);
        if(mailStatus !== "accepted") console.error("forgot: reset mail unavailable for", t.slug);
        debug = mailStatus;
      }else{ debug = "lookup_failed"; console.warn("forgot: recovery lookup failed"); }
    }
  }catch(e){ console.error("forgot:", e.message); }
  res.json(e2eDebug ? { ok:true, debug } : { ok:true }); // 通常応答は列挙対策で登録有無に関わらず常に成功扱い
});
app.get("/reset", (req,res)=>{
  res.set("Content-Type","text/html; charset=utf-8"); res.set("Cache-Control","no-store");
  const t = resetTokenTenant(req.query.token);
  if(!t) return res.send(RESET_INVALID_PAGE);
  res.send(RESET_PAGE(String(req.query.token||"")));
});
app.post("/api/reset", async (req,res)=>{
  const tok = String(req.body.token||"");
  const password = String(req.body.password||"");
  const t = resetTokenTenant(tok);
  if(!t) return res.status(400).json({ ok:false, error:"expired" });
  if(password.length < 8) return res.status(400).json({ ok:false, error:"too_short" });
  const prev = t.config.passHash, prevReset = t.config.passwordReset;
  t.config.passHash = hashPassword(password);
  delete t.config.passwordReset;
  destroyAllSessions(t); // パスワード再設定で既存セッションを全破棄
  try{ await saveTenantConfig(t); }
  catch(err){ t.config.passHash = prev; t.config.passwordReset = prevReset; return res.status(500).json({ ok:false, error:"db" }); }
  console.log("self password reset:", t.slug);
  res.json({ ok:true });
});

app.get("/", (req, res) => { res.set("Content-Type", "text/html; charset=utf-8"); res.set("Cache-Control", "no-store"); res.send(tenantFromReq(req) ? PAGE : LOGIN_PAGE); });
app.get("/signup", (req, res) => res.redirect("/")); // 申込みは営業契約後に運営が作成
app.get("/board", (req, res) => { res.set("Content-Type", "text/html; charset=utf-8"); res.set("Cache-Control", "no-store"); res.send(tenantFromReq(req) ? BOARD_PAGE : LOGIN_PAGE); });
(async () => {
  if (!CRED_KEY) console.warn("CRED_KEY 未設定: メール/LINE資格情報の at-rest 暗号化は無効です（平文で保存・動作）。設定すると次回保存時から自動的に暗号化されます。");
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
<div style="font-size:13px;color:#6b7280;margin-bottom:16px;">ログインIDと、アカウント設定に登録したメールアドレスを入力してください。</div>
<input id="lid" placeholder="ログインID" autocapitalize="off" autofocus style="width:100%;box-sizing:border-box;padding:11px;border:1px solid #d1d5db;border-radius:8px;font-size:15px;margin-bottom:10px;">
<input id="em" type="email" placeholder="登録メールアドレス" autocapitalize="off" style="width:100%;box-sizing:border-box;padding:11px;border:1px solid #d1d5db;border-radius:8px;font-size:15px;margin-bottom:10px;" onkeydown="if(event.key==='Enter'&&!event.isComposing&&event.keyCode!==229)send()">
<button onclick="send()" id="sb" style="width:100%;padding:11px;border:none;border-radius:8px;background:#06c755;color:#fff;font-size:15px;font-weight:600;cursor:pointer;">再設定リンクを送る</button>
<div id="msg" style="font-size:12px;margin-top:10px;min-height:14px;color:#374151;"></div>
<div style="text-align:center;margin-top:12px;font-size:12px;"><a href="/" style="color:#06c755;text-decoration:none;">ログインに戻る</a></div></div>
<script>async function send(){const loginId=document.getElementById("lid").value.trim(),email=document.getElementById("em").value.trim(),b=document.getElementById("sb"),m=document.getElementById("msg");if(!loginId||!email){m.textContent="ログインIDと登録メールアドレスを入力してください";return;}b.disabled=true;try{await fetch("/api/forgot",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({loginId,email})});}catch(e){}m.textContent="入力内容が登録情報と一致する場合、再設定リンクをお送りしました。届かない場合は迷惑メールをご確認のうえ、運営にお問い合わせください。";b.disabled=false;}</script>
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
  #chat{flex:1;display:flex;flex-direction:column;min-width:0;background:var(--chatbg);position:relative;}
  #chatHead{display:flex;align-items:center;gap:10px;padding:10px 14px;background:var(--panel);border-bottom:1px solid var(--line);}
  #backBtn{display:none;border:none;background:none;font-size:20px;cursor:pointer;color:var(--text);}
  #chatName{font-weight:600;flex:1;}
  .hbtn{font-size:12px;padding:6px 10px;border:1px solid var(--line);background:#fff;border-radius:8px;cursor:pointer;white-space:nowrap;}
  .custPanel{background:var(--panel);border-bottom:1px solid var(--line);padding:8px 12px;font-size:12px;color:var(--text);line-height:1.5;word-break:break-word;}
  .custPanel .cpTitle{font-weight:600;}
  .cpRow{padding:2px 0;}
  .cpMuted{color:var(--muted);}
  .cpInput{width:100%;box-sizing:border-box;margin-top:6px;padding:6px 8px;border:1px solid var(--line);border-radius:6px;font-size:12px;}
  .cpCand{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:4px 0;border-top:1px solid var(--line);}
  .cpBtnRow{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px;}
  .cpLink,.cpBtn{font-size:12px;padding:4px 8px;border:1px solid var(--line);background:#fff;border-radius:6px;cursor:pointer;white-space:nowrap;color:var(--text);}
  .custPanel{transition:max-height .28s ease,opacity .2s ease;overflow:hidden;}
  .cpGrip{display:flex;align-items:center;justify-content:center;gap:8px;padding:3px;border-top:1px solid #f3f4f6;cursor:pointer;}
  .cpGripBar{width:34px;height:4px;border-radius:3px;background:#d1d5db;}
  .custTab{display:flex;align-items:center;justify-content:center;gap:6px;background:#f0fdf4;border-bottom:1px solid #e5e7eb;padding:5px;font-size:11px;color:#15803d;cursor:pointer;}
  .cpCancel{border-color:#f0999b;background:#fdecec;color:#b3261e;}
  .cpKarte{border-color:#0f766e;background:#0f766e;color:#fff;}
  /* ── 顧客ヘッダーカード（次回予約・最終来院・カルテ）: うけつけるんカレンダー同等の見た目 ── */
  .cpCards{display:flex;gap:8px;margin-top:8px;}
  @media(max-width:700px){ .cpCards{flex-direction:column;} }
  .cpCard{flex:1;border:1px solid #e5e7eb;border-radius:10px;padding:8px 10px 8px 14px;position:relative;overflow:hidden;background:#fff;min-width:0;}
  .cpStripe{position:absolute;left:0;top:0;bottom:0;width:4px;background:#9ca3af;}
  .cpCard .cpTtl,.cpKHead .cpTtl{font-size:10.5px;font-weight:700;color:#6b7280;display:flex;align-items:center;gap:5px;flex-wrap:wrap;}
  .cpBadge{font-size:10px;font-weight:700;border-radius:9999px;padding:1.5px 8px;background:#e5e7eb;color:#4b5563;}
  .cpBadge.bk-green{background:#d1fae5;color:#047857;}
  .cpBadge.bk-amber{background:#fef3c7;color:#b45309;}
  .cpBadge.bk-blue{background:#dbeafe;color:#1d4ed8;}
  .cpBadge.bk-red{background:#fee2e2;color:#b91c1c;}
  .cpWhen{font-size:13.5px;font-weight:700;margin-top:3px;letter-spacing:.01em;}
  .cpMenuLine{display:flex;align-items:center;gap:6px;margin-top:3px;font-size:12px;color:#374151;flex-wrap:wrap;}
  .cpMColor{width:10px;height:10px;border-radius:3px;flex-shrink:0;border:1px solid rgba(0,0,0,.08);display:inline-block;}
  .cpLoc{color:#6b7280;font-size:11px;}
  .cpCard.cpNext{background:#f0fdfa;border-color:#99f6e4;}
  .cpCard.cpNext .cpStripe{background:#0d9488;}
  .cpCardCancel{margin-left:auto;font-size:10.5px;padding:2px 8px;}
  .cpKarteCard{margin-top:8px;border:1px solid #fde68a;background:#fffbeb;border-radius:10px;position:relative;overflow:hidden;}
  .cpKarteCard>.cpStripe{background:#f59e0b;}
  .cpKHead{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:7px 12px 5px 14px;}
  .cpKOpen{font-size:10.5px;color:#0d9488;font-weight:600;cursor:pointer;background:none;border:none;padding:0;white-space:nowrap;}
  .cpKWrap{position:relative;margin:0 12px 8px 14px;}
  .cpKScroll{position:relative;max-height:150px;overflow-y:auto;padding:6px 10px 26px;background:#fff;border:1px solid #f3e3ab;border-radius:8px;}
  .cpKScroll::-webkit-scrollbar{width:12px;}
  .cpKScroll::-webkit-scrollbar-thumb{background:#f59e0b;border-radius:6px;border:3px solid #fff;}
  .cpKScroll::-webkit-scrollbar-track{background:#fdf3d3;border-radius:6px;border:3px solid #fff;}
  .cpKFade{position:absolute;left:1px;right:13px;bottom:1px;height:34px;border-radius:0 0 8px 8px;background:linear-gradient(to bottom,rgba(255,255,255,0),#fff 78%);pointer-events:none;}
  .cpKMore{position:absolute;left:50%;transform:translateX(-50%);bottom:6px;background:#f59e0b;color:#fff;font-size:10px;font-weight:700;border-radius:9999px;padding:2.5px 12px;box-shadow:0 1px 4px rgba(180,83,9,.35);pointer-events:none;white-space:nowrap;}
  .cpKEntry{padding:7px 0 8px;border-top:1px dashed #f1e2ac;}
  .cpKEntry:first-child{border-top:none;padding-top:2px;}
  .cpKDate{font-size:11px;font-weight:700;color:#b45309;}
  .cpKDate .cpKMenu{font-weight:400;color:#92400e;font-size:10.5px;margin-left:6px;}
  .cpKTxt{font-size:11.5px;color:#57534e;line-height:1.6;margin-top:2px;white-space:pre-wrap;word-break:break-word;}
  #karteOv{position:absolute;left:0;right:0;top:0;bottom:0;background:rgba(0,0,0,.35);z-index:20;display:none;}
  .karteCard{position:absolute;left:8px;right:8px;top:8px;bottom:8px;background:#fff;border-radius:14px;overflow:hidden;display:flex;flex-direction:column;}
  .karteHd{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid #e5e7eb;font-weight:600;font-size:13px;}
  .karteHd .kClose{margin-left:auto;border:none;background:none;font-size:18px;cursor:pointer;color:#6b7280;}
  .karteBody{flex:1;overflow-y:auto;padding:8px 12px;}
  .karteEntry{padding:8px 0;border-bottom:1px solid #f3f4f6;font-size:12px;line-height:1.5;}
  .karteFoot{border-top:1px solid #e5e7eb;padding:8px 12px;}
  .karteFoot textarea{width:100%;box-sizing:border-box;min-height:52px;padding:6px 8px;border:1px solid #e5e7eb;border-radius:8px;font-size:12px;}
  .keHd{margin-bottom:2px;}
  .keToggle{cursor:pointer;}
  .kePreview{white-space:pre-wrap;word-break:break-word;color:#374151;}
  .keText{white-space:pre-wrap;word-break:break-word;color:#111827;}
  .keEdit{width:100%;box-sizing:border-box;min-height:60px;margin-top:4px;padding:6px 8px;border:1px solid #e5e7eb;border-radius:8px;font-size:12px;line-height:1.5;}
  .kCard{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:10px 12px;margin-bottom:10px;font-size:12px;line-height:1.55;}
  .kCard.kh-red{border-color:#fca5a5;background:#fef2f2;}
  .kCard.kh-amber{border-color:#fcd34d;background:#fffbeb;}
  .kCard.kh-green{border-color:#86efac;background:#f0fdf4;}
  .kCard.kh-blue{border-color:#93c5fd;background:#eff6ff;}
  .kTop{display:flex;align-items:center;gap:8px;margin-bottom:6px;}
  .kBadge{display:inline-block;padding:1px 8px;border-radius:999px;font-size:11px;font-weight:600;}
  .kbNote{background:#f5f0fb;color:#6b21a8;}
  .kbTreat{background:#e6f5f1;color:#0f766e;}
  .kDate{color:#6b7280;font-size:11px;}
  .kBody{white-space:pre-wrap;word-break:break-word;color:#111827;}
  .kEditArea{margin-top:4px;}
  .snipRow{display:flex;gap:6px;overflow-x:auto;padding:2px 0 6px;-webkit-overflow-scrolling:touch;}
  .snipChip{flex:0 0 auto;white-space:nowrap;border:1px solid #d1d5db;background:#f9fafb;color:#374151;border-radius:999px;padding:3px 10px;font-size:11px;cursor:pointer;}
  .snipChip:hover{background:#f3f4f6;}
  @media(min-width:900px){ .karteCard{left:50%;right:auto;transform:translateX(-50%);width:700px;max-width:92%;} }
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
  /* 編集チャットはモーダルではなく「横並びドロワー」：開いていても左の患者とのやり取りは見える・スクロールできる */
  #dpanel{position:fixed;inset:0;background:transparent;z-index:72;display:none;pointer-events:none;}
  #dCard{position:absolute;right:0;top:0;bottom:0;width:min(96vw,430px);background:#fff;display:flex;flex-direction:column;overflow:hidden;box-shadow:-4px 0 24px rgba(0,0,0,.15);animation:slideinX .28s cubic-bezier(.22,.9,.36,1);pointer-events:auto;border-left:1px solid var(--line);}
  @media(min-width:761px){
    #chat{transition:margin-right .28s cubic-bezier(.22,.9,.36,1);}
    #app.dopen #chat{margin-right:430px;} /* ドロワー分だけ会話エリアを詰めて、隠れる部分をなくす */
  }
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
    <div id="statsBar" style="display:none;padding:6px 12px;font-size:11px;color:#6b7280;background:#f8fafc;border-bottom:1px solid var(--line);line-height:1.7;"></div>
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
  <div style="border:1px solid #dbeafe;background:#f8fbff;border-radius:10px;padding:10px;margin-bottom:12px;">
    <div style="font-size:13px;font-weight:700;margin-bottom:7px;">👤 アカウント設定</div>
    <div id="accountLoginId" style="font-size:11px;color:#6b7280;margin-bottom:5px;">ログインID: 読み込み中…</div>
    <input type="email" id="setAccountEmail" autocomplete="email" placeholder="パスワード再設定用メールアドレス" style="width:100%;box-sizing:border-box;padding:8px;border:1px solid #d1d5db;border-radius:8px;font-size:12px;">
    <div id="accountEmailStat" style="font-size:11px;color:#6b7280;margin-top:4px;">パスワード再設定メールの送信先です</div>
    <button type="button" class="cbtn" style="margin-top:7px;" onclick="saveAccount()">アカウント情報を保存</button>
  </div>
  <label style="display:flex;align-items:center;gap:10px;font-size:14px;padding:8px 0;cursor:pointer;"><input type="checkbox" id="setAuto" style="width:18px;height:18px;"> 自動返信を有効にする</label>
  <label style="display:flex;align-items:center;gap:10px;font-size:14px;padding:8px 0;cursor:pointer;"><input type="checkbox" id="setBookingActions" style="width:18px;height:18px;"> 予約の自動受付（確認・変更・キャンセル）</label>
  <div style="font-size:11px;color:#888;margin:-6px 0 6px 28px;">予約システム（うけつけるん）連携。本人確認と、患者様の「はい」承認をはさんだうえで、予約のキャンセル・日時変更・LINE連携まで自動で行います。</div>
  <div id="slackSettings" style="border:1px solid #fde68a;background:#fffbeb;border-radius:10px;margin-top:10px;padding:10px;">
    <div style="font-size:13px;font-weight:700;margin-bottom:6px;">🔔 Slack通知設定</div>
    <label style="display:flex;align-items:center;gap:10px;font-size:14px;padding:4px 0;cursor:pointer;"><input type="checkbox" id="setSlackEnabled" style="width:18px;height:18px;"> 要対応をSlackへ通知する</label>
    <div style="font-size:12px;font-weight:600;margin-top:6px;">Slack接続時の返信運用</div>
    <select id="setSlackReplyMode" style="width:100%;padding:8px;border:1px solid #d1d5db;border-radius:8px;font-size:12px;margin-top:4px;">
      <option value="review_all">毎回Slackで承認してから送信（安全優先）</option>
      <option value="exceptions">安全な返信は自動送信・要確認だけSlack</option>
    </select>
    <div id="slackModeNote" style="font-size:10.5px;color:#6b7280;margin-top:3px;line-height:1.5;">自動返信がONの場合に適用します。Slackでは返信案の承認、修正指示、患者・予約情報の確認ができます。</div>
    <div id="slackStat" style="font-size:12px;color:#6b7280;margin-top:5px;line-height:1.6;">未接続</div>
    <div id="slackOAuthActions" style="display:none;gap:6px;flex-wrap:wrap;margin-top:7px;">
      <button type="button" id="slackConnectBtn" class="cbtn" onclick="connectSlack()">Slackに接続</button>
      <button type="button" id="slackTestBtn" class="cbtn" onclick="testSlack()" style="display:none;">テスト通知</button>
      <button type="button" id="slackDisconnectBtn" class="cbtn" onclick="disconnectSlack()" style="display:none;color:#b91c1c;">連携解除</button>
    </div>
    <div style="font-size:11px;color:#6b7280;margin-top:6px;line-height:1.55;">AIが要対応・緊急と判断した時や、予約自動受付を継続できない時に、店舗名・お客様名・理由・最新メッセージ・会話リンクを通知します。Slackから患者様へ返信したり、予約を操作したりする機能は現在ありません。</div>
    <details id="slackLegacy" style="margin-top:9px;border:1px solid #e5e7eb;background:#fff;border-radius:9px;padding:8px 10px;">
      <summary style="font-size:11px;font-weight:600;color:#6b7280;cursor:pointer;">高度な設定：Webhook URLを手動入力</summary>
      <input type="password" id="setSlackWebhook" autocomplete="off" placeholder="Incoming Webhook URL（空欄なら現在の設定を保持）" style="width:100%;box-sizing:border-box;padding:8px;border:1px solid #d1d5db;border-radius:8px;font-size:12px;margin-top:7px;">
      <div style="font-size:10.5px;color:#6b7280;margin-top:4px;line-height:1.5;">OAuthが使えない場合だけ利用します。URLは秘密情報として保存し、画面へ再表示しません。</div>
    </details>
  </div>
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
    <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
      <div style="font-size:13px;font-weight:600;">🧠 学習データ管理</div>
      <button type="button" class="cbtn" onclick="openLearning()">確認・編集</button>
    </div>
    <div style="font-size:11px;color:#6b7280;margin-top:5px;line-height:1.55;">店舗ルール、スタッフの記憶、過去の対応例を一か所で確認・編集・削除できます。用途が違うため、データは混ぜずに安全に管理します。</div>
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
<div id="learnManagePop" style="position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:78;display:none;align-items:center;justify-content:center;padding:14px;"><div style="background:#fff;border-radius:14px;width:min(96vw,900px);max-height:92vh;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,.22);">
  <div style="padding:15px 16px 11px;border-bottom:1px solid #e5e7eb;">
    <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;"><h3 style="margin:0;font-size:16px;">🧠 学習データ管理</h3><button type="button" class="cbtn" onclick="closeLearning()">閉じる</button></div>
    <div style="font-size:11px;color:#6b7280;line-height:1.6;margin-top:6px;">3種類は役割が違います。<b>店舗ルール</b>は店舗の事実・規定、<b>スタッフの記憶</b>は全返信に常に適用する指示、<b>過去の対応例</b>は似た質問のときだけ参考にする実例です。</div>
  </div>
  <div style="padding:10px 16px;border-bottom:1px solid #e5e7eb;display:flex;gap:7px;flex-wrap:wrap;align-items:center;">
    <button type="button" class="cbtn learnTabBtn" data-tab="rules" onclick="setLearningTab('rules')">📚 店舗ルール <span id="learnRulesCount"></span></button>
    <button type="button" class="cbtn learnTabBtn" data-tab="prefs" onclick="setLearningTab('prefs')">🧠 スタッフの記憶 <span id="learnPrefsCount"></span></button>
    <button type="button" class="cbtn learnTabBtn" data-tab="examples" onclick="setLearningTab('examples')">💬 過去の対応例 <span id="learnExamplesCount"></span></button>
    <input id="learnSearch" oninput="renderLearning()" placeholder="この種類を検索" style="margin-left:auto;min-width:180px;flex:1;max-width:280px;padding:8px;border:1px solid #d1d5db;border-radius:8px;font-size:12px;box-sizing:border-box;">
  </div>
  <div id="learnHelp" style="padding:9px 16px;background:#f8fafc;border-bottom:1px solid #e5e7eb;font-size:11px;color:#475569;line-height:1.55;"></div>
  <div id="learnList" style="padding:12px 16px;overflow-y:auto;overscroll-behavior:contain;flex:1;min-height:220px;"></div>
  <div style="padding:10px 16px;border-top:1px solid #e5e7eb;display:flex;justify-content:space-between;align-items:center;gap:8px;"><span id="learnStatus" style="font-size:11px;color:#6b7280;"></span><button type="button" id="learnAddBtn" class="cbtn send" onclick="addLearningItem()">＋追加</button></div>
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
let initialConv="";try{initialConv=new URLSearchParams(location.search).get("conv")||"";}catch(e){}
async function load(){ try{ const r=await fetch("/api/conversations"); DATA=await r.json(); }catch(e){} renderList(); if(initialConv&&!current){const target=DATA.find(x=>x.id===initialConv);if(target){const id=initialConv;initialConv="";openChat(id);try{history.replaceState(null,"",location.pathname);}catch(e){}}} if(current){ const c=DATA.find(x=>x.id===current); if(c) syncMsgs(c); } }
function api(path,body){ return fetch(path,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)}); }
/* ネイティブalert/confirm/promptの置き換え（ブラウザのイベントループを止めない自前モーダル。自動テスト・拡張機能対応） */
function uiDlg(msg,kind,def){
 return new Promise(function(res){
  var ov=document.createElement("div");
  ov.style.cssText="position:fixed;inset:0;z-index:2147483000;background:rgba(15,23,42,.45);display:flex;align-items:center;justify-content:center;padding:16px;";
  var card=document.createElement("div");
  card.style.cssText="background:#fff;border-radius:14px;box-shadow:0 20px 50px rgba(2,6,23,.25);max-width:26rem;width:100%;padding:18px;font-size:14px;line-height:1.7;color:#111827;";
  var m=document.createElement("div"); m.style.cssText="white-space:pre-wrap;word-break:break-word;"; m.textContent=(msg==null?"":String(msg)); card.appendChild(m);
  var input=null;
  if(kind==="prompt"){ input=document.createElement("input"); input.type="text"; input.value=(def==null?"":String(def)); input.style.cssText="display:block;width:100%;margin-top:12px;border:1px solid #d1d5db;border-radius:8px;padding:8px 10px;font-size:14px;box-sizing:border-box;"; card.appendChild(input); }
  var row=document.createElement("div"); row.style.cssText="display:flex;justify-content:flex-end;gap:8px;margin-top:14px;";
  function mkBtn(label,primary){ var b=document.createElement("button"); b.type="button"; b.textContent=label; b.style.cssText="border-radius:8px;padding:8px 18px;font-size:13px;font-weight:600;cursor:pointer;"+(primary?"background:#06c755;border:1px solid #06c755;color:#fff;":"background:#fff;border:1px solid #d1d5db;color:#374151;"); return b; }
  function fin(v){ document.removeEventListener("keydown",onKey,true); ov.remove(); res(v); }
  function okVal(){ return kind==="prompt"?(input?input.value:""):(kind==="confirm"?true:undefined); }
  function ngVal(){ return kind==="prompt"?null:(kind==="confirm"?false:undefined); }
  function onKey(e){ if(e.key==="Escape"){ e.preventDefault(); e.stopPropagation(); fin(ngVal()); } else if(e.key==="Enter"){ e.preventDefault(); e.stopPropagation(); fin(okVal()); } }
  if(kind!=="alert"){ var c=mkBtn("キャンセル",false); c.addEventListener("click",function(){ fin(ngVal()); }); row.appendChild(c); }
  var ok=mkBtn("OK",true); ok.addEventListener("click",function(){ fin(okVal()); }); row.appendChild(ok);
  card.appendChild(row); ov.appendChild(card);
  ov.addEventListener("mousedown",function(e){ if(e.target===ov) fin(ngVal()); });
  document.addEventListener("keydown",onKey,true);
  document.body.appendChild(ov);
  if(input){ input.focus(); input.select(); } else { ok.focus(); }
 });
}
function uiAlert(m){ return uiDlg(m,"alert"); }
function uiConfirm(m){ return uiDlg(m,"confirm"); }
function uiPrompt(m,d){ return uiDlg(m,"prompt",d); }
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
    '<div id="custTab" class="custTab" style="display:none;" onclick="cpExpand()">うけつけるん情報を表示 ⌄</div>'+
    '<div id="custPanel" class="custPanel">読み込み中…</div>'+
    '<div id="msgs">'+bubbles+'</div>'+
    '<div id="composer"><div id="aiLabel">✨ AI下書き（編集して送れます）</div><div id="topicChips" style="display:none;"></div><div id="draftRow"><button id="attach" onclick="attach()" title="写真・動画を添付">📎</button><textarea id="draft">'+esc(r.draft||"")+'</textarea></div>'+
    '<div id="cbtns"><button class="cbtn flagb" id="flagBtn" onclick="toggleFlag()">'+(r.flag?"⚑ 要対応を外す":"⚑ 要対応")+'</button><button class="cbtn ai" onclick="openDraftChat()">✨ AIで作り直す</button><button class="cbtn done" onclick="markDone()">対応済み</button><button class="cbtn send" onclick="sendMsg()">送信</button></div></div>';
  const m=document.getElementById("msgs");if(m){m.setAttribute("data-count",String(r.msgs.length));m.scrollTop=m.scrollHeight;} selTopics=null; renderTopicChips(r); loadCustomer(id); if(!keep)renderList();
}
function closeChat(){appEl.classList.remove("chatopen");current=null;renderList();}
// ===== うけつけるん 顧客情報パネル =====
var custPid=null; var karteEntries={};
var custCache={}; var karteCache={}; // 会話ごとのコンテキスト/カルテのメモリキャッシュ（体感1秒以下）
function kIsPC(){ return window.matchMedia("(min-width: 900px)").matches; }
function copyText(s){ try{ navigator.clipboard.writeText(s); }catch(e){} }
function cpCopy(btn,url){ copyText(url); if(btn){ var o=btn.textContent; btn.textContent="コピーしました"; setTimeout(function(){ try{btn.textContent=o;}catch(e){} },1500); } }
// 未入力回答URLは押下時に1件だけ生成して取得（apptId → サーバー中継）
async function copyUnans(btn,apptId){
  if(!current||!apptId)return;
  var o=btn?btn.textContent:"";
  if(btn) btn.textContent="取得中…";
  try{
    var r=await fetch("/api/customer-unanswered?id="+encodeURIComponent(current)+"&apptId="+encodeURIComponent(apptId));
    var j=await r.json();
    if(j&&j.ok&&j.url){ copyText(j.url); if(btn){ btn.textContent="コピーしました"; setTimeout(function(){ try{btn.textContent=o;}catch(e){} },1500); } }
    else { if(btn) btn.textContent=o; uiAlert("URLを取得できませんでした"); }
  }catch(e){ if(btn) btn.textContent=o; uiAlert("URLを取得できませんでした"); }
}
function cpGripHtml(){ return '<div data-cp="collapse" class="cpGrip"><span class="cpGripBar"></span><span class="cpMuted">▲ 隠す</span></div>'; }
function renderCustomer(id,j){
  if(current!==id)return; // 会話を切り替えていたら古い結果で描画しない
  var el=document.getElementById("custPanel"); if(!el)return;
  if(!j){ el.innerHTML=""; return; }
  if(j.found){ el.innerHTML=custFoundHtml(j); custPid=(j.patient&&j.patient.id!=null)?j.patient.id:null; el.setAttribute("data-pid", custPid!=null?encodeURIComponent(String(custPid)):""); cpKarteHeaderLoad(id); }
  else { el.innerHTML=custUnlinkedHtml(id); custPid=null; }
  el.onclick=cpPanelClick; // data-cp ボタンをイベント委譲で処理
}
// ── ヘッダー内カルテ（内部スクロール・過去の記録まで全件） ──
async function cpKarteHeaderLoad(convId){
  if(!document.getElementById("cpKarteArea")) return;
  var cached=karteCache[convId];
  if(cached){ cpKarteHeaderRender(convId,cached); }
  try{
    var url="/api/customer-karte?id="+encodeURIComponent(convId)+(custPid!=null?("&patientId="+encodeURIComponent(String(custPid))):"");
    var r=await fetch(url); var j=await r.json();
    if(!j) return;
    karteCache[convId]=j;
    cpKarteHeaderRender(convId,j);
  }catch(e){
    if(!cached&&current===convId){ var a=document.getElementById("cpKarteArea"); if(a) a.innerHTML='<span class="cpMuted">カルテを取得できませんでした</span>'; }
  }
}
function cpKarteHeaderRender(convId,j){
  if(current!==convId) return;
  var area=document.getElementById("cpKarteArea"); if(!area) return;
  var entries=(j&&j.entries)||[];
  var head='<div class="cpKHead" style="padding:0 0 5px;"><span class="cpTtl">📋 カルテ（全 '+entries.length+' 件）</span><button class="cpKOpen" data-cp="karte">カルテ画面で編集 →</button></div>';
  if(!j||!j.found){ area.innerHTML='<span class="cpMuted">カルテを取得できませんでした</span>'; return; }
  if(!entries.length){ area.innerHTML=head+'<span class="cpMuted">カルテはまだありません</span>'; return; }
  var rows=entries.map(function(en){
    var d=cpJpDate(en.date||"");
    var mn=en.menu?('<span class="cpKMenu">'+esc(en.menu)+'</span>'):(en.kind==="note"?'<span class="cpKMenu">メモ</span>':'');
    return '<div class="cpKEntry"><div class="cpKDate">'+esc(d.d)+mn+'</div><div class="cpKTxt">'+esc(en.text||"")+'</div></div>';
  }).join("");
  area.innerHTML=head+'<div class="cpKWrap" style="margin:0;"><div class="cpKScroll" id="cpKScroll">'+rows+'</div><div class="cpKFade" id="cpKFade"></div><div class="cpKMore" id="cpKMore"></div></div>';
  var sc=document.getElementById("cpKScroll");
  if(sc){ sc.onscroll=cpKScrollUpd; cpKScrollUpd(); }
}
function cpKScrollUpd(){
  var sc=document.getElementById("cpKScroll"); var more=document.getElementById("cpKMore"); var fade=document.getElementById("cpKFade");
  if(!sc||!more) return;
  var vb=sc.scrollTop+sc.clientHeight;
  var hid=0; var ch=sc.children;
  for(var i=0;i<ch.length;i++){ if(ch[i].offsetTop>=vb-8) hid++; }
  var atEnd=vb>=sc.scrollHeight-4;
  if(atEnd||hid===0){ more.style.display="none"; if(fade)fade.style.display="none"; }
  else{ more.style.display=""; if(fade)fade.style.display=""; more.textContent="▼ 過去の記録（あと "+hid+" 件）"; }
}
function loadCustomer(id){
  var el=document.getElementById("custPanel"); if(!el)return;
  cpExpand(); cpBindTouch();
  var cached=custCache[id];
  if(cached){ renderCustomer(id,cached); } // キャッシュあり=体感ゼロ待ちで即描画
  else { el.innerHTML='<span class="cpMuted">うけつけるん情報を読み込み中…</span>'; }
  fetch("/api/customer-context?id="+encodeURIComponent(id)).then(function(r){ return r.json(); }).then(function(j){
    if(!j)return;
    custCache[id]=j;
    renderCustomer(id,j); // current!==id なら renderCustomer 内で破棄
  }).catch(function(e){ if(!cached && current===id){ var el2=document.getElementById("custPanel"); if(el2) el2.innerHTML=""; } });
}
function cpCollapse(){
  var el=document.getElementById("custPanel"); var tab=document.getElementById("custTab");
  if(el){ el.style.maxHeight="0"; el.style.opacity="0"; el.style.paddingTop="0"; el.style.paddingBottom="0"; }
  if(tab){ tab.style.display="flex"; }
}
function cpExpand(){
  var el=document.getElementById("custPanel"); var tab=document.getElementById("custTab");
  if(el){ el.style.maxHeight="600px"; el.style.opacity="1"; el.style.paddingTop=""; el.style.paddingBottom=""; }
  if(tab){ tab.style.display="none"; }
}
function cpBindTouch(){
  var el=document.getElementById("custPanel"); var tab=document.getElementById("custTab");
  if(el&&!el.__cpb){ el.__cpb=1; var sy=0;
    el.addEventListener("touchstart",function(e){ sy=e.touches[0].clientY; },{passive:true});
    el.addEventListener("touchend",function(e){ var dy=sy-e.changedTouches[0].clientY; if(dy>24) cpCollapse(); });
  }
  if(tab&&!tab.__cpb){ tab.__cpb=1; var ty=0;
    tab.addEventListener("touchstart",function(e){ ty=e.touches[0].clientY; },{passive:true});
    tab.addEventListener("touchend",function(e){ var dy=e.changedTouches[0].clientY-ty; if(dy>16) cpExpand(); });
  }
}
// "YYYY-MM-DD HH:MM" → {d:"M月D日(曜)", t:"HH:MM"}（うけつけるんカレンダーと同じ表記）
function cpJpDate(ds){
  var m=/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}:\d{2})/.exec(ds||"");
  if(!m) return {d:ds||"", t:""};
  var wd="日月火水木金土".charAt(new Date(+m[1],+m[2]-1,+m[3]).getDay());
  return {d:(+m[2])+"月"+(+m[3])+"日("+wd+")", t:m[4]};
}
function cpBadgeHtml(b){
  var k=(b&&b.statusKey)||""; var cls="";
  if(k==="pending") cls=" bk-amber";
  else if(k==="booked"||k==="confirmed") cls=" bk-green";
  else if(k==="checked_in") cls=" bk-blue";
  else if(k==="cancelled"||k==="no_show") cls=" bk-red";
  return '<span class="cpBadge'+cls+'">'+esc((b&&b.status)||"")+'</span>';
}
// メニュー色はDB由来だが、style挿入なのでCSS色として妥当な形式のみ通す
function cpSafeColor(c){ return (typeof c==="string" && /^(#[0-9a-fA-F]{3,8}|[a-zA-Z]{2,20}|rgba?\([0-9.,\s%]+\))$/.test(c)) ? c : ""; }
function cpApptCardHtml(b,kind){
  var ttl = kind==="next" ? "📅 次回のご予約" : "🕘 最終来院";
  if(!b){
    return '<div class="cpCard"><span class="cpStripe" style="background:#d1d5db;"></span>'+
      '<div class="cpTtl">'+ttl+' <span class="cpBadge">なし</span></div>'+
      '<div class="cpMenuLine cpMuted" style="font-size:11.5px;">'+(kind==="next"?"次回のご予約は入っていません":"来院履歴がありません")+'</div></div>';
  }
  var when = b.dateJp || (function(x){ return (x.d+" "+x.t).trim(); })(cpJpDate(b.date));
  if(kind==="next" && b.endHm) when += "〜"+b.endHm;
  var col=cpSafeColor(b.menuColor);
  var chip = col ? '<span class="cpMColor" style="background:'+esc(col)+';"></span>' : '';
  var loc = b.location ? ' <span class="cpLoc">🏥 '+esc(b.location)+'</span>' : '';
  var cbtn = (kind==="next"&&b.apptId) ? '<button class="cpBtn cpCancel cpCardCancel" data-cp="cancel" data-val="'+encodeURIComponent(String(b.apptId))+'">キャンセル</button>' : '';
  return '<div class="cpCard'+(kind==="next"?" cpNext":"")+'"><span class="cpStripe"></span>'+
    '<div class="cpTtl">'+ttl+' '+cpBadgeHtml(b)+cbtn+'</div>'+
    '<div class="cpWhen">'+esc(when)+'</div>'+
    '<div class="cpMenuLine">'+chip+esc(b.menu||"")+loc+'</div></div>';
}
function custFoundHtml(j){
  var p=(j&&j.patient)||{};
  var bk=(j&&j.bookings)||{};
  var past=(bk.past)||[];
  var h='<div class="cpTitle">'+esc(p.name||"顧客")+
    (p.memberRank?'<span class="cpMuted"> ・'+esc(p.memberRank)+'</span>':'')+
    ((p.points!=null&&p.points!=="")?'<span class="cpMuted"> ・'+esc(String(p.points))+'pt</span>':'')+'</div>';
  var vc=(p.visitCount!=null&&p.visitCount!=="")?String(p.visitCount):"";
  if(vc) h+='<div class="cpRow"><span class="cpMuted">来院:</span> 通算'+esc(vc)+'回</div>';
  // ── 次回のご予約・最終来院カード（うけつけるんカレンダー同等の見た目） ──
  var up=(bk.upcoming)||[];
  var lastB=null;
  for(var li=0;li<past.length;li++){ var lk=past[li].statusKey||""; if(lk!=="cancelled"&&lk!=="no_show"){ lastB=past[li]; break; } }
  h+='<div class="cpCards">'+cpApptCardHtml(up[0]||null,"next")+cpApptCardHtml(lastB,"last")+'</div>';
  // 2件目以降のご予約（キャンセル操作つき）
  if(up.length>1){
    h+='<div class="cpRow" style="margin-top:4px;"><span class="cpMuted">他のご予約:</span></div>';
    h+=up.slice(1,6).map(function(b){
      var lbl=esc(((b.dateJp||b.date||"")+" "+(b.menu||"")).trim())+' '+cpBadgeHtml(b);
      var cbtn=b.apptId?'<button class="cpBtn cpCancel" data-cp="cancel" data-val="'+encodeURIComponent(String(b.apptId))+'">キャンセル</button>':'';
      return '<div class="cpRow" style="display:flex;justify-content:space-between;align-items:center;gap:8px;"><span>'+lbl+'</span>'+cbtn+'</div>';
    }).join("");
    if(up.length>6) h+='<div class="cpRow"><span class="cpMuted">他'+(up.length-6)+'件</span></div>';
  }
  // ── カルテ（下段・全幅・内部スクロールで過去の記録まで） ──
  h+='<div class="cpKarteCard"><span class="cpStripe"></span><div id="cpKarteArea" style="padding:7px 12px 8px 14px;"><span class="cpMuted">カルテを読み込み中…</span></div></div>';
  if(p.tickets&&p.tickets.length){
    var tk=p.tickets.map(function(t){ return esc(t.name)+"×"+esc(String(t.remaining)); }).join("／");
    h+='<div class="cpRow" style="margin-top:4px;"><span class="cpMuted">回数券:</span> '+tk+'</div>';
  }
  var qs=(j&&j.questionnaires)||[];
  if(qs.length){
    var rows=qs.map(function(q){
      var label=esc((q.date||"")+" "+(q.menu||""));
      var st=q.ivStatus?(' <span class="cpMuted">問診: '+esc(q.ivStatus||"")+'</span>'):'';
      // customer-context は unansweredUrl を返さなくなったため、押下時に1件だけ生成する
      var btn=q.apptId?(' <button class="cpBtn" data-cp="copyunans" data-val="'+encodeURIComponent(String(q.apptId))+'">未入力回答URLをコピー</button>'):'';
      return '<div class="cpRow">'+label+st+btn+'</div>';
    }).join("");
    h+=rows;
  }
  var links=(j&&j.links)||{};
  var btns='<div class="cpBtnRow">';
  btns+='<button class="cpBtn cpKarte" data-cp="karte">🗂 カルテクイック</button>';
  if(links.karte) btns+='<button class="cpBtn" data-cp="open" data-val="'+encodeURIComponent(links.karte)+'">🗂 カルテを開く</button>';
  if(links.patient) btns+='<button class="cpBtn" data-cp="open" data-val="'+encodeURIComponent(links.patient)+'">👤 顧客情報</button>';
  if(links.patient) btns+='<button class="cpBtn" data-cp="open" data-val="'+encodeURIComponent(links.patient)+'">↗ うけつけるんで開く</button>';
  btns+='</div>';
  h+=btns;
  h+=cpGripHtml();
  return h;
}
function karteLoadingCard(msg){
  return '<div class="karteCard"><div class="karteHd">🗂 カルテクイック<button class="kClose" data-cp="karteclose">✕</button></div><div class="karteBody"><span class="cpMuted">'+esc(msg)+'</span></div></div>';
}
function openKarte(){
  if(!current)return;
  var chat=document.getElementById("chat"); if(!chat)return;
  var ov=document.getElementById("karteOv");
  if(!ov){ ov=document.createElement("div"); ov.id="karteOv"; chat.appendChild(ov);
    // カルテオーバーレイ専用のクリックハンドラ（cpPanelClick と分離）
    ov.onclick=function(e){ if(e.target===ov){ closeKarte(); return; } karteClick(e); }; }
  ov.style.display="block";
  var convId=current;
  var cached=karteCache[convId];
  if(cached){ ov.innerHTML=karteHtml(cached,kIsPC()); } // キャッシュあり=即描画
  else { ov.innerHTML=karteLoadingCard("読み込み中…"); }
  karteLoad(ov,convId);
}
function reloadKarte(){ var ov=document.getElementById("karteOv"); if(!ov||!current)return; karteLoad(ov,current); }
async function karteLoad(ov,convId){
  var hadCache=!!karteCache[convId];
  try{
    // patientId を付けて高速化（無ければサーバー側で line_uid 再解決にフォールバック）
    var url="/api/customer-karte?id="+encodeURIComponent(convId)+(custPid!=null?("&patientId="+encodeURIComponent(String(custPid))):"");
    var r=await fetch(url);
    var j=await r.json();
    if(current!==convId)return; // 会話を切り替えていたら破棄
    if(j&&j.patient&&j.patient.id!=null) custPid=j.patient.id;
    karteCache[convId]=j;
    var ov2=document.getElementById("karteOv");
    if(ov2&&ov2.style.display!=="none") ov2.innerHTML=karteHtml(j,kIsPC());
    cpKarteHeaderRender(convId,j); // ヘッダーのカルテ欄も最新化（追加・編集の反映）
  }catch(e){ if(!hadCache){ var ovx=document.getElementById("karteOv"); if(ovx&&current===convId) ovx.innerHTML=karteLoadingCard("取得に失敗しました"); } }
}
function snipRowHtml(snips,tgt){
  if(!snips||!snips.length) return "";
  var chips=snips.map(function(s){
    var title=(s&&s.title)?String(s.title):"";
    var bodyStr=(s&&s.body)?String(s.body):"";
    var label=title?title:(bodyStr.slice(0,16)+"…");
    return '<button class="snipChip" data-cp="snipins" data-val="'+encodeURIComponent(bodyStr)+'" data-tgt="'+encodeURIComponent(tgt)+'">'+esc(label)+'</button>';
  }).join("");
  return '<div class="snipRow">'+chips+'</div>';
}
function karteEditBtnRow(i,recordId){
  var idAttr=encodeURIComponent(String(recordId));
  return '<div class="cpBtnRow"><button class="cpBtn" data-cp="karteeditstart" data-i="'+i+'" data-val="'+idAttr+'">✎ 編集</button></div>';
}
function karteHtml(j,isPC){
  j=j||{}; karteEntries={};
  var pt=j.patient||{}; var name=esc(pt.name||"");
  var entries=(j.entries)||[];
  var snips=(j.snippets)||[];
  window.karteSnips=snips;
  var body='';
  if(!j.found){ body='<span class="cpMuted">カルテを取得できませんでした</span>'; }
  else if(!entries.length){ body='<span class="cpMuted">記録がありません</span>'; }
  else {
    body=entries.map(function(en,i){
      if(en.id!=null) karteEntries[String(en.id)]=en.text||"";
      var isNote=(en.kind==="note");
      var isTreat=(en.kind==="treatment");
      var editable=(isNote&&en.editable&&en.id!=null);
      var hl=en.highlight; var hlClass="";
      if(hl==="red"||hl==="amber"||hl==="green"||hl==="blue") hlClass=" kh-"+hl;
      var badge=isTreat?'<span class="kBadge kbTreat">施術記録</span>':'<span class="kBadge kbNote">顧客備考</span>';
      var top='<div class="kTop">'+badge+'<span class="kDate">'+esc(en.date||"")+(en.menu?(' ・'+esc(en.menu)):'')+'</span></div>';
      var fullText=String(en.text||"");
      var inner='<div class="kBody">'+esc(fullText)+'</div>';
      if(editable){ inner='<div class="kBody">'+esc(fullText)+'</div>'+karteEditBtnRow(i,en.id); }
      return '<div class="kCard'+hlClass+'" id="kCard_'+i+'">'+top+'<div class="kInner" id="kInner_'+i+'">'+inner+'</div></div>';
    }).join("");
  }
  return '<div class="karteCard"><div class="karteHd">🗂 カルテクイック — '+name+'<button class="kClose" data-cp="karteclose">✕</button></div>'+
    '<div class="karteBody">'+body+'</div>'+
    '<div class="karteFoot">'+snipRowHtml(snips,"add")+'<textarea id="karteAddText" placeholder="クイック追加（カルテにメモを追加）"></textarea><div class="cpBtnRow"><button class="cpBtn cpKarte" data-cp="karteadd">カルテに保存</button></div></div></div>';
}
function karteEditStart(i,recordId){
  var inner=document.getElementById("kInner_"+i); if(!inner)return;
  var snips=window.karteSnips||[];
  inner.innerHTML='<div class="kEditArea">'+snipRowHtml(snips,"edit_"+recordId)+
    '<textarea class="keEdit" id="kEdit_'+i+'"></textarea>'+
    '<div class="cpBtnRow"><button class="cpBtn cpKarte" data-cp="karteeditinline" data-val="'+encodeURIComponent(String(recordId))+'" data-i="'+i+'">保存</button>'+
    '<button class="cpBtn" data-cp="karteeditcancel" data-i="'+i+'" data-val="'+encodeURIComponent(String(recordId))+'">取消</button></div></div>';
  var ta=document.getElementById("kEdit_"+i);
  if(ta){ ta.value=karteEntries[String(recordId)]||""; ta.focus(); }
}
function karteEditCancel(i,recordId){
  var inner=document.getElementById("kInner_"+i); if(!inner)return;
  inner.innerHTML='<div class="kBody" id="kBody_'+i+'"></div>'+karteEditBtnRow(i,recordId);
  var bd=document.getElementById("kBody_"+i);
  if(bd) bd.textContent=karteEntries[String(recordId)]||"";
}
function snipInsert(bodyStr,tgt,btn){
  var ta=null;
  if(tgt==="add"){ ta=document.getElementById("karteAddText"); }
  else { var host=(btn&&btn.closest)?btn.closest(".kInner"):null; ta=host?host.querySelector("textarea"):null; }
  if(!ta)return;
  var cur=ta.value||"";
  if(cur&&cur.charAt(cur.length-1)!==String.fromCharCode(10)) cur=cur+String.fromCharCode(10);
  ta.value=cur+bodyStr; ta.focus();
}
function karteExpand(i){
  var f=document.getElementById("keFull_"+i); if(!f)return;
  var open=(f.style.display!=="none");
  f.style.display=open?"none":"block";
  var p=document.getElementById("kePrev_"+i); if(p) p.style.display=open?"block":"none";
}
async function karteEditInline(recordId,i){
  if(!current||!recordId)return;
  var ta=document.getElementById("kEdit_"+i); if(!ta)return;
  var body=(ta.value||"").trim(); if(!body)return;
  try{
    var r=await api("/api/customer-karte",{id:current,action:"edit",recordId:recordId,body:body});
    var j=await r.json();
    if(j&&j.ok){ delete karteCache[current]; reloadKarte(); }
    else { uiAlert(j&&j.error==="not_editable"?"この記録は編集できません":"編集に失敗しました"); }
  }catch(e){ uiAlert("編集に失敗しました"); }
}
function karteClick(e){
  var b=e.target&&e.target.closest?e.target.closest("[data-cp]"):null; if(!b)return;
  var act=b.getAttribute("data-cp"); var val=decodeURIComponent(b.getAttribute("data-val")||"");
  if(act==="karteclose") closeKarte();
  else if(act==="karteadd") karteAdd();
  else if(act==="karteexpand") karteExpand(val);
  else if(act==="karteeditinline") karteEditInline(val,b.getAttribute("data-i"));
  else if(act==="karteeditstart") karteEditStart(b.getAttribute("data-i"),val);
  else if(act==="karteeditcancel") karteEditCancel(b.getAttribute("data-i"),val);
  else if(act==="snipins") snipInsert(val,decodeURIComponent(b.getAttribute("data-tgt")||""),b);
}
function closeKarte(){ var ov=document.getElementById("karteOv"); if(ov) ov.style.display="none"; }
async function karteAdd(){
  var ta=document.getElementById("karteAddText"); if(!ta||!current)return;
  var body=(ta.value||"").trim(); if(!body)return;
  try{
    var r=await api("/api/customer-karte",{id:current,action:"add",patientId:custPid,body:body});
    var j=await r.json();
    if(j&&j.ok){ delete karteCache[current]; reloadKarte(); } // 保存成功→キャッシュ無効化→再取得
    else { uiAlert("カルテの保存に失敗しました"); }
  }catch(e){ uiAlert("カルテの保存に失敗しました"); }
}
async function karteEdit(recordId){
  if(!current||!recordId)return;
  var cur=await uiPrompt("カルテ記録を編集します。新しい内容を入力してください：", karteEntries[String(recordId)]||"");
  if(cur===null)return;
  var body=cur.trim(); if(!body)return;
  try{
    var r=await api("/api/customer-karte",{id:current,action:"edit",recordId:recordId,body:body});
    var j=await r.json();
    if(j&&j.ok){ openKarte(); }
    else { uiAlert(j&&j.error==="not_editable"?"この記録は編集できません":"編集に失敗しました"); }
  }catch(e){ uiAlert("編集に失敗しました"); }
}
async function doApptCancel(apptId){
  if(!current||!apptId)return;
  var reason=await uiPrompt("この予約をキャンセルします。理由（任意・患者に送る自動連絡に使われる場合があります）:","クリニック都合");
  if(reason===null)return;
  try{
    var r=await api("/api/customer-appt-cancel",{id:current,appointmentId:apptId,reason:reason});
    var j=await r.json();
    if(j&&j.ok){ loadCustomer(current); }
    else { uiAlert(j&&j.error==="not_cancellable"?"この予約はキャンセルできません(期限切れ/過去/処理済み)":"キャンセルに失敗しました"); }
  }catch(e){ uiAlert("キャンセルに失敗しました"); }
}
function linkToggle(){ var b=document.getElementById("custLinkBox"); if(!b)return; b.style.display=(!b.style.display||b.style.display==="none")?"block":"none"; }
function cpOpen(url){ try{ window.open(url,"_blank"); }catch(e){} }
function cpPanelClick(e){
  var b=e.target&&e.target.closest?e.target.closest("[data-cp]"):null; if(!b)return;
  var act=b.getAttribute("data-cp"); var val=decodeURIComponent(b.getAttribute("data-val")||"");
  if(act==="copy") cpCopy(b,val);
  else if(act==="copyunans") copyUnans(b,val);
  else if(act==="open") cpOpen(val);
  else if(act==="link") doLink(val);
  else if(act==="cancel") doApptCancel(val);
  else if(act==="karte") openKarte();
  else if(act==="karteadd") karteAdd();
  else if(act==="karteedit") karteEdit(val);
  else if(act==="karteclose") closeKarte();
  else if(act==="collapse") cpCollapse();
  else if(act==="linktoggle") linkToggle();
}
function custUnlinkedHtml(id){
  return '<div class="cpRow"><span class="cpMuted">この顧客はうけつけるんと未連携です</span></div>'+
    '<div class="cpBtnRow"><button class="cpBtn" data-cp="linktoggle">🔗 うけつけるんの顧客と連携</button></div>'+
    '<div id="custLinkBox" style="display:none;"><input id="custSearch" class="cpInput" placeholder="氏名・電話で検索" oninput="custSearchDebounced()"><div id="custResults"></div></div>'+
    cpGripHtml();
}
var custT;
function custSearchDebounced(){ clearTimeout(custT); custT=setTimeout(custSearchGo,300); }
async function custSearchGo(){
  var q=(document.getElementById("custSearch")||{}).value||"";
  var box=document.getElementById("custResults"); if(!box)return;
  if(q.trim().length<2){ box.innerHTML=""; return; }
  try{
    var r=await fetch("/api/customer-search?q="+encodeURIComponent(q));
    var j=await r.json();
    var arr=(j&&j.candidates)||[];
    if(!arr.length){ box.innerHTML='<span class="cpMuted">該当なし</span>'; return; }
    box.innerHTML=arr.map(function(p){
      return '<div class="cpCand"><span>'+esc(p.name)+
        (p.nameKana?' <span class="cpMuted">'+esc(p.nameKana)+'</span>':'')+
        (p.phoneMasked?' <span class="cpMuted">'+esc(p.phoneMasked)+'</span>':'')+
        (p.lineLinked?' <span class="cpMuted">(LINE連携済)</span>':'')+
        '</span><button class="cpLink" data-cp="link" data-val="'+encodeURIComponent(p.id)+'">連携</button></div>';
    }).join("");
  }catch(e){ box.innerHTML=""; }
}
async function doLink(pid){
  if(!current)return;
  if(!await uiConfirm("この顧客を現在のLINE会話に連携しますか？"))return;
  try{
    var r=await api("/api/customer-link",{id:current,patientId:pid,action:"link"});
    var j=await r.json();
    if(j&&j.ok){ loadCustomer(current); }
    else { uiAlert(j&&j.error==="already_linked_other"?"このLINEは別の顧客に連携済みです":(j&&j.error==="not_line"?"LINE会話のみ連携できます":"連携に失敗しました")); }
  }catch(e){ uiAlert("連携に失敗しました"); }
}
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
async function redraftSelected(){ if(!current||!selTopics)return; const sel=[...selTopics]; if(!sel.length){uiAlert("返信する内容を1つ以上選んでください");return;} const btn=document.getElementById("redraftBtn"); if(btn){btn.disabled=true;btn.textContent="作成中…";} try{ const rr=await api("/api/redraft",{id:current,selected:sel}); const j=await rr.json(); if(j&&j.ok&&typeof j.draft==="string"){ const d=document.getElementById("draft"); if(d)d.value=j.draft; const cd=DATA.find(x=>x.id===current); if(cd){cd.draft=j.draft; if(Array.isArray(j.topics))cd.topics=j.topics;} }else{ uiAlert("作り直しに失敗しました"); } }catch(e){ uiAlert("作り直しに失敗しました"); } if(btn){btn.disabled=false;btn.textContent="選んだ内容で下書きを作成";} }
async function markDone(){const id=current;await api("/api/done",{id});await load();}
async function markAllDone(){if(!await uiConfirm("すべてのチャットを「対応済み」に変更します。よろしいですか？"))return;try{const r=await api("/api/done-all",{});const j=await r.json();closeSet();if(current){closeChat();}await load();uiAlert((j.count||0)+"件を対応済みにしました");}catch(e){uiAlert("変更に失敗しました");}}
async function sendMsg(){if(window.__sendBusy)return;const id=current;const t=document.getElementById("draft").value.trim();if(!t)return;window.__sendBusy=true;const _sb=document.querySelector("#cbtns .send");if(_sb){_sb.disabled=true;_sb.textContent="送信中…";}try{const cd0=DATA.find(x=>x.id===id);const orig=String((cd0&&(cd0.draft0!=null?cd0.draft0:cd0.draft))||"").trim();const edited=(t!==orig);let instr="";try{if(dSessions&&dSessions[id]&&Array.isArray(dSessions[id].hist)){instr=dSessions[id].hist.filter(m=>m&&m.role==="user").map(m=>String(m.content||"")).join(" / ").slice(0,1500);}}catch(e){}const r=await api("/api/send",{id,text:t,instr:edited?instr:""});let j={};try{j=await r.json();}catch(e){}if(j.sent){const d0=document.getElementById("draft");if(d0)d0.value="";const cd=DATA.find(x=>x.id===id);if(cd)cd.draft="";if(j.conflict){showConflict(j.conflict);}else if(j.learnedRules&&j.learnedRules.length){showRuleToast(j.learnedRules);}else if(edited&&orig.length>0){showLearnToast(j.learnedId);}await load();}else{const m={mail_send_pending:"メール送信は準備中です",LINE_400:"LINE送信失敗：相手がお友だち未登録か、無効なIDの可能性",no_send_config:"送信設定が未完了です"}[j.sendErr]||("送信失敗: "+(j.sendErr||"不明"));uiAlert(m+"\\n（下書きは消えていません）");}}finally{window.__sendBusy=false;const _sb2=document.querySelector("#cbtns .send");if(_sb2){_sb2.disabled=false;_sb2.textContent="送信";}}}
function attach(){const inp=document.createElement("input");inp.type="file";inp.accept="image/*,video/*,application/pdf,.pdf,.doc,.docx,.xls,.xlsx";inp.onchange=async()=>{const f=inp.files[0];if(!f)return;if(f.size>10*1024*1024){uiAlert("10MB以下のファイルにしてください");return;}const btn=document.getElementById("attach");if(btn){btn.disabled=true;btn.textContent="⏳";}try{const b64=await new Promise((res,rej)=>{const rd=new FileReader();rd.onload=()=>res(String(rd.result).split(",")[1]);rd.onerror=rej;rd.readAsDataURL(f);});const up=await api("/api/upload",{name:f.name,mime:f.type||"application/octet-stream",data:b64});const uj=await up.json();if(!uj.ok)throw new Error(uj.error||"upload");const sr=await api("/api/send-file",{id:current,fileId:uj.fileId});const sj=await sr.json();if(!sj.sent)uiAlert("送信失敗: "+(sj.sendErr||"不明"));await load();}catch(e){uiAlert("ファイル送信に失敗しました: "+e.message);}if(btn){btn.disabled=false;btn.textContent="📎";}};inp.click();}
async function shareClinic(){const note=await uiPrompt("現場に伝える内容を入力してください（空欄のままOKを押すと、お客様の直近メッセージをそのまま共有します）","");if(note===null)return;try{const r=await api("/api/share",{id:current,note:note||""});const j=await r.json();if(j.ok)uiAlert("現場ボードに共有しました");else uiAlert("共有に失敗しました");}catch(e){uiAlert("共有に失敗しました");}}
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
function dBookingCard(info){const card=document.createElement("div");card.className="amcard";const conversationId=info.conversationId||current;
  const title=document.createElement("div");title.className="t";title.textContent="⚠ 予約操作の最終確認";card.appendChild(title);
  const warning=document.createElement("div");warning.style.cssText="color:#b45309;font-weight:600;margin-bottom:7px;";warning.textContent=info.warning||"まだ実行されていません。";card.appendChild(warning);
  const body=document.createElement("div");body.className="c";body.style.maxHeight="none";body.textContent=info.summary||"";card.appendChild(body);
  const row=document.createElement("div");row.style.cssText="display:flex;gap:7px;flex-wrap:wrap;";
  const run=document.createElement("button");run.textContent="対象を確認して実行";run.style.background="#dc2626";
  const stop=document.createElement("button");stop.textContent="実行しない";stop.style.background="#6b7280";
  async function decide(approve){run.disabled=true;stop.disabled=true;run.textContent=approve?"実行中…":"取り消し中…";try{const r=await api("/api/staff-booking-confirm",{id:conversationId,requestId:info.requestId,approve});const j=await r.json();if(j.ok){dAdd("sysn",(j.done?"✅ ":"↩ ")+(j.text||"完了しました"));card.remove();await load();}else{dAdd("sysn","⚠ "+(j.text||staffBookingError(j.error)));run.disabled=false;stop.disabled=false;run.textContent="対象を確認して実行";}}catch(e){dAdd("sysn","通信エラーで結果を確認できません。うけつけるんの予約詳細を確認してください。");}}
  run.onclick=()=>decide(true);stop.onclick=()=>decide(false);row.appendChild(run);row.appendChild(stop);card.appendChild(row);dMsgsEl.appendChild(card);dMsgsEl.scrollTop=dMsgsEl.scrollHeight;}
function staffBookingError(code){return ({not_linked:"うけつけるん連携が有効ではありません。",patient_not_verified:"この会話の患者を安全に特定できないため操作できません。",appointment_mismatch:"現在の患者の予約と一致しないため停止しました。",not_changeable:"この予約は変更・キャンセルできません。",patient_confirmation_pending:"患者様への確認待ち手続きがあるため、先にそちらを完了してください。",staff_confirmation_pending:"別の予約操作が確認待ちです。先に表示中の確認カードを実行または取り消してください。",slot_taken:"指定枠はすでに埋まっています。",bad_date:"日付を確認してください。",bad_datetime:"変更先の日時を確認してください。",expired:"確認期限が切れました。もう一度指示してください。",result_unknown:"実行結果を確認できません。うけつけるんの予約詳細で確認してください。"})[code]||"予約システムで処理できませんでした。";}
async function dHandleBookingAction(action){if(!action||!action.type)return;dAdd("sysn","うけつけるんで対象患者と最新の予約状態を確認しています…");try{const r=await api("/api/staff-booking-action",Object.assign({id:current},action));const j=await r.json();if(j.ok&&j.kind==="info")dAdd("ai",j.text||"確認できました");else if(j.ok&&j.kind==="confirm")dBookingCard(j);else{let msg=j.text||staffBookingError(j.error);if(j.alternatives&&j.alternatives.length)msg+="\\n空き候補: "+j.alternatives.map(x=>x.label).join(" / ");dAdd("sysn","⚠ "+msg);}}catch(e){dAdd("sysn","うけつけるんへ接続できませんでした。予約操作は行っていません。");}}
function openDraftChat(){if(!current)return;const openId=current;const c=DATA.find(x=>x.id===openId);if(!c)return;
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
  const app=document.getElementById("app");if(app)app.classList.add("dopen"); // 会話エリアをドロワー分だけ詰める（横並び表示）
  fetch("/api/staff-booking-pending?id="+encodeURIComponent(openId)).then(r=>r.json()).then(j=>{if(current===openId&&j&&j.pending)dBookingCard(j.pending);}).catch(()=>{});
  setTimeout(()=>{const t=document.getElementById("dText");if(t)t.focus();},50);}
function slideClose(pid,cid){const p=document.getElementById(pid),c=document.getElementById(cid);if(!p||!c)return;
  const mob=window.matchMedia("(max-width:760px)").matches;
  c.style.animation=(mob?"slideoutY":"slideoutX")+" .22s ease forwards";
  setTimeout(()=>{p.style.display="none";c.style.animation="";},220);}
function closeDraftChat(){const app=document.getElementById("app");if(app)app.classList.remove("dopen");slideClose("dpanel","dCard");}
function dChip(t){const x=document.getElementById("dText");x.value=t;dSend();}
// GPT風ストリーミング送信。返事が文字単位で流れ、下書きカードもリアルタイムに埋まる。失敗時は従来API(JSON)へ自動フォールバック。
async function dSend(){if(window.__dBusy)return;const x=document.getElementById("dText");const txt=x.value.trim();if(!txt)return;window.__dBusy=true;x.value="";
  dAdd("user",txt);dHist.push({role:"user",content:txt});
  const logEntry={type:"ai",text:""};dLog.push(logEntry);
  const aiEl=dRender("ai","…");
  let cardEntry=null;
  const MK_D="@@DRAFT@@",MK_M="@@MEMORY@@",MK_R="@@RULE@@",MK_A="@@ACTION@@",MK_T="@@META@@";
  function applyAcc(acc){
    const mi=acc.indexOf(MK_T);const body=(mi>=0?acc.slice(0,mi):acc).replace("@@REPLY@@","");
    let reply=body,draft=null;
    const di=body.indexOf(MK_D);
    const marks=[body.indexOf(MK_M),body.indexOf(MK_R),body.indexOf(MK_A)].filter(x=>x>=0).sort((a,b)=>a-b);
    const firstMark=marks.length?marks[0]:-1;
    if(di>=0){reply=body.slice(0,di);const after=marks.find(x=>x>di);draft=body.slice(di+MK_D.length,after==null?undefined:after);}
    else if(firstMark>=0){reply=body.slice(0,firstMark);}
    reply=reply.trim();
    if(reply){aiEl.textContent=reply;logEntry.text=reply;}
    if(draft!=null){const dtx=draft.trim();
      if(dtx){
        if(!cardEntry){cardEntry={type:"card",draft:dtx,applied:false};dLog.push(cardEntry);cardEntry._el=dDraftCard(cardEntry);}
        else{cardEntry.draft=dtx;const cEl=cardEntry._el?cardEntry._el.querySelector(".c"):null;if(cEl)cEl.textContent=dtx;}
      }}
    dMsgsEl.scrollTop=dMsgsEl.scrollHeight;
    return {reply,draft:(draft!=null?draft.trim():null),meta:(mi>=0?acc.slice(mi+MK_T.length):null)};
  }
  try{
    const r=await fetch("/api/draft-chat-stream",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({id:current,messages:dHist})});
    if(!r.ok||!r.body)throw new Error("stream_unavailable");
    const reader=r.body.getReader();const dec=new TextDecoder();let acc="";
    while(true){const s=await reader.read();if(s.done)break;acc+=dec.decode(s.value,{stream:true});applyAcc(acc);}
    const fin=applyAcc(acc);
    let meta={};try{meta=fin.meta?JSON.parse(fin.meta):{};}catch(e){}
    if(meta.ok===false||(!fin.reply&&!fin.draft))throw new Error("stream_empty");
    if(fin.reply&&meta.engine){aiEl.textContent=fin.reply+" 〔"+meta.engine+"で作成〕";logEntry.text=aiEl.textContent;}
    dHist.push({role:"assistant",content:(fin.draft||fin.reply||"").slice(0,4000)});
    if(meta.memory)dAdd("sysn","🧠 記憶しました：「"+meta.memory+"」（今後の全返信に適用します。設定→学習データ管理 で確認・編集できます）");
    if(meta.rule)dAdd("sysn","📚 ルールを学習：「"+meta.rule.title+"」（今後は聞かれたら自動でこの内容を答えます。設定→学習データ管理 で確認・編集できます）");
    if(meta.action)await dHandleBookingAction(meta.action);
  }catch(e){
    // フォールバック: 従来のJSON API
    aiEl.textContent="書き直し中…";
    try{
      const r2=await api("/api/draft-chat",{id:current,messages:dHist});
      const j=await r2.json();
      if(j.ok&&j.draft){
        aiEl.textContent=j.reply||"できました";logEntry.text=aiEl.textContent;
        if(!cardEntry)dNewCard(j.draft);else{cardEntry.draft=j.draft;const cEl=cardEntry._el?cardEntry._el.querySelector(".c"):null;if(cEl)cEl.textContent=j.draft;}
        dHist.push({role:"assistant",content:j.draft});
        if(j.memory)dAdd("sysn","🧠 記憶しました：「"+j.memory+"」（今後の全返信に適用します。設定→学習データ管理 で確認・編集できます）");
        if(j.rule)dAdd("sysn","📚 ルールを学習：「"+j.rule.title+"」（今後は聞かれたら自動でこの内容を答えます。設定→学習データ管理 で確認・編集できます）");
        if(j.action)await dHandleBookingAction(j.action);
      }else{aiEl.textContent="エラー: "+(j.error||"不明");logEntry.type="sysn";logEntry.text=aiEl.textContent;aiEl.className="am sysn";}
    }catch(e2){aiEl.textContent="通信エラーが発生しました";logEntry.type="sysn";logEntry.text=aiEl.textContent;aiEl.className="am sysn";}
  }finally{window.__dBusy=false;}}
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
    if(f.size>14*1024*1024){uiAlert("14MB以下のファイルにしてください");return;}
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
async function addPref(){const inp=document.getElementById("prefInput");const text=(inp&&inp.value||"").trim();if(!text)return;try{const r=await api("/api/pref-add",{text});const j=await r.json();if(j.ok){if(inp)inp.value="";renderPrefs(j.prefs||[]);}}catch(e){uiAlert("追加に失敗しました");}}
async function delPref(id){try{const r=await api("/api/pref-delete",{id});const j=await r.json();if(j.ok)renderPrefs(j.prefs||[]);}catch(e){}}
// 店舗ルール・スタッフの記憶・過去の対応例を、保存先は分けたまま一画面で管理する。
let LEARN={rules:[],prefs:[],examples:[]},learnTab="rules";
function learnField(label,value,rows,readOnly){
  const box=document.createElement("label");box.style.cssText="display:block;margin-top:8px;font-size:11px;font-weight:600;color:#475569;";box.appendChild(document.createTextNode(label));
  const el=rows?document.createElement("textarea"):document.createElement("input");if(!rows)el.type="text";el.value=value||"";if(rows)el.rows=rows;if(readOnly)el.readOnly=true;
  el.style.cssText="display:block;width:100%;box-sizing:border-box;margin-top:3px;padding:8px;border:1px solid #d1d5db;border-radius:8px;font:12px/1.55 inherit;resize:vertical;"+(readOnly?"background:#f8fafc;color:#64748b;":"");box.appendChild(el);return {box,el};
}
function learnButton(label,primary,fn){const b=document.createElement("button");b.type="button";b.className="cbtn"+(primary?" send":"");b.textContent=label;b.onclick=fn;return b;}
function learnCard(){const d=document.createElement("div");d.style.cssText="border:1px solid #e5e7eb;border-radius:11px;padding:11px;margin-bottom:10px;background:#fff;";return d;}
function setLearnStatus(text,bad){const e=document.getElementById("learnStatus");if(e){e.textContent=text||"";e.style.color=bad?"#dc2626":"#6b7280";}}
async function reloadLearning(){
  setLearnStatus("読み込み中…");
  try{const r=await fetch("/api/learning-data");const j=await r.json();if(!r.ok||!j.ok)throw new Error("load");LEARN={rules:j.rules||[],prefs:j.prefs||[],examples:j.examples||[]};renderLearning();setLearnStatus("");}
  catch(e){setLearnStatus("学習データを読み込めませんでした",true);}
}
function openLearning(){document.getElementById("learnManagePop").style.display="flex";reloadLearning();}
function closeLearning(){document.getElementById("learnManagePop").style.display="none";}
function setLearningTab(tab){learnTab=tab;document.getElementById("learnSearch").value="";renderLearning();}
function learningMatches(item,query){if(!query)return true;return Object.values(item||{}).some(v=>String(v||"").toLowerCase().includes(query));}
function renderLearning(){
  const list=document.getElementById("learnList");if(!list)return;list.innerHTML="";
  document.getElementById("learnRulesCount").textContent="("+LEARN.rules.length+")";document.getElementById("learnPrefsCount").textContent="("+LEARN.prefs.length+")";document.getElementById("learnExamplesCount").textContent="("+LEARN.examples.length+")";
  document.querySelectorAll(".learnTabBtn").forEach(b=>{const on=b.dataset.tab===learnTab;b.style.background=on?"#ecfdf5":"#fff";b.style.borderColor=on?"#10b981":"#d1d5db";b.style.color=on?"#047857":"#374151";});
  const help=document.getElementById("learnHelp"),add=document.getElementById("learnAddBtn");
  if(learnTab==="rules"){help.textContent="店舗の料金・営業時間・対応可否などの事実や規定です。関連する質問への回答では最優先で使われます。";add.style.display="inline-block";add.textContent="＋店舗ルールを追加";}
  else if(learnTab==="prefs"){help.textContent="文体や案内方針など、すべての返信に毎回適用する指示です。患者固有の情報は登録しないでください。";add.style.display="inline-block";add.textContent="＋スタッフの記憶を追加";}
  else{help.textContent="スタッフが実際に送った返信の実例です。似た問い合わせのときだけ参考にします。患者情報を含む場合があるため、不要な例は削除できます。";add.style.display="none";}
  const q=(document.getElementById("learnSearch").value||"").trim().toLowerCase();const items=(LEARN[learnTab]||[]).filter(x=>learningMatches(x,q));
  if(!items.length){const e=document.createElement("div");e.style.cssText="text-align:center;color:#94a3b8;padding:42px 10px;font-size:13px;";e.textContent=q?"検索に一致するデータはありません":"まだデータはありません";list.appendChild(e);return;}
  items.forEach(item=>{if(learnTab==="rules")renderLearnRule(list,item);else if(learnTab==="prefs")renderLearnPref(list,item);else renderLearnExample(list,item);});
}
function renderLearnRule(list,item){
  const card=learnCard(),title=learnField("見出し",item.title||"",0),content=learnField("ルール本文",item.content||"",4);card.appendChild(title.box);card.appendChild(content.box);
  const row=document.createElement("div");row.style.cssText="display:flex;justify-content:flex-end;gap:7px;margin-top:9px;";
  if(item.id!=null)row.appendChild(learnButton("削除",false,async()=>{if(!await uiConfirm("この店舗ルールを削除しますか？"))return;await learnMutate("/api/rule-delete",{id:item.id},"削除しました");}));
  row.appendChild(learnButton("保存",true,async()=>{await learnMutate("/api/rule-save",{id:item.id,title:title.el.value,content:content.el.value},"保存しました");}));card.appendChild(row);list.appendChild(card);
}
function renderLearnPref(list,item){
  const card=learnCard(),text=learnField("全返信に適用する指示",item.text||"",3);card.appendChild(text.box);const row=document.createElement("div");row.style.cssText="display:flex;justify-content:flex-end;gap:7px;margin-top:9px;";
  if(item.key)row.appendChild(learnButton("削除",false,async()=>{if(!await uiConfirm("このスタッフの記憶を削除しますか？"))return;await learnMutate("/api/pref-delete",{key:item.key},"削除しました");}));
  row.appendChild(learnButton("保存",true,async()=>{await learnMutate(item.key?"/api/pref-update":"/api/pref-add",item.key?{key:item.key,text:text.el.value}:{text:text.el.value},"保存しました");}));card.appendChild(row);list.appendChild(card);
}
function renderLearnExample(list,item){
  const card=learnCard();const date=document.createElement("div");date.style.cssText="font-size:10px;color:#94a3b8;";date.textContent=item.ts?new Date(item.ts).toLocaleString("ja-JP"):"日時不明";card.appendChild(date);
  const q=learnField("患者からの問い合わせ",item.q||"",3),final=learnField("スタッフが実際に送った返信",item.final||"",5),instr=learnField("返信作成時の修正指示（任意）",item.instr||"",2);card.appendChild(q.box);card.appendChild(final.box);card.appendChild(instr.box);
  if(item.draft0){const det=document.createElement("details");det.style.cssText="margin-top:8px;font-size:11px;color:#64748b;";const sum=document.createElement("summary");sum.textContent="元のAI下書きを確認（編集不可）";sum.style.cursor="pointer";det.appendChild(sum);const draft=learnField("",item.draft0,3,true);det.appendChild(draft.box);card.appendChild(det);}
  const row=document.createElement("div");row.style.cssText="display:flex;justify-content:flex-end;gap:7px;margin-top:9px;";row.appendChild(learnButton("削除",false,async()=>{if(!await uiConfirm("この過去の対応例を削除しますか？"))return;await learnMutate("/api/example-delete",{id:item.id},"削除しました");}));row.appendChild(learnButton("保存",true,async()=>{await learnMutate("/api/example-update",{id:item.id,q:q.el.value,final:final.el.value,instr:instr.el.value},"保存しました");}));card.appendChild(row);list.appendChild(card);
}
async function learnMutate(path,body,done){
  setLearnStatus("保存中…");try{const r=await api(path,body);const j=await r.json().catch(()=>({}));if(!r.ok||!j.ok)throw new Error(j.error||"save");await reloadLearning();setLearnStatus(done||"保存しました");setTimeout(()=>{const e=document.getElementById("learnStatus");if(e&&e.textContent===done)e.textContent="";},1800);}
  catch(e){setLearnStatus(e.message==="required"?"未入力の項目があります":"保存できませんでした",true);}
}
function addLearningItem(){if(learnTab==="rules")LEARN.rules.unshift({id:null,title:"",content:""});else if(learnTab==="prefs")LEARN.prefs.unshift({key:"",text:""});renderLearning();const list=document.getElementById("learnList");if(list)list.scrollTop=0;}
// 学習トースト：下書きを修正して送った直後だけ「✓学習しました」と控えめに表示。特例だった場合は「学習しない」で今保存した例を取り消せる。
let learnToastTimer=null;
function showLearnToast(id){ const b=document.getElementById("learnToast"); if(!b)return; b.innerHTML='✓ この対応を学習しました'+(id?' ・ <span style="text-decoration:underline;cursor:pointer;color:#a7f3d0;" onclick="undoLearn('+id+')">特例だった（学習しない）</span>':''); b.style.display="block"; clearTimeout(learnToastTimer); learnToastTimer=setTimeout(()=>{b.style.display="none";}, id?6000:2500); }
// ルール蒸留の結果トースト。何を覚えたかを具体的に見せる（addのみ取り消し可。updateは店舗ルール画面で編集）。
function showRuleToast(rules){ const b=document.getElementById("learnToast"); if(!b||!rules||!rules.length)return; const r=rules[0]; const more=rules.length>1?(" 他"+(rules.length-1)+"件"):""; const undo=(r.action==="add")?' ・ <span style="text-decoration:underline;cursor:pointer;color:#a7f3d0;" onclick="undoRule('+r.id+')">取り消す</span>':'（既存ルールを更新）'; b.innerHTML='📚 ルールを学習：「'+esc(r.title)+'」'+more+undo; b.style.display="block"; clearTimeout(learnToastTimer); learnToastTimer=setTimeout(()=>{b.style.display="none";}, 9000); }
async function undoRule(id){ let ok=false; try{ const r=await api("/api/rule-undo",{id}); const j=await r.json(); ok=!!j.ok; }catch(e){} const b=document.getElementById("learnToast"); if(b){ b.innerHTML=ok?'ルールを取り消しました':'取り消せませんでした（設定→学習データ管理 から削除できます）'; clearTimeout(learnToastTimer); learnToastTimer=setTimeout(()=>{b.style.display="none";},2500); } }
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
async function openSet(){try{const ar=await fetch("/api/account");const a=await ar.json();document.getElementById("accountLoginId").textContent="ログインID: "+(a.loginId||"");document.getElementById("setAccountEmail").value=a.accountEmail||"";document.getElementById("accountEmailStat").textContent=(a.accountEmail?"再設定メールアドレス登録済み":"再設定メールアドレス未登録")+(a.resetEmailReady?"・メール送信可能":"・送信メール設定が必要");}catch(e){}
  try{const r=await fetch("/api/settings");const s=await r.json();document.getElementById("setAuto").checked=!!s.autoReply;document.getElementById("setBookingActions").checked=!!s.bookingActions;document.getElementById("setSlackEnabled").checked=!!s.slackEnabled;document.getElementById("setSlackReplyMode").value=s.slackReplyMode||"exceptions";document.getElementById("setSlackReplyMode").disabled=!s.slackInteractive;document.getElementById("slackModeNote").textContent=s.slackInteractive?"自動返信がONの場合に適用します。Slackでは返信案の承認、修正指示、患者・予約情報の確認ができます。":"SlackへOAuth接続すると承認・修正機能を選べます。手動Webhookは通知だけです。";document.getElementById("setSlackWebhook").value="";const sc=s.slackConnection||null;document.getElementById("slackStat").innerHTML=sc&&sc.oauth?("接続先：<b>"+esc(sc.team||"Slack")+" / #"+esc(sc.channel||"通知先")+"</b><br>通知："+(s.slackEnabled?"有効":"停止中（内容を確認して保存すると有効化できます）")):(s.slackConfigured?"Webhook手動設定済み":"Slack未接続");const actions=document.getElementById("slackOAuthActions");actions.style.display=s.slackOAuthAvailable?"flex":"none";const cb=document.getElementById("slackConnectBtn");cb.textContent=s.slackConfigured?"接続先を変更":"Slackに接続";document.getElementById("slackTestBtn").style.display=s.slackConfigured?"inline-block":"none";document.getElementById("slackDisconnectBtn").style.display=s.slackConfigured?"inline-block":"none";document.getElementById("slackLegacy").style.display=s.slackOAuthAvailable?"none":"block";document.getElementById("setLevel").value=s.level||"high";document.getElementById("setTone").value=s.tone||"";document.getElementById("setEngine").value=s.engine||"gemini";document.getElementById("setDelay").value=(s.autoDelayMin!=null?s.autoDelayMin:0);window.__rules=s.rules||null;renderRuleGauge();renderPrefs(s.prefs||[]);
  if(s.engines){const n=document.getElementById("engineNote");n.textContent="文章作成は選択中のAIで生成（GPT"+(s.engines.gpt?"✓":"⚠キー未設定")+"・Gemini"+(s.engines.gemini?"✓":"⚠")+"・Claude"+(s.engines.claude?"✓":"⚠")+"）。キー未設定のエンジンを選ぶと安全のためClaudeで生成します。";}}catch(e){}
  refreshModelAlert();
  try{const cr=await fetch("/api/conn");const c=await cr.json();document.getElementById("connStat").textContent=(c.lineConfigured?"LINE✓ ":"LINE未 ")+(c.mailConfigured?"メール✓":"メール未");document.getElementById("cSmtpHost").value=c.smtpHost||"";document.getElementById("cSmtpPort").value=c.smtpPort||"";document.getElementById("cSmtpUser").value=c.smtpUser||"";document.getElementById("cImapHost").value=c.imapHost||"";document.getElementById("cImapPort").value=c.imapPort||"";document.getElementById("cImapUser").value=c.imapUser||"";document.getElementById("cEmailInternal").checked=!!c.emailInternal;renderAccts(c);}catch(e){}
  document.getElementById("setPop").style.display="flex";}
function renderAccts(c){const el=document.getElementById("acctList");if(!el)return;let h="";
  (c.extraLines||[]).forEach((a,i)=>{h+='<div style="display:flex;justify-content:space-between;align-items:center;padding:3px 0;"><span>📱 '+esc(a.name)+'</span><button class="cbtn" onclick="delAcct(&quot;line&quot;,'+i+')">削除</button></div>';});
  (c.extraMails||[]).forEach((a,i)=>{h+='<div style="display:flex;justify-content:space-between;align-items:center;padding:3px 0;"><span>✉ '+esc(a.name)+' <span style="color:#9ca3af;">'+esc(a.smtpUser)+'</span></span><button class="cbtn" onclick="delAcct(&quot;mail&quot;,'+i+')">削除</button></div>';});
  el.innerHTML=h||'<div style="color:#9ca3af;">追加アカウントはまだありません</div>';}
async function addLineAcct(){
  const name=await uiPrompt("表示名（例：銀座7丁目院LINE）");if(!name)return;
  const token=await uiPrompt("チャネルアクセストークン（LINE Developersからコピー）");if(!token)return;
  const secret=await uiPrompt("チャネルシークレット");if(!secret)return;
  try{const r=await api("/api/conn-add",{kind:"line",name,token:token.trim(),secret:secret.trim()});const j=await r.json();
    if(j.ok){uiAlert("LINEアカウントを追加しました。\\nLINE Developersのそのチャネルに、このアプリと同じWebhook URLを設定してください。");openSet();}
    else uiAlert("追加失敗: "+(j.error==="bad_token"?"トークンが正しくありません":j.error||"不明"));
  }catch(e){uiAlert("追加に失敗しました");}}
async function addMailAcct(){
  const name=await uiPrompt("表示名（例：本院メール）");if(!name)return;
  const u=await uiPrompt("メールアドレス");if(!u)return;
  const p=await uiPrompt("アプリパスワード（送受信共通）");if(!p)return;
  const host=await uiPrompt("SMTPホスト（Gmailなら空欄のままOK）","");if(host===null)return;
  const ihost=host?await uiPrompt("IMAPホスト","")||"":"";
  try{const body={kind:"mail",name,smtpUser:u.trim(),smtpPass:p.trim()};if(host)body.smtpHost=host.trim();if(ihost)body.imapHost=ihost.trim();
    const r=await api("/api/conn-add",body);const j=await r.json();
    if(j.ok){uiAlert("メールアカウントを追加しました。受信監視も自動で始まります。");openSet();}
    else uiAlert("追加失敗: "+(j.error||"不明"));
  }catch(e){uiAlert("追加に失敗しました");}}
async function delAcct(kind,i){if(!await uiConfirm("この連携を削除しますか？（この連携で届く新着が止まります）"))return;
  try{await api("/api/conn-del",{kind,i});}catch(e){}openSet();}
async function saveConn(){const g=id=>document.getElementById(id).value.trim();const body={lineSecret:g("cLineSecret"),lineToken:g("cLineToken"),smtpHost:g("cSmtpHost"),smtpPort:g("cSmtpPort"),smtpUser:g("cSmtpUser"),smtpPass:g("cSmtpPass"),imapHost:g("cImapHost"),imapPort:g("cImapPort"),imapUser:g("cImapUser"),imapPass:g("cImapPass"),emailInternal:document.getElementById("cEmailInternal").checked};try{const r=await api("/api/conn",body);const j=await r.json();if(j.ok){uiAlert("連携設定を保存しました。\\nLINE: "+(j.lineConfigured?"設定済み":"未設定")+" / メール: "+(j.mailConfigured?"設定済み":"未設定")+" / メール直接監視: "+(j.emailInternal?"オン":"オフ"));["cLineSecret","cLineToken","cSmtpPass","cImapPass"].forEach(id=>document.getElementById(id).value="");}else uiAlert("保存に失敗しました");}catch(e){uiAlert("保存に失敗しました");}}
async function saveAccount(){const accountEmail=document.getElementById("setAccountEmail").value.trim();try{const r=await api("/api/account",{accountEmail});const j=await r.json();if(j.ok){document.getElementById("accountEmailStat").textContent="再設定メールアドレス登録済み"+(j.account.resetEmailReady?"・メール送信可能":"・送信メール設定が必要");uiAlert("アカウント情報を保存しました");}else uiAlert(j.error==="bad_email"?"正しいメールアドレスを入力してください":"保存に失敗しました");}catch(e){uiAlert("保存に失敗しました");}}
function closeSet(){document.getElementById("setPop").style.display="none";}
function connectSlack(){location.href="/api/slack/oauth/start";}
async function testSlack(){const webhook=document.getElementById("setSlackWebhook").value.trim();try{const r=await api("/api/slack-test",{webhook});const j=await r.json();if(j.ok)uiAlert("Slackへテスト通知を送りました");else uiAlert(j.error==="invalid_slack_webhook"?"Webhook URLが正しくありません":"Slackへ接続できませんでした");}catch(e){uiAlert("Slackへ接続できませんでした");}}
async function disconnectSlack(){if(!await uiConfirm("右腕くんとSlackの連携を解除しますか？\\nSlack通知は停止します。"))return;try{const r=await api("/api/slack/disconnect",{});const j=await r.json();if(!j.ok)throw new Error("disconnect");uiAlert("Slack連携を解除しました");openSet();}catch(e){uiAlert("連携解除に失敗しました");}}
async function saveSet(){const autoReply=document.getElementById("setAuto").checked;const bookingActions=document.getElementById("setBookingActions").checked;const slackEnabled=document.getElementById("setSlackEnabled").checked;const slackReplyMode=document.getElementById("setSlackReplyMode").value;const slackWebhook=document.getElementById("setSlackWebhook").value.trim();const level=document.getElementById("setLevel").value;const tone=document.getElementById("setTone").value;const engine=document.getElementById("setEngine").value;const autoDelayMin=Math.min(60,Math.max(0,Math.round(Number(document.getElementById("setDelay").value)||0)));try{const r=await api("/api/settings",{autoReply,bookingActions,slackEnabled,slackReplyMode,slackWebhook,level,tone,engine,autoDelayMin});const j=await r.json();if(!j.ok)throw new Error(j.error||"save");uiAlert("設定を保存しました");closeSet();}catch(e){uiAlert(e.message==="invalid_slack_webhook"?"Slack Webhook URLが正しくありません":e.message==="slack_not_configured"?"先にSlackへ接続してください":e.message==="slack_interactive_required"?"Slackを再接続して承認機能を有効にしてください":"保存に失敗しました");}}
async function changeLoginId(){
  const next=await uiPrompt("新しいログインID（半角英数字3〜30文字。スタッフ全員のログインに使います）");if(!next)return;
  try{const r=await api("/api/change-loginid",{next:next.trim()});const j=await r.json();
    if(j.ok)uiAlert("ログインIDを「"+j.loginId+"」に変更しました。スタッフに共有してください");
    else uiAlert(j.error==="id_taken"?"このIDは既に使われています":j.error==="bad_id"?"半角英数字3〜30文字にしてください":"変更に失敗しました");
  }catch(e){uiAlert("変更に失敗しました");}}
async function changePass(){
  const cur=await uiPrompt("現在のパスワードを入力してください");if(cur===null)return;
  const np=await uiPrompt("新しいパスワード（8文字以上）を入力してください");if(np===null)return;
  try{const r=await api("/api/change-pass",{current:cur,next:np});
    if(r.ok){uiAlert("パスワードを変更しました。他のスタッフにも新しいパスワードを共有してください（各端末で次回ログインし直しが必要です）。");}
    else{const j=await r.json().catch(()=>({}));uiAlert(j.error==="wrong_current"?"現在のパスワードが違います":j.error==="too_short"?"8文字以上にしてください":"変更に失敗しました");}
  }catch(e){uiAlert("変更に失敗しました");}
}
async function doLogout(){if(!await uiConfirm("ログアウトしますか？"))return;try{await api("/api/logout",{});}catch(e){}location.reload();}
// ---- push notifications ----
if("serviceWorker" in navigator){navigator.serviceWorker.register("/sw.js").catch(()=>{});}
function ub64(s){const p="=".repeat((4-s.length%4)%4);const b=(s+p).replace(/-/g,"+").replace(/_/g,"/");const r=atob(b);const a=new Uint8Array(r.length);for(let i=0;i<r.length;i++)a[i]=r.charCodeAt(i);return a;}
async function enablePush(){
  try{
    if(!("serviceWorker" in navigator)||!("PushManager" in window)){uiAlert("この端末・ブラウザは通知に対応していません");return;}
    const ios=/iP(hone|ad|od)/.test(navigator.userAgent);
    if(ios && !window.matchMedia("(display-mode: standalone)").matches){uiAlert("iPhoneの場合：\\n1. Safariの共有ボタン（□↑）→「ホーム画面に追加」\\n2. ホーム画面のアイコンから開く\\n3. もう一度🔔を押す\\nの順でお願いします");return;}
    const reg=await navigator.serviceWorker.register("/sw.js");
    const perm=await Notification.requestPermission();
    if(perm!=="granted"){uiAlert("通知が許可されませんでした。端末の設定から許可してください。");return;}
    const kr=await fetch("/api/push-key");const kj=await kr.json();
    if(!kj.key){uiAlert("サーバー側の通知設定が未完了です");return;}
    const sub=await reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:ub64(kj.key)});
    await api("/api/subscribe",{sub:JSON.parse(JSON.stringify(sub))});
    const b=document.getElementById("bellBtn");if(b)b.textContent="🔔ON";
    uiAlert("通知をオンにしました。新しい問い合わせが届くとこの端末に通知されます。");
  }catch(e){uiAlert("通知設定に失敗しました: "+e.message);}
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
// 自動化ダッシュボード帯（直近7日の自動対応状況）。起動時＋5分ごとに更新。
async function loadStats(){try{const r=await fetch("/api/stats");const j=await r.json();if(!j||!j.ok)return;const w=j.week||{};const el=document.getElementById("statsBar");if(!el)return;const rate=(w.autoRate==null)?"—":(w.autoRate+"%");el.innerHTML="📊 直近7日：問い合わせ <b>"+(w.in||0)+"</b> 件 ・ AI自動返信率 <b>"+rate+"</b>（"+(w.auto||0)+"件）・ スタッフ返信 <b>"+(w.staff||0)+"</b> 件 ・ 学習ルール <b>+"+(w.rules||0)+"</b> 件";el.style.display="block";}catch(e){}}
load(); setInterval(load, 6000); refreshModelAlert(); loadStats(); setInterval(loadStats, 300000);
try{const sp=new URLSearchParams(location.search);const sr=sp.get("slack");if(sr){history.replaceState(null,"",location.pathname);setTimeout(()=>{openSet();uiAlert(sr==="connected"?"Slackへ接続しました。接続先を確認し、通知を有効にして設定を保存してください。":"Slackへの接続に失敗しました。もう一度お試しください。");},300);}}catch(e){}
</script>
</body>
</html>`;
