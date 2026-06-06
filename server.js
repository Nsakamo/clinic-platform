process.env.TZ = "Asia/Tokyo";
const express = require("express");
const crypto = require("crypto");
const app = express();
app.use(express.json({ limit: "16mb", verify: (req, res, buf) => { req.rawBody = buf; } }));
const PORT = process.env.PORT || 3000;
const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY || ""; // shared key, you pay
const PLATFORM_SECRET = process.env.PLATFORM_SECRET || "change-me-secret";

// ---------- Postgres ----------
let pool = null;
if (process.env.DATABASE_URL) {
  try { const { Pool } = require("pg"); pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false, max: 6 }); }
  catch (e) { console.error("pg init failed:", e.message); pool = null; }
}
async function dbInit() {
  if (!pool) return;
  await pool.query("CREATE TABLE IF NOT EXISTS tenants (slug text primary key, name text, created bigint, config jsonb)");
  await pool.query("CREATE TABLE IF NOT EXISTS convos (tenant text, id text, ts bigint, data jsonb, primary key(tenant,id))");
  await pool.query("CREATE TABLE IF NOT EXISTS rules (id serial primary key, tenant text, title text, content text, updated_at bigint)");
  await pool.query("CREATE TABLE IF NOT EXISTS alerts (id serial primary key, tenant text, type text, summary text, name text, ts bigint, done boolean default false)");
  await pool.query("CREATE TABLE IF NOT EXISTS files (id text primary key, tenant text, name text, mime text, data bytea, ts bigint)");
  await pool.query("CREATE TABLE IF NOT EXISTS push_subs (endpoint text primary key, tenant text, sub jsonb)");
  const r = await pool.query("SELECT slug,name,config FROM tenants");
  r.rows.forEach(row => { TEN[row.slug] = newTenant(row.slug, row.name, row.config || {}); });
  // load per-tenant data
  for (const slug of Object.keys(TEN)) {
    const cv = await pool.query("SELECT data FROM convos WHERE tenant=$1 ORDER BY ts DESC LIMIT 1000", [slug]);
    cv.rows.forEach(x => { const c = x.data; if (c && c.id) TEN[slug].store[c.id] = c; });
    const ru = await pool.query("SELECT id,title,content FROM rules WHERE tenant=$1 ORDER BY id", [slug]);
    ru.rows.forEach(x => { TEN[slug].rules[x.id] = { id: x.id, title: x.title, content: x.content }; if (x.id >= TEN[slug].ruleSeq) TEN[slug].ruleSeq = x.id + 1; });
    const al = await pool.query("SELECT id,type,summary,name,ts,done FROM alerts WHERE tenant=$1 AND done=false ORDER BY ts DESC LIMIT 100", [slug]);
    TEN[slug].alerts = al.rows.map(x => ({ id: x.id, type: x.type, summary: x.summary, name: x.name, ts: Number(x.ts), done: x.done }));
    const ps = await pool.query("SELECT sub FROM push_subs WHERE tenant=$1", [slug]);
    ps.rows.forEach(x => { TEN[slug].push[x.sub.endpoint] = x.sub; });
    if (TEN[slug].config.lineBotId) BOTMAP[TEN[slug].config.lineBotId] = slug;
  }
  console.log("loaded " + Object.keys(TEN).length + " tenants");
}

// ---------- tenant state ----------
const TEN = {};      // slug -> tenant object
const BOTMAP = {};   // lineBotId -> slug
function newTenant(slug, name, config) {
  return { slug, name: name || slug, config: config || {}, store: {}, rules: {}, ruleSeq: 1, alerts: [], alertSeq: 1, push: {} };
}
async function saveTenantConfig(t) {
  if (pool) await pool.query("UPDATE tenants SET name=$2, config=$3 WHERE slug=$1", [t.slug, t.name, t.config]);
}
function dbSaveConvo(slug, c) {
  if (!pool || !c) return;
  pool.query("INSERT INTO convos (tenant,id,ts,data) VALUES ($1,$2,$3,$4) ON CONFLICT (tenant,id) DO UPDATE SET ts=EXCLUDED.ts, data=EXCLUDED.data", [slug, c.id, c.ts || 0, c]).catch(e => console.error("dbSaveConvo:", e.message));
}

// ---------- helpers ----------
function colorFor(s) { const cols = ["#7c93c7", "#c78a3a", "#3aa37a", "#b06fb0", "#5a8fb0", "#b05a5a", "#6f9a4a"]; let h = 0; for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) % cols.length; return cols[h]; }
function nowt() { const d = new Date(); return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0"); }
function lastText(c) { const m = c.msgs[c.msgs.length - 1]; if (!m) return ""; if (m.media === "image") return "［画像］写真"; if (m.media === "video") return "［動画］動画"; if (m.media === "file") return "［ファイル］" + (m.fileName || ""); if (m.media === "audio") return "［音声］"; return m.text || ""; }
function sha(s) { return crypto.createHash("sha256").update(s).digest("hex"); }
function cookies(req) { const o = {}; (req.headers.cookie || "").split(";").forEach(p => { const i = p.indexOf("="); if (i > 0) o[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); }); return o; }
function sessToken(slug, passHash) { return sha("sess|" + slug + "|" + passHash); }
function tenantFromReq(req) {
  const sess = cookies(req).sess || "";
  const dot = sess.lastIndexOf(".");
  if (dot < 1) return null;
  let slug; try { slug = Buffer.from(sess.slice(0, dot), "base64").toString("utf8"); } catch (e) { return null; }
  const tok = sess.slice(dot + 1);
  const t = TEN[slug];
  if (!t || !t.config.passHash) return null;
  if (tok !== sessToken(slug, t.config.passHash)) return null;
  return t;
}
function guard(req, res, next) { const t = tenantFromReq(req); if (!t) return res.status(401).json({ error: "auth" }); req.tenant = t; next(); }

// ---------- rulebook (per tenant) ----------
function rulesList(t) { return Object.values(t.rules).sort((a, b) => a.id - b.id); }
function bigrams(s) { s = String(s || "").replace(/\s+/g, ""); const set = new Set(); for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2)); return set; }
function rulesSearch(t, query, limit) {
  const list = rulesList(t);
  if (!query || list.length <= limit) return list;
  const qb = bigrams(query);
  const scored = list.map(r => { const tb = bigrams(r.title + " " + r.content); let n = 0; qb.forEach(b => { if (tb.has(b)) n++; }); return { r, n }; });
  scored.sort((a, b) => b.n - a.n || b.r.id - a.r.id);
  return scored.slice(0, limit).map(x => x.r);
}
async function ruleAdd(t, title, content) {
  if (pool) { const r = await pool.query("INSERT INTO rules (tenant,title,content,updated_at) VALUES ($1,$2,$3,$4) RETURNING id", [t.slug, title, content, Date.now()]); const id = r.rows[0].id; t.rules[id] = { id, title, content }; if (id >= t.ruleSeq) t.ruleSeq = id + 1; return t.rules[id]; }
  const id = t.ruleSeq++; t.rules[id] = { id, title, content }; return t.rules[id];
}
async function ruleUpdate(t, id, title, content) { const r = t.rules[id]; if (!r) return null; if (title != null) r.title = title; if (content != null) r.content = content; if (pool) await pool.query("UPDATE rules SET title=$1,content=$2,updated_at=$3 WHERE id=$4 AND tenant=$5", [r.title, r.content, Date.now(), id, t.slug]); return r; }
async function ruleDelete(t, id) { if (!t.rules[id]) return false; delete t.rules[id]; if (pool) await pool.query("DELETE FROM rules WHERE id=$1 AND tenant=$2", [id, t.slug]); return true; }

// ---------- alerts (per tenant) ----------
async function alertAdd(t, type, summary, name) {
  let id = t.alertSeq++;
  if (pool) { try { const r = await pool.query("INSERT INTO alerts (tenant,type,summary,name,ts,done) VALUES ($1,$2,$3,$4,$5,false) RETURNING id", [t.slug, type, summary, name, Date.now()]); id = r.rows[0].id; if (id >= t.alertSeq) t.alertSeq = id + 1; } catch (e) {} }
  t.alerts.unshift({ id, type, summary, name, ts: Date.now(), done: false }); t.alerts = t.alerts.slice(0, 200);
  try { notifyTenant(t, "🏥 " + type, (name ? name + "様: " : "") + String(summary || "").slice(0, 80)); } catch (e) {}
  return id;
}

// ---------- push (per tenant) ----------
let webpush = null; try { webpush = require("web-push"); } catch (e) {}
let VAPID = null;
async function pushInit() {
  if (!webpush) return;
  if (pool) {
    await pool.query("CREATE TABLE IF NOT EXISTS kv (k text primary key, v jsonb)");
    const r = await pool.query("SELECT v FROM kv WHERE k='vapid'");
    if (r.rows[0]) VAPID = r.rows[0].v; else { VAPID = webpush.generateVAPIDKeys(); await pool.query("INSERT INTO kv (k,v) VALUES ('vapid',$1)", [VAPID]); }
  } else VAPID = webpush.generateVAPIDKeys();
  webpush.setVapidDetails("mailto:admin@example.com", VAPID.publicKey, VAPID.privateKey);
}
function notifyTenant(t, title, body) {
  if (!webpush || !VAPID) return;
  const payload = JSON.stringify({ title: title || "新着メッセージ", body: body || "" });
  Object.values(t.push).forEach(sub => { webpush.sendNotification(sub, payload).catch(err => { if (err && (err.statusCode === 410 || err.statusCode === 404)) { delete t.push[sub.endpoint]; if (pool) pool.query("DELETE FROM push_subs WHERE endpoint=$1", [sub.endpoint]).catch(() => {}); } }); });
}

// ---------- AI brain (per tenant, shared key) ----------
async function genDraft(t, c) {
  if (!ANTHROPIC_KEY) return null;
  const channel = c.channel;
  const lastQ = c.msgs.filter(m => m.from === "them").slice(-1).map(m => m.text || "").join("");
  const rel = rulesSearch(t, lastQ.slice(0, 1000), 40);
  const rulesTxt = rel.map(r => "・" + r.title + ": " + String(r.content || "").slice(0, 400)).join("\n").slice(0, 9000);
  const tone = (t.config.tone || "").trim();
  const today = new Date().toLocaleDateString("ja-JP", { year: "numeric", month: "long", day: "numeric", weekday: "short" });
  const sig = channel === "mail" ? "メールなので返信本文の最後に改行して「" + (t.name || "クリニック") + " サポート」と署名を付ける。" : "LINEなので署名は付けない。";
  const msgsArr = []; let cur = null;
  c.msgs.slice(-16).forEach(m => { const role = m.from === "them" ? "user" : "assistant"; const tx = (m.text || (m.media ? "［" + m.media + "を送信］" : "")).trim(); if (!tx) return; if (cur && cur.role === role) cur.content = (cur.content + "\n" + tx).slice(0, 3000); else { cur = { role, content: tx.slice(0, 3000) }; msgsArr.push(cur); } });
  while (msgsArr.length && msgsArr[0].role === "assistant") msgsArr.shift();
  if (!msgsArr.length || msgsArr[msgsArr.length - 1].role !== "user") return null;
  const sys = "あなたは「" + (t.name || "クリニック") + "」の受付スタッフです。お客様とこの会話をしてきた本人として、最新のメッセージへの返信を書きます。上質で温かく、品のある丁寧な言葉遣いで対応する。"
    + "本日は" + today + "です。キャンセル料など日付が関わる案内は本日と予約日の差から判断する（前日にあたる連絡なら前日扱い、当日なら当日扱い、それより前なら通常キャンセル料は不要）。憶測で日付を決めない。"
    + "お客様が複数の質問・依頼をしている場合は全てにもれなく答える。会話で既に伝えた内容は繰り返さない。医療判断・診断はしない。断定表現や絵文字は使わない。" + sig
    + (rulesTxt ? "\n\n【店舗ルール（最優先で従う。料金・規定・対応可否はここに従い推測しない）】\n" + rulesTxt : "")
    + (tone ? "\n\n【トーン指示（最優先）】\n" + tone.slice(0, 1200) : "")
    + "\n\n出力は必ず次のJSONのみ（前後に説明や```やかぎ括弧を付けない）: {\"draft\":\"返信文\",\"confidence\":\"high|medium|low\",\"is_urgent\":true|false,\"needs_human\":true|false,\"site_alert\":\"遅刻|当日キャンセル|緊急来院|none\",\"site_summary\":\"現場向け一行要約。noneなら空文字\"}";
  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01" }, body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 1500, system: sys, messages: msgsArr }) });
    if (!resp.ok) return null;
    const data = await resp.json();
    let raw = (data.content && data.content[0] && data.content[0].text) || "";
    let out; try { const m = raw.match(/\{[\s\S]*\}/); out = JSON.parse(m ? m[0] : raw); } catch (e) { out = { draft: raw, confidence: "low", is_urgent: false, needs_human: true, site_alert: "none", site_summary: "" }; }
    return out;
  } catch (e) { return null; }
}

// ---------- delivery (per tenant) ----------
async function deliverText(t, c, text) {
  let sent = false, sendErr = null;
  const to = c.userId || (c.id.split(":")[1] || "");
  if (c.channel === "line" && t.config.lineToken && to) {
    try { const resp = await fetch("https://api.line.me/v2/bot/message/push", { method: "POST", headers: { "Content-Type": "application/json", "Authorization": "Bearer " + t.config.lineToken }, body: JSON.stringify({ to, messages: [{ type: "text", text }] }) }); sent = resp.ok; if (!resp.ok) sendErr = "LINE_" + resp.status; } catch (e) { sendErr = String(e.message || e).slice(0, 80); }
  } else if (c.channel === "mail") {
    if (t.config.smtpUser && t.config.smtpPass && to) {
      try { const nm = require("nodemailer"); const tp = nm.createTransport({ host: t.config.smtpHost || "smtp.gmail.com", port: t.config.smtpPort || 465, secure: true, auth: { user: t.config.smtpUser, pass: t.config.smtpPass } }); const subj = c.subject ? (/^re:/i.test(c.subject) ? c.subject : "Re: " + c.subject) : "お問い合わせについて"; await tp.sendMail({ from: (t.name || "クリニック") + " <" + t.config.smtpUser + ">", to, subject: subj, text }); sent = true; } catch (e) { sendErr = String(e.message || e).slice(0, 100); }
    } else sendErr = "mail_not_configured";
  } else sendErr = "no_send_config";
  return { sent, sendErr };
}

// ---------- inbound handler (per tenant) ----------
async function handleInbound(t, opts) {
  const channel = opts.channel === "mail" ? "mail" : "line";
  const uid = String(opts.uid || "unknown");
  const id = channel + ":" + uid;
  let c = t.store[id];
  if (!c) c = t.store[id] = { id, userId: uid, name: opts.name || (channel === "mail" ? uid : "LINEのお客様"), channel, color: colorFor(id), status: "todo", flag: false, msgs: [], draft: "" };
  c.userId = uid; if (opts.name) c.name = opts.name; if (opts.pic) c.pic = opts.pic;
  const med = ["image", "video", "file", "audio"].includes(opts.media) ? opts.media : null;
  c.msgs.push({ from: "them", text: opts.text || "", media: med, mediaId: med ? (opts.mediaId || null) : null, fileName: med === "file" ? (opts.fileName || "ファイル") : undefined, time: nowt() });
  if (opts.subject) c.subject = String(opts.subject).slice(0, 300);
  c.status = "todo"; c.time = nowt(); c.ts = Date.now(); c.last = lastText(c); dbSaveConvo(t.slug, c);
  let conf, needsHuman, urgent, siteAlert, siteSummary;
  if (!med) { const g = await genDraft(t, c); if (g) { c.draft = String(g.draft || ""); c.draft0 = c.draft; conf = g.confidence; needsHuman = g.needs_human; urgent = g.is_urgent; siteAlert = g.site_alert; siteSummary = g.site_summary; } }
  if (conf) c.confidence = conf; dbSaveConvo(t.slug, c);
  try { const sa = String(siteAlert || "").trim(); if (sa && sa !== "none") await alertAdd(t, sa, String(siteSummary || c.last || "").slice(0, 200), c.name || ""); } catch (e) {}
  let autoSent = false;
  try {
    const cf = String(conf || "").toLowerCase(); const ok = cf === "high" || (t.config.level === "medium" && cf === "medium");
    const safe = String(needsHuman) !== "true" && String(urgent) !== "true" && !c.flag && !med;
    if (t.config.autoReply && ok && safe && c.draft && c.draft.trim()) { const r = await deliverText(t, c, c.draft.trim()); if (r.sent) { c.msgs.push({ from: "us", text: c.draft.trim(), auto: true, time: nowt() }); c.draft = ""; c.draft0 = ""; c.status = "done"; c.lastAuto = true; c.time = nowt(); c.ts = Date.now(); c.last = lastText(c); dbSaveConvo(t.slug, c); autoSent = true; } }
  } catch (e) {}
  try { if (autoSent) notifyTenant(t, "🤖 自動返信済み: " + (c.name || ""), (c.last || "").slice(0, 90)); else notifyTenant(t, c.name || "新着メッセージ", (c.last || "").slice(0, 90)); } catch (e) {}
  return { id, autoSent };
}

// ---------- LINE webhook (routes by destination -> tenant) ----------
app.post("/webhook/line", async (req, res) => {
  const dest = req.body && req.body.destination;
  const slug = dest && BOTMAP[dest];
  const t = slug && TEN[slug];
  if (t && t.config.lineSecret) {
    const sig = req.headers["x-line-signature"];
    const h = crypto.createHmac("sha256", t.config.lineSecret).update(req.rawBody || Buffer.from("")).digest("base64");
    if (sig !== h) return res.status(401).end();
  }
  res.status(200).end();
  if (!t) return;
  const events = (req.body && req.body.events) || [];
  for (const ev of events) {
    try {
      if (ev.type !== "message" || !ev.message) continue;
      const uid = ev.source && ev.source.userId; if (!uid) continue;
      let name, pic;
      if (t.config.lineToken) { try { const r = await fetch("https://api.line.me/v2/bot/profile/" + uid, { headers: { "Authorization": "Bearer " + t.config.lineToken } }); if (r.ok) { const j = await r.json(); name = j.displayName; pic = j.pictureUrl; } } catch (e) {} }
      const mt = ev.message.type; let text = "", media = null, mediaId = null, fileName = null;
      if (mt === "text") text = ev.message.text || "";
      else if (mt === "image" || mt === "video" || mt === "audio") { media = mt; mediaId = ev.message.id; }
      else if (mt === "file") { media = "file"; mediaId = ev.message.id; fileName = ev.message.fileName || "ファイル"; }
      else continue;
      await handleInbound(t, { channel: "line", uid, name, pic, text, media, mediaId, fileName });
    } catch (e) { console.error("line webhook:", e.message); }
  }
});

// ---------- email polling across tenants ----------
let polling = false;
async function pollAll() {
  if (polling) return; polling = true;
  let ImapFlow, simpleParser; try { ImapFlow = require("imapflow").ImapFlow; simpleParser = require("mailparser").simpleParser; } catch (e) { polling = false; return; }
  for (const slug of Object.keys(TEN)) {
    const t = TEN[slug]; const cfg = t.config;
    if (!cfg.imapUser || !cfg.imapPass) continue;
    const client = new ImapFlow({ host: cfg.imapHost || "imap.gmail.com", port: +(cfg.imapPort || 993), secure: true, auth: { user: cfg.imapUser, pass: cfg.imapPass }, logger: false });
    try {
      await client.connect(); const lock = await client.getMailboxLock("INBOX");
      try {
        for await (const msg of client.fetch({ seen: false }, { source: true })) {
          try {
            const parsed = await simpleParser(msg.source);
            const fv = (parsed.from && parsed.from.value && parsed.from.value[0]) || {};
            const email = String(fv.address || "").toLowerCase();
            await client.messageFlagsAdd(msg.seq, ["\\Seen"], {});
            if (!email || email === String(cfg.imapUser).toLowerCase()) continue;
            if (/no-?reply|mailer-daemon|postmaster/i.test(email)) continue;
            const text = String(parsed.text || parsed.subject || "").replace(/\r/g, "").slice(0, 8000);
            await handleInbound(t, { channel: "mail", uid: email, name: fv.name || email, text, subject: parsed.subject || "" });
          } catch (e) {}
        }
      } finally { lock.release(); }
      await client.logout();
    } catch (e) { console.error("imap " + slug + ":", e.message); try { await client.logout(); } catch (_) {} }
  }
  polling = false;
}

// ---------- auth: signup / login / logout ----------
function slugify(name) { const base = String(name || "clinic").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 20) || "clinic"; return base + "-" + crypto.randomBytes(2).toString("hex"); }
app.post("/api/signup", async (req, res) => {
  const name = String(req.body.name || "").trim().slice(0, 80);
  const pass = String(req.body.password || "");
  if (!name) return res.status(400).json({ ok: false, error: "name" });
  if (pass.length < 8) return res.status(400).json({ ok: false, error: "too_short" });
  const slug = slugify(name);
  const config = { passHash: sha(pass), autoReply: false, level: "high", tone: "", resetEmail: String(req.body.email || "").slice(0, 120) };
  TEN[slug] = newTenant(slug, name, config);
  if (pool) await pool.query("INSERT INTO tenants (slug,name,created,config) VALUES ($1,$2,$3,$4)", [slug, name, Date.now(), config]);
  res.set("Set-Cookie", "sess=" + Buffer.from(slug).toString("base64") + "." + sessToken(slug, config.passHash) + "; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000");
  res.json({ ok: true, slug });
});
app.post("/api/login", (req, res) => {
  const slug = String(req.body.company || "").trim();
  const pass = String(req.body.password || "");
  const t = TEN[slug];
  if (!t || !t.config.passHash || sha(pass) !== t.config.passHash) return res.status(401).json({ ok: false });
  res.set("Set-Cookie", "sess=" + Buffer.from(slug).toString("base64") + "." + sessToken(slug, t.config.passHash) + "; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000");
  res.json({ ok: true, slug });
});
app.post("/api/logout", (req, res) => { res.set("Set-Cookie", "sess=; Path=/; HttpOnly; Max-Age=0"); res.json({ ok: true }); });

// ---------- tenant config (onboarding/settings) ----------
app.get("/api/config", guard, (req, res) => {
  const c = req.tenant.config;
  res.json({ name: req.tenant.name, slug: req.tenant.slug, lineConfigured: !!(c.lineSecret && c.lineToken && c.lineBotId), emailConfigured: !!(c.imapUser && c.imapPass && c.smtpUser && c.smtpPass), tone: c.tone || "", autoReply: !!c.autoReply, level: c.level || "high", resetEmail: c.resetEmail || "", webhookUrl: baseUrl(req) + "/webhook/line" });
});
function baseUrl(req) { return "https://" + (req.headers["x-forwarded-host"] || req.headers.host); }
app.post("/api/config", guard, async (req, res) => {
  const t = req.tenant; const b = req.body || {};
  if (typeof b.tone === "string") t.config.tone = b.tone.slice(0, 1500);
  if (typeof b.autoReply === "boolean") t.config.autoReply = b.autoReply;
  if (b.level === "high" || b.level === "medium") t.config.level = b.level;
  if (typeof b.resetEmail === "string") t.config.resetEmail = b.resetEmail.slice(0, 120);
  // email creds
  ["imapHost", "imapUser", "imapPass", "smtpHost", "smtpUser", "smtpPass"].forEach(k => { if (typeof b[k] === "string" && b[k]) t.config[k] = b[k].slice(0, 200); });
  if (b.imapPort) t.config.imapPort = +b.imapPort; if (b.smtpPort) t.config.smtpPort = +b.smtpPort;
  // LINE creds — when token provided, detect bot userId
  if (typeof b.lineSecret === "string" && b.lineSecret) t.config.lineSecret = b.lineSecret.trim();
  if (typeof b.lineToken === "string" && b.lineToken) {
    t.config.lineToken = b.lineToken.trim();
    try { const r = await fetch("https://api.line.me/v2/bot/info", { headers: { "Authorization": "Bearer " + t.config.lineToken } }); if (r.ok) { const j = await r.json(); if (j.userId) { if (t.config.lineBotId) delete BOTMAP[t.config.lineBotId]; t.config.lineBotId = j.userId; BOTMAP[j.userId] = t.slug; } } } catch (e) {}
  }
  await saveTenantConfig(t);
  res.json({ ok: true, lineBotDetected: !!t.config.lineBotId });
});
app.post("/api/change-pass", guard, async (req, res) => {
  const t = req.tenant; const cur = String(req.body.current || ""), next = String(req.body.next || "");
  if (sha(cur) !== t.config.passHash) return res.status(401).json({ ok: false, error: "wrong_current" });
  if (next.length < 8) return res.status(400).json({ ok: false, error: "too_short" });
  t.config.passHash = sha(next); await saveTenantConfig(t);
  res.set("Set-Cookie", "sess=" + Buffer.from(t.slug).toString("base64") + "." + sessToken(t.slug, t.config.passHash) + "; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000");
  res.json({ ok: true });
});

// ---------- inbox API (tenant-scoped) ----------
app.get("/api/conversations", guard, (req, res) => {
  const arr = Object.values(req.tenant.store).sort((a, b) => { if (a.flag && !b.flag) return -1; if (!a.flag && b.flag) return 1; if (a.flag && b.flag) return (a.order || 0) - (b.order || 0); return (b.ts || 0) - (a.ts || 0); });
  res.json(arr);
});
app.post("/api/send", guard, async (req, res) => {
  const t = req.tenant; const c = t.store[req.body.id]; if (!c) return res.status(404).json({ error: "no" });
  const text = (req.body.text || "").trim(); if (!text) return res.status(400).json({ error: "empty" });
  const r = await deliverText(t, c, text);
  if (r.sent) { c.msgs.push({ from: "us", text, time: nowt() }); c.draft = ""; c.status = "done"; c.flag = false; c.lastAuto = false; c.time = nowt(); c.ts = Date.now(); c.last = lastText(c); dbSaveConvo(t.slug, c); }
  res.json({ ok: true, sent: r.sent, sendErr: r.sendErr });
});
app.post("/api/done", guard, (req, res) => { const c = req.tenant.store[req.body.id]; if (!c) return res.status(404).json({ error: "no" }); c.status = "done"; c.flag = false; dbSaveConvo(req.tenant.slug, c); res.json({ ok: true }); });
app.post("/api/tag", guard, (req, res) => { const t = req.tenant; const c = t.store[req.body.id]; if (!c) return res.status(404).json({ error: "no" }); c.flag = !c.flag; if (c.flag) { c.order = Math.max(0, ...Object.values(t.store).filter(x => x.flag).map(x => x.order || 0)) + 1; c.status = "todo"; } dbSaveConvo(t.slug, c); res.json({ ok: true, flag: c.flag }); });
app.post("/api/ai-regen", guard, async (req, res) => {
  const t = req.tenant; const idea = (req.body.idea || "").trim(); if (!ANTHROPIC_KEY) return res.json({ ok: false, error: "no_ai_key" }); if (!idea) return res.json({ ok: false, error: "empty" });
  const c = t.store[req.body.id] || null; const channel = c ? c.channel : "line";
  const lastQ = c ? c.msgs.filter(m => m.from === "them").slice(-1).map(m => m.text || "").join("") : "";
  const rel = rulesSearch(t, (lastQ + " " + idea).slice(0, 1000), 15);
  const rulesTxt = rel.map(r => "・" + r.title + ": " + String(r.content || "").slice(0, 300)).join("\n").slice(0, 6000);
  const today = new Date().toLocaleDateString("ja-JP", { year: "numeric", month: "long", day: "numeric", weekday: "short" });
  const sig = channel === "mail" ? "メールなので本文の最後に「" + (t.name || "クリニック") + " サポート」と署名を付ける。" : "LINEなので署名は付けない。";
  const msgsArr = []; let cur = null;
  if (c) c.msgs.slice(-16).forEach(m => { const role = m.from === "them" ? "user" : "assistant"; const tx = (m.text || (m.media ? "［" + m.media + "を送信］" : "")).trim(); if (!tx) return; if (cur && cur.role === role) cur.content = (cur.content + "\n" + tx).slice(0, 3000); else { cur = { role, content: tx.slice(0, 3000) }; msgsArr.push(cur); } });
  while (msgsArr.length && msgsArr[0].role === "assistant") msgsArr.shift();
  msgsArr.push({ role: "user", content: "【スタッフからの内部指示（お客様には見えない）】会話全体を踏まえ、お客様の最新メッセージへの返信を書く。方向性メモ: " + idea + "。短いメモでも文脈に当てはめて具体的に答える。既に伝えた内容は繰り返さない。複数質問は全て答える。返信文のみ出力。" });
  const sys = "あなたは「" + (t.name || "クリニック") + "」の受付スタッフとして、お客様とこの会話をしてきた本人です。上質で温かく丁寧に対応する。本日は" + today + "。日付が関わる案内は本日と予約日の差から判断する。医療判断はしない。断定表現や絵文字は使わない。" + sig + (rulesTxt ? "\n【店舗ルール（従う）】\n" + rulesTxt : "") + (t.config.tone ? "\n【トーン指示（最優先）】" + String(t.config.tone).slice(0, 1000) : "") + "\n出力はそのままお客様に送信される。返信本文だけを1文字目から出力。【】見出し・状況説明・区切り線・前置きは禁止。";
  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01" }, body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 1000, system: sys, messages: msgsArr }) });
    if (!resp.ok) return res.json({ ok: false, error: "ai_" + resp.status });
    const data = await resp.json(); let text = (data.content && data.content[0] && data.content[0].text) || "";
    if (/\n-{3,}\n?/.test(text)) text = text.split(/\n-{3,}\n?/).pop();
    const lines = text.split("\n"); while (lines.length > 1 && (/^【.*】/.test(lines[0].trim()) || lines[0].trim() === "")) lines.shift(); text = lines.join("\n").trim();
    res.json({ ok: true, text });
  } catch (e) { res.json({ ok: false, error: String(e.message || e).slice(0, 80) }); }
});

// みぎうで君 (rulebook editing, tenant-scoped)
app.post("/api/assistant", guard, async (req, res) => {
  const t = req.tenant; if (!ANTHROPIC_KEY) return res.json({ ok: false, error: "no_ai_key" });
  const msgs = (Array.isArray(req.body.messages) ? req.body.messages : []).slice(-12).filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string").map(m => ({ role: m.role, content: m.content.slice(0, 4000) }));
  let lead = ""; while (msgs.length && msgs[0].role === "assistant") lead += msgs.shift().content + "\n";
  if (!msgs.length || msgs[msgs.length - 1].role !== "user") return res.json({ ok: false, error: "empty" });
  const ctx = req.body.context || null; let ctxTxt = "";
  if (ctx && typeof ctx === "object") ctxTxt = "\n\n【今回の学習対象】お客様: " + String(ctx.customer || "").slice(0, 1000) + "\nAI初回下書き: " + String(ctx.draft0 || "").slice(0, 1500) + "\n実際に送った返信: " + String(ctx.finalText || "").slice(0, 1500) + "\nこの差分から今後活かせるルール案をまず1つ提案。";
  const searchKey = msgs.map(m => m.content).join(" ") + (ctx ? " " + String(ctx.customer || "") + " " + String(ctx.finalText || "") : "");
  const rel = rulesSearch(t, searchKey.slice(0, 2000), 30); const totalRules = rulesList(t).length;
  const list = rel.map(r => "[" + r.id + "] " + r.title + ": " + String(r.content || "").slice(0, 400)).join("\n") || "（まだルールはありません）";
  const sys = "あなたは「みぎうで君」。返信ルールブック編集専用アシスタント。できるのはルールの追加・修正・削除のみ。(1)お客様対応・返信に関する話はどんなにラフでも汲み取りルール案に翻訳。完全に無関係な依頼だけ『ルールブックの編集のみお手伝いできます』と短く返す。(2)一括出力禁止、参照は最大3件。(3)同意・確定したターンのみactionsを入れる。『はい』『OK』も同意。(4)新内容が既存と矛盾する場合は追加でなく修正/統合を提案し、どう矛盾するか説明して確認。出力は必ずJSONのみ: {\"reply\":\"返答\",\"actions\":[]} actions: 追加={\"op\":\"add\",\"title\":\"見出し\",\"content\":\"本文\"} 修正={\"op\":\"update\",\"id\":番号,...} 削除={\"op\":\"delete\",\"id\":番号}" + (lead ? "\n冒頭の自分の発言: " + lead.slice(0, 500) : "") + "\n関連ルール（全" + totalRules + "件中）:\n" + list.slice(0, 14000) + ctxTxt;
  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01" }, body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 1500, system: sys, messages: msgs }) });
    if (!resp.ok) return res.json({ ok: false, error: "ai_" + resp.status });
    const data = await resp.json(); const raw = (data.content && data.content[0] && data.content[0].text) || "";
    let out = { reply: "", actions: [] }; try { const m = raw.match(/\{[\s\S]*\}/); out = JSON.parse(m ? m[0] : raw); } catch (e) { out = { reply: raw.slice(0, 1200), actions: [] }; }
    const applied = [];
    if (Array.isArray(out.actions)) for (const a of out.actions.slice(0, 5)) { if (!a || typeof a !== "object") continue; if (a.op === "add" && typeof a.content === "string" && a.content.trim()) { const r = await ruleAdd(t, String(a.title || "ルール").slice(0, 100), a.content.slice(0, 2000)); applied.push("追加 [" + r.id + "] " + r.title); } else if (a.op === "update" && t.rules[a.id]) { await ruleUpdate(t, a.id, a.title != null ? String(a.title).slice(0, 100) : null, a.content != null ? String(a.content).slice(0, 2000) : null); applied.push("修正 [" + a.id + "] " + t.rules[a.id].title); } else if (a.op === "delete" && t.rules[a.id]) { const tt = t.rules[a.id].title; await ruleDelete(t, a.id); applied.push("削除 [" + a.id + "] " + tt); } }
    res.json({ ok: true, reply: String(out.reply || "").slice(0, 1500), applied, ruleCount: rulesList(t).length });
  } catch (e) { res.json({ ok: false, error: String(e.message || e).slice(0, 80) }); }
});

// alerts / share / files / media / push (tenant-scoped)
app.get("/api/alerts", guard, (req, res) => res.json(req.tenant.alerts.filter(a => !a.done).slice(0, 100)));
app.post("/api/alert-done", guard, async (req, res) => { const t = req.tenant; const a = t.alerts.find(x => x.id === Number(req.body.id)); if (!a) return res.status(404).json({ error: "no" }); a.done = true; if (pool) await pool.query("UPDATE alerts SET done=true WHERE id=$1 AND tenant=$2", [a.id, t.slug]); res.json({ ok: true }); });
app.post("/api/share", guard, async (req, res) => { const t = req.tenant; const c = t.store[req.body.id]; if (!c) return res.status(404).json({ error: "no" }); const note = String(req.body.note || "").slice(0, 300); const lastThem = c.msgs.filter(m => m.from === "them").slice(-1).map(m => m.text || (m.media ? "[" + m.media + "]" : "")).join(""); await alertAdd(t, "共有", note || lastThem || "（内容なし）", c.name || ""); res.json({ ok: true }); });
app.get("/api/line-media/:id", guard, async (req, res) => { const t = req.tenant; const id = String(req.params.id || "").replace(/[^0-9A-Za-z_-]/g, ""); if (!id || !t.config.lineToken) return res.status(404).end(); try { const r = await fetch("https://api-data.line.me/v2/bot/message/" + id + "/content", { headers: { "Authorization": "Bearer " + t.config.lineToken } }); if (!r.ok) return res.status(r.status).end(); res.set("Content-Type", r.headers.get("content-type") || "application/octet-stream"); res.send(Buffer.from(await r.arrayBuffer())); } catch (e) { res.status(502).end(); } });
app.get("/api/push-key", guard, (req, res) => res.json({ key: VAPID ? VAPID.publicKey : null }));
app.post("/api/subscribe", guard, async (req, res) => { const t = req.tenant; const sub = req.body.sub; if (!sub || !sub.endpoint) return res.status(400).json({ error: "bad" }); t.push[sub.endpoint] = sub; if (pool) await pool.query("INSERT INTO push_subs (endpoint,tenant,sub) VALUES ($1,$2,$3) ON CONFLICT (endpoint) DO UPDATE SET sub=EXCLUDED.sub,tenant=EXCLUDED.tenant", [sub.endpoint, t.slug, sub]); res.json({ ok: true }); });

const ICON_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAMAAAADACAYAAABS3GwHAAAER0lEQVR4nO3cPW7baBSG0c+DwFNOky4b8UacHcyqsgNvxNnIdNNM6cpTEREUiaQkkt8l33PKBAEE8j66F/l7en5//WwQ6o/eHwB6EgDRBEA0ARBNAEQTANEEQDQBEE0ARBMA0QRANAEQTQBEEwDRBEA0ARBNAEQTANEEQDQBEE0ARBMA0QRANAEQTQBEEwDRBEA0ARBNAEQTANEEQDQBEE0ARBMA0QRANAEQTQBEEwDRBEA0ARBNAEQTANEEQDQBEE0ARBMA0QRANAEQTQBEEwDRBEA0ARBNAEQTANEEQLQvvT/ALT5e3np/BGb68+f33h9hlqfn99fP3h9iisHfr+ohlD+BDP++VX9/pQOo/vCYp/J7LHsCXXto/7b/Nv4k3Opr++vij1c8h0pugLFvjGsPlxrG3k/FTVD+d4HGvjX+efmx4SdhzLeff1/9uYqDPyi3Ac4f1tjDG3vobOeW4a8WQ7kALvl4ebv64ETQ17XnP/bOKil/Ap36eHm7eBINL8FJtJ29njzndrEBTjmJ+jvK8Le2sw0wGB6ybbCtIw3+YHcb4JRtsJ0jDn9rOw+gNRFs4ajD39pOT6BzTqJ1HHnwB7vfAKdsg+UkDH9rBwugNREsIWX4WzvICXTOSXSfpMEfHG4DnLIN5ksc/tYOugFOXfvT49Zsg9amvwiOPPytHXwDDKb+XkrqNpj61j/68LcWEsBABL+knjznDn8CnUs/idJPnnNRG2CQehI5eX4XGcAgKQInz2VxJ9C5o59ETp5x0RtgcNSTyMkzTQAnjhSBk2ee+BPo3N5PIifPbWyAC/Z6Ejl5bmcDjNjLNvCtfz8bYMLU8PTeBob/MQKYoepJ5OR5nBPoBlVOIt/6y7EBbtT7JDL8yxLAHXqdRE6e5TmBHrDVSeRbfz02wIPWPokM/7psgAWM/SP81u7bBgZ/GzbAgpbaBoZ/OwJY2KMRGP5tOYFWcM9JZPD7sAFWNHcbGP5+BLCyR08iw78uJ9AGpk6isV/DumyADc0dasO/HQFsbGq4Df+2nEAdXDqJDH4fNkBHw9Ab/n4E0Jnh70sARBMA0QRANAEQTQBEEwDRBEA0ARBNAEQTANEEQDQBEE0ARBMA0QRANAEQTQBEEwDRBEA0ARBNAEQTANEEQDQBEK1cALf8D8rsT7X3Wy4A2FLJAKp9S7CMiu+1ZACt1XxY3K/q+ywbQGt1Hxq3qfweSwfQWu2Hx7Tq7+/p+f31s/eHmMt/Jb4f1Qd/sKsAYGnlTyBYkwCIJgCiCYBoAiCaAIgmAKIJgGgCIJoAiCYAogmAaAIgmgCIJgCiCYBoAiCaAIgmAKIJgGgCIJoAiCYAogmAaAIgmgCIJgCiCYBoAiCaAIgmAKIJgGgCIJoAiCYAogmAaAIgmgCIJgCiCYBoAiCaAIgmAKIJgGgCIJoAiCYAogmAaAIgmgCIJgCiCYBoAiCaAIj2P//Cd56Rfb/VAAAAAElFTkSuQmCC", "base64");
app.get("/icon.png", (req, res) => { res.set("Content-Type", "image/png"); res.set("Cache-Control", "public, max-age=604800"); res.send(ICON_PNG); });
app.get("/manifest.json", (req, res) => res.json({ name: "クリニック受信トレイ", short_name: "受信トレイ", start_url: "/", display: "standalone", background_color: "#f3f4f6", theme_color: "#06c755", icons: [{ src: "/icon.png", sizes: "192x192", type: "image/png" }, { src: "/icon.png", sizes: "512x512", type: "image/png" }] }));
app.get("/sw.js", (req, res) => { res.set("Content-Type", "application/javascript"); res.set("Cache-Control", "no-store"); res.send('self.addEventListener("push",function(e){var d={};try{d=e.data?e.data.json():{};}catch(err){}e.waitUntil(self.registration.showNotification(d.title||"新着",{body:d.body||"",icon:"/icon.png",badge:"/icon.png"}));});self.addEventListener("notificationclick",function(e){e.notification.close();e.waitUntil(clients.matchAll({type:"window",includeUncontrolled:true}).then(function(ws){for(var i=0;i<ws.length;i++){if("focus" in ws[i])return ws[i].focus();}return clients.openWindow("/");}));});'); });
app.get("/api/rules-list", guard, (req, res) => res.json({ count: rulesList(req.tenant).length }));
app.get("/health", (req, res) => res.json({ ok: true, tenants: Object.keys(TEN).length, db: !!pool }));

// ---------- page routing ----------
app.get("/", (req, res) => { res.set("Content-Type", "text/html; charset=utf-8"); res.set("Cache-Control", "no-store"); const t = tenantFromReq(req); res.send(t ? INBOX_PAGE : LOGIN_PAGE); });
app.get("/signup", (req, res) => { res.set("Content-Type", "text/html; charset=utf-8"); res.send(SIGNUP_PAGE); });
app.get("/setup", (req, res) => { res.set("Content-Type", "text/html; charset=utf-8"); res.set("Cache-Control", "no-store"); res.send(tenantFromReq(req) ? SETUP_PAGE : LOGIN_PAGE); });

(async () => {
  try { if (pool) await dbInit(); } catch (e) { console.error("dbInit:", e.message); }
  try { await pushInit(); } catch (e) {}
  setInterval(() => { pollAll().catch(() => {}); }, 60000); setTimeout(() => { pollAll().catch(() => {}); }, 8000);
  app.listen(PORT, () => console.log("platform listening on " + PORT));
})();

// ============ PAGES ============
const HEAD = '<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>*{box-sizing:border-box}body{font-family:-apple-system,"Hiragino Kaku Gothic ProN","Noto Sans JP",sans-serif;margin:0;background:#f3f4f6;color:#111827}.card{background:#fff;border-radius:14px;padding:26px 22px;width:min(92vw,360px);box-shadow:0 2px 14px rgba(0,0,0,.08)}.wrap{display:flex;align-items:center;justify-content:center;min-height:100vh}h1{font-size:19px;margin:0 0 4px}.sub{font-size:13px;color:#6b7280;margin-bottom:18px}label{font-size:12px;color:#374151;display:block;margin:10px 0 3px}input,textarea{width:100%;padding:10px;border:1px solid #d1d5db;border-radius:8px;font-size:14px;font-family:inherit}button.primary{width:100%;padding:11px;border:none;border-radius:8px;background:#06c755;color:#fff;font-size:15px;font-weight:600;cursor:pointer;margin-top:14px}.err{color:#dc2626;font-size:12px;margin-top:8px;min-height:14px}.link{font-size:12px;color:#2563eb;text-align:center;display:block;margin-top:12px;cursor:pointer}</style>';

const SIGNUP_PAGE = '<!DOCTYPE html><html lang="ja"><head>' + HEAD + '<title>申し込み</title></head><body><div class="wrap"><div class="card"><h1>クリニック受信トレイ</h1><div class="sub">新規お申し込み</div><label>クリニック名</label><input id="name" placeholder="例：歯と美容のクリニック"><label>管理者メールアドレス（パスワード再設定用）</label><input id="email" type="email" placeholder="admin@example.com"><label>ログインパスワード（8文字以上）</label><input id="pass" type="password"><button class="primary" onclick="go()">アカウントを作成</button><div class="err" id="e"></div><a class="link" href="/">既にアカウントをお持ちの方はこちら</a></div></div><script>async function go(){const name=document.getElementById("name").value.trim();const email=document.getElementById("email").value.trim();const password=document.getElementById("pass").value;const e=document.getElementById("e");if(!name){e.textContent="クリニック名を入力してください";return;}if(password.length<8){e.textContent="パスワードは8文字以上";return;}const r=await fetch("/api/signup",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name,email,password})});const j=await r.json();if(j.ok){alert("アカウントを作成しました。\\nあなたの会社IDは「"+j.slug+"」です。ログイン時に使うので必ず控えてください。");location.href="/setup";}else{e.textContent=j.error==="too_short"?"パスワードは8文字以上":"作成に失敗しました";}}</script></body></html>';

const LOGIN_PAGE = '<!DOCTYPE html><html lang="ja"><head>' + HEAD + '<title>ログイン</title></head><body><div class="wrap"><div class="card"><h1>📥 受信トレイ</h1><div class="sub">ログイン</div><label>会社ID</label><input id="company" placeholder="発行された会社ID" autocapitalize="off"><label>パスワード</label><input id="pass" type="password" onkeydown="if(event.key===\'Enter\'&&!event.isComposing)go()"><button class="primary" onclick="go()">ログイン</button><div class="err" id="e"></div><a class="link" href="/signup">新規お申し込みはこちら</a></div></div><script>async function go(){const company=document.getElementById("company").value.trim();const password=document.getElementById("pass").value;const r=await fetch("/api/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({company,password})});if(r.ok){location.reload();}else{document.getElementById("e").textContent="会社IDかパスワードが違います";}}</script></body></html>';

const SETUP_PAGE = '<!DOCTYPE html><html lang="ja"><head>' + HEAD + '<title>初期設定</title><style>.card{width:min(94vw,560px)}.box{border:1px solid #e5e7eb;border-radius:10px;padding:14px;margin-top:14px}.box h3{margin:0 0 6px;font-size:14px}.note{font-size:11px;color:#6b7280;margin-top:2px}.ok{color:#16a34a;font-size:12px}.row{display:flex;gap:8px}.row>div{flex:1}</style></head><body><div class="wrap" style="padding:20px 0"><div class="card"><h1>初期設定</h1><div class="sub" id="hello"></div><div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:10px;font-size:12px;color:#1e40af">LINEのWebhook URL（LINE Developersに登録）:<br><b id="hook" style="word-break:break-all"></b></div><div class="box"><h3>① LINE連携</h3><div class="note">LINE Developers → チャネル基本設定の「チャネルシークレット」と、Messaging API設定の「チャネルアクセストークン」を貼り付け</div><label>チャネルシークレット</label><input id="lineSecret"><label>チャネルアクセストークン（長期）</label><textarea id="lineToken" rows="2"></textarea><div class="ok" id="lineOk"></div></div><div class="box"><h3>② メール連携（任意・Gmail以外もOK）</h3><div class="note">受信(IMAP)と送信(SMTP)の接続情報。Gmailはアプリパスワードを使用</div><div class="row"><div><label>IMAPホスト</label><input id="imapHost" placeholder="imap.gmail.com"></div><div><label>IMAPポート</label><input id="imapPort" placeholder="993"></div></div><label>メールアドレス（IMAPユーザー）</label><input id="imapUser" placeholder="info@yourclinic.com"><label>メールパスワード（IMAP）</label><input id="imapPass" type="password"><div class="row"><div><label>SMTPホスト</label><input id="smtpHost" placeholder="smtp.gmail.com"></div><div><label>SMTPポート</label><input id="smtpPort" placeholder="465"></div></div><label>送信ユーザー（SMTP）</label><input id="smtpUser" placeholder="info@yourclinic.com"><label>送信パスワード（SMTP）</label><input id="smtpPass" type="password"></div><div class="box"><h3>③ 回答のトーン（任意）</h3><textarea id="tone" rows="2" placeholder="例：柔らかめの丁寧語。文章は短めに。"></textarea></div><button class="primary" onclick="save()">保存して受信トレイへ</button><div class="err" id="e"></div></div></div><script>let CFG={};async function load(){const r=await fetch("/api/config");CFG=await r.json();document.getElementById("hello").textContent=CFG.name+"（会社ID: "+CFG.slug+"）";document.getElementById("hook").textContent=CFG.webhookUrl;document.getElementById("tone").value=CFG.tone||"";if(CFG.lineConfigured)document.getElementById("lineOk").textContent="✓ LINE連携済み";}load();async function save(){const g=id=>document.getElementById(id).value.trim();const body={lineSecret:g("lineSecret"),lineToken:g("lineToken"),imapHost:g("imapHost"),imapPort:g("imapPort"),imapUser:g("imapUser"),imapPass:g("imapPass"),smtpHost:g("smtpHost"),smtpPort:g("smtpPort"),smtpUser:g("smtpUser"),smtpPass:g("smtpPass"),tone:g("tone")};const r=await fetch("/api/config",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});const j=await r.json();if(j.ok){alert(j.lineBotDetected?"保存しました。LINE連携を確認できました。":"保存しました。");location.href="/";}else{document.getElementById("e").textContent="保存に失敗しました";}}</script></body></html>';

const INBOX_PAGE = '<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1"><title>受信トレイ</title><link rel="manifest" href="/manifest.json"><link rel="apple-touch-icon" href="/icon.png"><meta name="apple-mobile-web-app-capable" content="yes"><style>:root{--line:#e5e7eb;--muted:#6b7280}*{box-sizing:border-box}html,body{margin:0;height:100%;font-family:-apple-system,"Hiragino Kaku Gothic ProN","Noto Sans JP",sans-serif;color:#111827;background:#f3f4f6}#app{display:flex;height:100vh;overflow:hidden}#list{width:330px;flex-shrink:0;background:#fff;border-right:1px solid var(--line);display:flex;flex-direction:column}#hd{padding:12px 14px 6px;font-weight:600;display:flex;justify-content:space-between;align-items:center}#tools{display:flex;gap:6px;padding:4px 12px 10px;border-bottom:1px solid var(--line)}.tbtn{flex:1;font-size:11px;padding:7px 2px;border:1px solid var(--line);background:#fff;border-radius:9px;cursor:pointer;white-space:nowrap;color:#111827}.tbtn.migi{border-color:#ddd6fe;background:#f5f3ff;color:#6d28d9;font-weight:600}#search{margin:10px 12px;padding:8px 10px;border:1px solid var(--line);border-radius:8px;font-size:13px}#rooms{flex:1;overflow-y:auto}.room{display:flex;align-items:center;gap:10px;padding:11px 12px;border-bottom:1px solid var(--line);cursor:pointer}.room:hover{background:#f9fafb}.room.active{background:#eef2ff}.room.flag{background:#fef2f2}.av{width:40px;height:40px;border-radius:50%;flex-shrink:0;display:flex;align-items:center;justify-content:center;color:#fff;position:relative;background-size:cover;background-position:center}.ch{position:absolute;right:-2px;bottom:-2px;width:17px;height:17px;border-radius:50%;border:2px solid #fff;display:flex;align-items:center;justify-content:center;font-size:9px;color:#fff}.ch.line{background:#06c755}.ch.mail{background:#2563eb}.mid{flex:1;min-width:0}.rt{display:flex;justify-content:space-between}.rn{font-size:14px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.tm{font-size:11px;color:var(--muted)}.ls{font-size:12px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.stat{width:20px;text-align:center}.dot{width:9px;height:9px;border-radius:50%;background:#2563eb;display:inline-block}.flagicon{color:#dc2626}#chat{flex:1;display:flex;flex-direction:column;min-width:0;background:#eef0f3}#chead{display:flex;align-items:center;gap:10px;padding:10px 14px;background:#fff;border-bottom:1px solid var(--line)}#back{display:none;border:none;background:none;font-size:20px;cursor:pointer}#cname{font-weight:600;flex:1}.hbtn{font-size:12px;padding:6px 10px;border:1px solid var(--line);background:#fff;border-radius:8px;cursor:pointer}#msgs{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:10px}.b{max-width:74%;padding:9px 12px;border-radius:14px;font-size:13px;line-height:1.5;white-space:pre-wrap;word-break:break-word}.b.them{align-self:flex-start;background:#fff;border:1px solid var(--line)}.b.us{align-self:flex-end;background:#dcf7c5;color:#14532d}.b.media{padding:5px}.b img.ph,.b video.ph{max-width:200px;border-radius:10px;display:block}.bt{font-size:10px;color:var(--muted);margin:2px 4px}#composer{background:#fff;border-top:1px solid var(--line);padding:10px 12px}#aiL{font-size:11px;color:#2563eb;margin-bottom:5px}#drow{display:flex;gap:8px;align-items:flex-end}#attach{width:38px;height:38px;border:1px solid var(--line);border-radius:9px;background:#fff;cursor:pointer;font-size:18px}#draft{flex:1;min-height:110px;max-height:300px;border:1px solid #d1d5db;border-radius:10px;padding:9px 11px;font-size:13px;line-height:1.5;font-family:inherit;resize:vertical}#cbtns{display:flex;gap:8px;margin-top:8px;justify-content:flex-end;flex-wrap:wrap}.cbtn{font-size:13px;padding:7px 14px;border-radius:9px;border:1px solid var(--line);background:#fff;cursor:pointer}.cbtn.send{background:#06c755;border-color:#06c755;color:#fff;font-weight:600}.cbtn.ai{background:#eff6ff;border-color:#bfdbfe;color:#1d4ed8}.cbtn.done{background:#ecfdf5;border-color:#a7f3d0;color:#047857}.cbtn.learn{background:#f5f3ff;border-color:#ddd6fe;color:#6d28d9}#empty{flex:1;display:flex;align-items:center;justify-content:center;color:var(--muted)}.pop{position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:60;display:none;align-items:center;justify-content:center}.pc{background:#fff;border-radius:14px;padding:18px;width:min(92vw,420px)}#aMsgs{height:min(60vh,420px);overflow-y:auto;background:#f8fafc;border-radius:10px;padding:12px;display:flex;flex-direction:column;gap:8px}.am{max-width:85%;padding:8px 11px;border-radius:12px;font-size:13px;white-space:pre-wrap}.am.user{align-self:flex-end;background:#dbeafe}.am.ai{align-self:flex-start;background:#fff;border:1px solid var(--line)}.am.sysn{align-self:center;background:#ecfdf5;color:#047857;font-size:12px}#menu{position:fixed;z-index:70;background:#fff;border:1px solid var(--line);border-radius:10px;padding:5px;display:none;box-shadow:0 6px 24px rgba(0,0,0,.12)}#menu div{padding:9px 14px;font-size:13px;cursor:pointer;border-radius:7px}#menu div:hover{background:#f3f4f6}textarea.pt{width:100%;min-height:70px;border:1px solid #d1d5db;border-radius:10px;padding:9px;font-size:13px;font-family:inherit}@media(max-width:760px){#list{width:100%}#chat{display:none;position:absolute;inset:0}#app.open #list{display:none}#app.open #chat{display:flex}#back{display:block}#draft{min-height:44px}#draft:focus{min-height:140px}}</style></head><body><div id="app"><div id="list"><div id="hd"><span>📥 受信トレイ</span><span style="font-size:10px;color:#6b7280" id="cnt"></span></div><div id="tools"><button class="tbtn migi" onclick="openAsst(null)">🤝 みぎうで君</button><button class="tbtn" onclick="window.open(\'/setup\',\'_blank\')">⚙ 設定</button><button class="tbtn" onclick="enablePush()" id="bell">🔔</button><button class="tbtn" onclick="logout()">↩</button></div><input id="search" placeholder="検索" oninput="renderList()"><div id="rooms"></div></div><div id="chat"><div id="empty">左の一覧から会話を選んでください</div></div></div><div id="menu"></div><div class="pop" id="pop"><div class="pc"><h3>AIで作り直す</h3><div style="font-size:12px;color:#6b7280;margin-bottom:6px">返したい内容をざっくり入力</div><textarea id="pi" class="pt" placeholder="例：指示書を再送する"></textarea><div style="display:flex;gap:8px;margin-top:12px;justify-content:flex-end"><button class="cbtn" onclick="closePop()">やめる</button><button class="cbtn ai" onclick="genPop()">✨ 生成して下書きに入れる</button></div></div></div><div class="pop" id="asst"><div class="pc"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px"><b>🤝 みぎうで君</b><button class="cbtn" onclick="closeAsst()">閉じる</button></div><div id="aMsgs"></div><div style="display:flex;gap:8px;margin-top:10px"><textarea id="at" class="pt" style="min-height:44px" placeholder="今後の回答をどう変えたいか…" onkeydown="if(event.key===\'Enter\'&&!event.shiftKey&&!event.isComposing&&event.keyCode!==229){event.preventDefault();asstSend();}"></textarea><button class="cbtn send" onclick="asstSend()">送信</button></div></div></div><script>let DATA=[],current=null;const rooms=document.getElementById("rooms"),chat=document.getElementById("chat"),appE=document.getElementById("app");function api(p,b){return fetch(p,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(b)});}async function load(){try{const r=await fetch("/api/conversations");DATA=await r.json();}catch(e){}renderList();if(current){const c=DATA.find(x=>x.id===current);if(c)syncMsgs(c);}}function filt(){const q=(document.getElementById("search").value||"").trim();return q?DATA.filter(r=>(r.name||"").includes(q)||(r.last||"").includes(q)):DATA;}function chIcon(ch){return ch==="line"?\'<span class="ch line">L</span>\':\'<span class="ch mail">✉</span>\';}function statIcon(r){if(r.flag)return \'<i class="flagicon">⚑</i>\';if(r.status==="done")return r.lastAuto?\'<span title="自動返信済み">🤖</span>\':"";return \'<span class="dot"></span>\';}function esc(s){return (s||"").replace(/[<>&]/g,c=>({"<":"&lt;",">":"&gt;","&":"&amp;"}[c]));}function av(r,sz){const s=sz||40;const bg=r.pic?("background-image:url("+r.pic+");"):("background:"+(r.color||"#888")+";");return \'<div class="av" style="width:\'+s+\'px;height:\'+s+\'px;font-size:\'+(s/3)+\'px;\'+bg+\'">\'+(r.pic?"":(r.name||"?").charAt(0))+chIcon(r.channel)+\'</div>\';}function renderList(){document.getElementById("cnt").textContent="未対応 "+DATA.filter(r=>r.status!=="done").length+"件";rooms.innerHTML="";filt().forEach(r=>{const d=document.createElement("div");d.className="room"+(current===r.id?" active":"")+(r.flag?" flag":"");d.innerHTML=av(r)+\'<div class="mid"><div class="rt"><span class="rn">\'+esc(r.name)+\'</span><span class="tm">\'+(r.time||"")+\'</span></div><div class="ls">\'+esc(r.last||"")+\'</div></div><div class="stat">\'+statIcon(r)+\'</div>\';d.onclick=()=>openChat(r.id);d.oncontextmenu=e=>{e.preventDefault();showMenu(e,r);};let tm;d.addEventListener("touchstart",e=>{tm=setTimeout(()=>showMenu(e.touches[0],r),550);},{passive:true});d.addEventListener("touchend",()=>clearTimeout(tm));rooms.appendChild(d);});}function mediaHtml(m){var cls="b "+(m.from==="them"?"them":"us");var src=m.mediaId?("/api/line-media/"+m.mediaId):(m.url||"https://placehold.co/300x220/e5e7eb/6b7280?text=%F0%9F%93%B7");if(m.media==="image")return \'<div class="\'+cls+\' media"><a href="\'+src+\'" target="_blank"><img class="ph" src="\'+src+\'"></a></div>\';if(m.media==="video")return \'<div class="\'+cls+\' media"><video class="ph" controls preload="metadata" src="\'+src+\'"></video></div>\';if(m.media==="file")return \'<div class="\'+cls+\'"><a href="\'+src+\'" target="_blank">📄 \'+esc(m.fileName||"ファイル")+\'</a></div>\';if(m.media==="audio")return \'<div class="\'+cls+\'"><a href="\'+src+\'" target="_blank">🎤 音声</a></div>\';return "";}function bubbles(r){return r.msgs.map(m=>{const body=m.media?mediaHtml(m):(\'<div class="b \'+(m.from==="them"?"them":"us")+\'">\'+esc(m.text)+\'</div>\');const tl=(m.time||"")+(m.auto?\' <span style="color:#7c3aed">🤖 自動返信</span>\':"");return body+\'<div class="bt" style="align-self:\'+(m.from==="them"?"flex-start":"flex-end")+\'">\'+tl+\'</div>\';}).join("");}function syncMsgs(c){const m=document.getElementById("msgs");if(!m)return;if(m.getAttribute("data-count")!==String(c.msgs.length)){m.innerHTML=bubbles(c);m.setAttribute("data-count",String(c.msgs.length));m.scrollTop=m.scrollHeight;}}function openChat(id,keep){current=id;const r=DATA.find(x=>x.id===id);if(!r)return;appE.classList.add("open");chat.innerHTML=\'<div id="chead"><button id="back" onclick="closeChat()">‹</button>\'+av(r,30)+\'<span id="cname">\'+esc(r.name)+\'　<span style="font-size:11px;color:#6b7280">\'+(r.channel==="line"?"LINE":"メール")+\'</span></span><button class="hbtn" onclick="shareClinic()">🏥 共有</button></div><div id="msgs">\'+bubbles(r)+\'</div><div id="composer"><div id="aiL">✨ AI下書き（編集して送れます）</div><div id="drow"><button id="attach" onclick="attach()">📎</button><textarea id="draft">\'+esc(r.draft||"")+\'</textarea></div><div id="cbtns"><button class="cbtn ai" onclick="openPop()">✨ AIで作り直す</button><button class="cbtn done" onclick="markDone()">対応済み</button><button class="cbtn learn" onclick="sendLearn()">送信して学習</button><button class="cbtn send" onclick="sendMsg()">送信</button></div></div>\';const m=document.getElementById("msgs");if(m){m.setAttribute("data-count",String(r.msgs.length));m.scrollTop=m.scrollHeight;}if(!keep)renderList();}function closeChat(){appE.classList.remove("open");current=null;renderList();}async function markDone(){await api("/api/done",{id:current});await load();}async function sendMsg(){const id=current;const t=document.getElementById("draft").value.trim();if(!t)return;const r=await api("/api/send",{id,text:t});let j={};try{j=await r.json();}catch(e){}if(j.sent){const d=document.getElementById("draft");if(d)d.value="";const cd=DATA.find(x=>x.id===id);if(cd)cd.draft="";await load();}else{alert("送信失敗: "+(j.sendErr||"不明")+"（下書きは消えていません）");}}function attach(){const inp=document.createElement("input");inp.type="file";inp.onchange=async()=>{alert("ファイル送信は次フェーズで有効化します");};inp.click();}async function shareClinic(){const note=prompt("現場に伝える内容（空欄なら直近メッセージを共有）","");if(note===null)return;await api("/api/share",{id:current,note:note||""});alert("現場ボードに共有しました");}const menu=document.getElementById("menu");function showMenu(e,r){menu.innerHTML="";const a=document.createElement("div");a.textContent=r.flag?"⚑ 要対応を外す":"⚑ 要対応をつける";a.onclick=async()=>{menu.style.display="none";await api("/api/tag",{id:r.id});await load();};menu.appendChild(a);menu.style.left=Math.min(e.clientX,innerWidth-200)+"px";menu.style.top=Math.min(e.clientY,innerHeight-100)+"px";menu.style.display="block";}document.addEventListener("click",()=>menu.style.display="none");const pop=document.getElementById("pop");function openPop(){document.getElementById("pi").value="";pop.style.display="flex";}function closePop(){pop.style.display="none";}async function genPop(){const idea=document.getElementById("pi").value.trim();if(!idea){closePop();return;}closePop();const d=document.getElementById("draft");const old=d.value;d.value="生成中…";d.disabled=true;try{const r=await api("/api/ai-regen",{idea,id:current});const j=await r.json();d.value=j.ok?j.text:old;if(!j.ok)alert("生成失敗: "+(j.error||""));}catch(e){d.value=old;}d.disabled=false;}let aHist=[],aCtx=null;const asst=document.getElementById("asst"),aMsgs=document.getElementById("aMsgs");function amAdd(role,text){const d=document.createElement("div");d.className="am "+role;d.textContent=text;aMsgs.appendChild(d);aMsgs.scrollTop=aMsgs.scrollHeight;return d;}function openAsst(ctx){aHist=[];aCtx=ctx||null;aMsgs.innerHTML="";asst.style.display="flex";const g=ctx?"送信した返信を確認しました。この対応を今後のルールにしますか？どんなルールにしたいか教えてください。":"ルールブックの編集をお手伝いします。今後の回答をどう変えたいか教えてください。";amAdd("ai",g);aHist.push({role:"assistant",content:g});}function closeAsst(){asst.style.display="none";aCtx=null;aHist=[];}async function asstSend(){const t=document.getElementById("at");const txt=t.value.trim();if(!txt)return;t.value="";amAdd("user",txt);aHist.push({role:"user",content:txt});const ph=amAdd("ai","考え中…");try{const r=await api("/api/assistant",{messages:aHist,context:aCtx});const j=await r.json();ph.remove();if(j.ok){amAdd("ai",j.reply||"");aHist.push({role:"assistant",content:j.reply||""});(j.applied||[]).forEach(a=>amAdd("sysn","✅ "+a));}else amAdd("sysn","エラー: "+(j.error||""));}catch(e){ph.remove();amAdd("sysn","通信エラー");}}async function sendLearn(){const c=DATA.find(x=>x.id===current);if(!c)return;const t=document.getElementById("draft").value.trim();if(!t)return;const lastThem=c.msgs.filter(m=>m.from==="them").slice(-3).map(m=>m.text||(m.media?"["+m.media+"]":"")).join(" / ");const ctx={customer:lastThem,draft0:c.draft0||c.draft||"",finalText:t};await sendMsg();openAsst(ctx);}async function logout(){await api("/api/logout",{});location.reload();}if("serviceWorker"in navigator)navigator.serviceWorker.register("/sw.js").catch(()=>{});function ub64(s){const p="=".repeat((4-s.length%4)%4);const b=(s+p).replace(/-/g,"+").replace(/_/g,"/");const r=atob(b);const a=new Uint8Array(r.length);for(let i=0;i<r.length;i++)a[i]=r.charCodeAt(i);return a;}async function enablePush(){try{if(!("serviceWorker"in navigator)||!("PushManager"in window)){alert("この端末は通知非対応");return;}const ios=/iP(hone|ad|od)/.test(navigator.userAgent);if(ios&&!matchMedia("(display-mode: standalone)").matches){alert("iPhoneは「ホーム画面に追加」してから開いて🔔を押してください");return;}const reg=await navigator.serviceWorker.register("/sw.js");if(await Notification.requestPermission()!=="granted"){alert("通知が許可されませんでした");return;}const kr=await fetch("/api/push-key");const kj=await kr.json();if(!kj.key){alert("通知設定未完了");return;}const sub=await reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:ub64(kj.key)});await api("/api/subscribe",{sub:JSON.parse(JSON.stringify(sub))});document.getElementById("bell").textContent="🔔ON";alert("通知をオンにしました");}catch(e){alert("通知設定に失敗: "+e.message);}}load();setInterval(load,6000);</script></body></html>';
