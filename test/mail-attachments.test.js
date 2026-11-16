"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const M = require("../lib/mail-attachments");

const root = path.join(__dirname, "..");
const source = fs.readFileSync(path.join(root, "migiude.js"), "utf8");

test("メール添付の取り込み: 署名ロゴは外し、写真・動画・PDFは形式を判定して残す", () => {
  const jpeg = Buffer.alloc(40 * 1024, 1);
  const r = M.selectMailAttachments([
    { filename: "logo.png", contentType: "image/png", related: true, content: Buffer.alloc(2000, 1) },
    { filename: "IMG_0001.JPG", contentType: "application/octet-stream", content: jpeg },
    { filename: "貼り付けた写真.png", contentType: "image/png", related: true, content: Buffer.alloc(60 * 1024, 1) },
    { filename: "clip.mov", contentType: "video/quicktime", content: Buffer.alloc(1000, 1) },
    { filename: "レントゲン.pdf", contentType: "application/pdf", content: Buffer.alloc(1000, 1) },
    { filename: "page.html", contentType: "text/html", content: Buffer.alloc(100, 1) },
    { filename: "empty.txt", contentType: "text/plain", content: Buffer.alloc(0) },
    { filename: "bounce", contentType: "message/delivery-status", content: Buffer.alloc(100, 1) },
  ]);
  assert.deepEqual(r.keep.map(f => [f.name, f.mime, f.kind]), [
    ["IMG_0001.JPG", "image/jpeg", "image"],
    ["貼り付けた写真.png", "image/png", "image"],
    ["clip.mov", "video/quicktime", "video"],
    ["レントゲン.pdf", "application/pdf", "file"],
    ["page.html", "text/html", "file"],
  ]);
  assert.equal(r.skipped.length, 0);
});

test("メール添付の取り込み: 大きすぎる・多すぎる添付は取り込まず、理由つきで残す", () => {
  const big = { filename: "big.mp4", contentType: "video/mp4", content: Buffer.alloc(M.MAIL_ATTACHMENT_MAX_BYTES + 1) };
  const many = Array.from({ length: M.MAIL_ATTACHMENTS_MAX_COUNT + 2 }, (_, i) => ({ filename: "p" + i + ".jpg", contentType: "image/jpeg", content: Buffer.alloc(10, 1) }));
  const r = M.selectMailAttachments([big, ...many]);
  assert.equal(r.keep.length, M.MAIL_ATTACHMENTS_MAX_COUNT);
  assert.deepEqual(r.skipped.map(s => s.reason), ["too_large", "too_many", "too_many"]);
  assert.match(M.skippedLabel(r.skipped[0]), /big\.mp4（サイズが大きいため右腕くんでは表示できません。メールソフトで確認してください）/);
  const total = M.selectMailAttachments(Array.from({ length: 3 }, (_, i) => ({ filename: "v" + i + ".mp4", contentType: "video/mp4", content: Buffer.alloc(20 * 1024 * 1024) })));
  assert.equal(total.keep.length, 2);
  assert.equal(total.skipped[0].reason, "total_too_large");
});

test("ファイル名の制御文字・パス区切りは取り除き、絵文字を途中で切らない", () => {
  const emoji = "😀".repeat(130);
  const cut = M.cleanFileName(emoji);
  assert.equal(Array.from(cut).length, 120);
  assert.doesNotThrow(() => encodeURIComponent(cut));
  assert.doesNotThrow(() => M.inboundFileHeaders({ mime: "image/jpeg", name: "a".repeat(119) + "😀😀" }));
  assert.equal(M.cleanFileName("../\u0000evil\\name\n.jpg"), ".. evil name .jpg");
  assert.equal(M.cleanFileName(""), "添付ファイル");
});

test("配信ヘッダー: スクリプトを実行できる形式は必ずダウンロード扱いにし、どの形式も sandbox で開く", () => {
  const html = M.inboundFileHeaders({ mime: "text/html", name: "a.html" });
  assert.equal(html["Content-Type"], "application/octet-stream");
  assert.match(html["Content-Disposition"], /^attachment;/);
  assert.match(html["Content-Security-Policy"], /sandbox/);
  const svg = M.inboundFileHeaders({ mime: "image/svg+xml", name: "a.svg" });
  assert.equal(svg["Content-Type"], "application/octet-stream");
  assert.match(svg["Content-Disposition"], /^attachment;/);
  const jpg = M.inboundFileHeaders({ mime: "image/jpeg", name: "写真.jpg" });
  assert.equal(jpg["Content-Type"], "image/jpeg");
  assert.match(jpg["Content-Disposition"], /^inline; filename\*=UTF-8''%E5%86%99%E7%9C%9F\.jpg$/);
  assert.equal(jpg["X-Content-Type-Options"], "nosniff");
  assert.match(jpg["Cache-Control"], /private, no-store/);
  const pdf = M.inboundFileHeaders({ mime: "application/pdf", name: "a.pdf" });
  assert.equal(pdf["Content-Type"], "application/pdf");
  assert.equal(pdf["Content-Security-Policy"], undefined, "PDFビューアのためPDFだけsandboxを外す");
});

test("動画の分割取得（Range）を正しく解釈し、不正な範囲は断る", () => {
  assert.deepEqual(M.parseRange("bytes=0-99", 1000), { start: 0, end: 99 });
  assert.deepEqual(M.parseRange("bytes=900-", 1000), { start: 900, end: 999 });
  assert.deepEqual(M.parseRange("bytes=-100", 1000), { start: 900, end: 999 });
  assert.deepEqual(M.parseRange("bytes=0-5000", 1000), { start: 0, end: 999 });
  assert.equal(M.parseRange("bytes=1000-", 1000), null);
  assert.equal(M.parseRange("bytes=5-1", 1000), null);
  assert.equal(M.parseRange("items=0-1", 1000), null);
  assert.equal(M.parseRange("bytes=-", 1000), null);
});

test("IMAPの受信で添付を取り出し、添付つきメールは自動送信しない", () => {
  assert.match(source, /const mailFiles = selectMailAttachments\(parsed\.attachments\);/);
  assert.match(source, /attachments: mailFiles\.keep, skippedAttachments: mailFiles\.skipped,/);
  assert.match(source, /!med && !mailAttachmentCount && grounded;/);
  assert.match(source, /!med && !mailAttachmentCount && groundedForStaffLine;/);
  // 添付は本文より先に並べ、AIへ渡す最新の患者の文が本文になるようにする
  const core = source.slice(source.indexOf("async function handleInboundCore("), source.indexOf("statBump(t, \"in\");", source.indexOf("async function handleInboundCore(")));
  assert.ok(core.indexOf("pushInboundMailAttachments(") < core.indexOf('c.msgs.push({ from: "them", text: opts.text'));
  // 公開URLの files とは別の表に保存し、ログイン必須の経路だけで配信する
  assert.match(source, /CREATE TABLE IF NOT EXISTS inbound_files/);
  assert.match(source, /app\.get\("\/api\/inbound-file\/:id", guard,/);
  assert.match(source, /SELECT name,mime,size FROM inbound_files WHERE id=\$1 AND tenant=\$2/);
  assert.match(source, /SELECT substring\(data from \$3 for \$4\) AS part FROM inbound_files WHERE id=\$1 AND tenant=\$2/);
  // 予約自動受付（はい/いいえの確定・AIの操作依頼・うまくいかなかったときの即時送信）にも添付つきメールは入れない
  assert.match(source, /if \(!med && !mailAttachmentCount && typeof opts\.draft !== "string" && baEnabled\(t\) && PARTNER_KEY\)/);
  assert.match(source, /if \(g && !mailAttachmentCount && !g\.replyRequiresStaff && !staffLineReviewAll\(t\) && baEnabled\(t\)/);
  assert.match(source, /mailAttachmentCount \? "メールに添付ファイルがあり、AIでは中身を確認できないため確認が必要です"/);
  // 法人の削除（解約）で添付も消す
  assert.match(source, /DELETE FROM inbound_files WHERE tenant=\$1/);
  // テスト用の受信経路は本番・staging の実行環境では登録しない
  assert.match(source, /if \(process\.env\.NODE_ENV === "test" && !isManagedRuntime\(\)\) \{\n  app\.post\("\/__test\/mail-inbound"/);
});

const PORT = 43841;
const BASE = "http://127.0.0.1:" + PORT;
const PARTNER_KEY = "mail-attachment-partner-key";

test("実HTTP: 添付つきメールを受信すると会話に表示でき、ログインと同じ法人の確認・Range・自動送信なしが効く", { timeout: 20000 }, async () => {
  const child = spawn(process.execPath, ["migiude.js"], {
    cwd: root,
    env: Object.assign({}, process.env, { NODE_ENV: "test", PORT: String(PORT), DATABASE_URL: "", CRED_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", PUBLIC_BASE_URL: BASE, PLATFORM_SECRET: PARTNER_KEY, ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "", RAILWAY_ENVIRONMENT: "", RAILWAY_PROJECT_ID: "" }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", d => { output += d; });
  child.stderr.on("data", d => { output += d; });
  try {
    for (let i = 0; i < 80 && !output.includes("listening on"); i++) await new Promise(r => setTimeout(r, 100));
    assert.match(output, /listening on/);
    const call = async (p, opts) => { const r = await fetch(BASE + p, opts); let body = null; try { body = await r.clone().json(); } catch (e) {} return { r, body }; };
    for (const slug of ["mail-a", "mail-b"]) {
      const created = await call("/api/partner/tenants", { method: "POST", headers: { "Content-Type": "application/json", "x-partner-key": PARTNER_KEY }, body: JSON.stringify({ slug, name: slug, accountEmail: slug + "@example.test", password: "password-Test-123" }) });
      assert.equal(created.r.status, 201);
    }
    const login = async slug => {
      const r = await fetch(BASE + "/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ loginId: slug, password: "password-Test-123" }) });
      assert.equal(r.status, 200);
      return String(r.headers.get("set-cookie") || "").split(";")[0];
    };
    const cookieA = await login("mail-a");
    const cookieB = await login("mail-b");
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(40000, 7)]);
    const inbound = await call("/__test/mail-inbound", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookieA, Origin: BASE },
      body: JSON.stringify({ email: "patient@example.test", name: "テスト患者", subject: "テスト 写真です", text: "テストです。写真と動画を送ります。", attachments: [
        { filename: "logo.png", contentType: "image/png", related: true, base64: Buffer.alloc(100, 1).toString("base64") },
        { filename: "IMG_0001.JPG", contentType: "image/jpeg", base64: jpeg.toString("base64") },
        { filename: "clip.mp4", contentType: "video/mp4", base64: Buffer.alloc(5000, 3).toString("base64") },
        { filename: "page.html", contentType: "text/html", base64: Buffer.from("<script>alert(1)</script>").toString("base64") },
      ] }),
    });
    assert.equal(inbound.r.status, 200);
    assert.equal(inbound.body.kept, 3);

    const convs = await call("/api/conversations", { headers: { Cookie: cookieA } });
    const conv = convs.body.find(c => c.id === "mail:patient@example.test");
    assert.ok(conv, "受信した会話がある");
    const msgs = conv.msgs;
    assert.deepEqual(msgs.map(m => [m.media || "text", m.fileName || m.text]), [
      ["image", "IMG_0001.JPG"], ["video", "clip.mp4"], ["file", "page.html"], ["text", "テストです。写真と動画を送ります。"],
    ]);
    assert.equal(conv.last, "テストです。写真と動画を送ります。");
    assert.notEqual(conv.status, "done", "添付つきは自動で対応済みにならない");
    const img = msgs[0];
    assert.match(img.url, /^\/api\/inbound-file\/[0-9a-f]{32}$/);

    const noLogin = await fetch(BASE + img.url);
    assert.equal(noLogin.status, 401);
    const otherTenant = await fetch(BASE + img.url, { headers: { Cookie: cookieB } });
    assert.equal(otherTenant.status, 404);
    const ok = await fetch(BASE + img.url, { headers: { Cookie: cookieA } });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get("content-type"), "image/jpeg");
    assert.equal(ok.headers.get("x-content-type-options"), "nosniff");
    assert.equal(Buffer.from(await ok.arrayBuffer()).equals(jpeg), true);
    const part = await fetch(BASE + msgs[1].url, { headers: { Cookie: cookieA, Range: "bytes=0-99" } });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get("content-range"), "bytes 0-99/5000");
    assert.equal((await part.arrayBuffer()).byteLength, 100);
    const badRange = await fetch(BASE + msgs[1].url, { headers: { Cookie: cookieA, Range: "bytes=9000-" } });
    assert.equal(badRange.status, 416);
    const html = await fetch(BASE + msgs[2].url, { headers: { Cookie: cookieA } });
    assert.equal(html.headers.get("content-type"), "application/octet-stream");
    assert.match(html.headers.get("content-disposition"), /^attachment;/);
    assert.match(html.headers.get("content-security-policy"), /sandbox/);
    const head = await fetch(BASE + msgs[1].url, { method: "HEAD", headers: { Cookie: cookieA } });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("content-length"), "5000");
    const only = await call("/__test/mail-inbound", { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookieA, Origin: BASE }, body: JSON.stringify({ email: "only@example.test", text: "", subject: "", attachments: [{ filename: "😀写真.jpg", contentType: "image/jpeg", base64: jpeg.toString("base64") }] }) });
    assert.equal(only.r.status, 200);
    const convs2 = await call("/api/conversations", { headers: { Cookie: cookieA } });
    const onlyConv = convs2.body.find(c => c.id === "mail:only@example.test");
    assert.deepEqual(onlyConv.msgs.map(m => m.media || "text"), ["image"], "本文の無いメールで空の吹き出しを作らない");
    assert.equal(onlyConv.last, "［画像］写真");
    const bogus = await fetch(BASE + "/api/inbound-file/not-a-real-id", { headers: { Cookie: cookieA } });
    assert.equal(bogus.status, 404);
    assert.doesNotMatch(output, /IMG_0001|patient@example\.test/, "ファイル名・メールアドレスをログに出さない");
  } finally {
    child.kill();
  }
});

test("DBからは必要な範囲だけ読む（動画のRangeで本体を毎回まるごと読まない）", async () => {
  const vm = require("node:vm");
  const start = source.indexOf("// 形式・サイズだけを読む");
  const end = source.indexOf("async function pushInboundMailAttachments(");
  const queries = [];
  const ctx = { INBOUND_FILES: {}, Buffer, pool: { query: async (sql, params) => { queries.push({ sql, params }); return { rows: [/substring/.test(sql) ? { part: Buffer.from("テスト") } : { name: "a.mp4", mime: "video/mp4", size: "5000" }] }; } } };
  vm.createContext(ctx);
  vm.runInContext(source.slice(start, end), ctx);
  const t = { slug: "テスト" };
  const id = "0123456789abcdef0123456789abcdef";
  const meta = await ctx.inboundFileMeta(t, id);
  assert.equal(meta.size, 5000);
  assert.doesNotMatch(queries[0].sql, /\bdata\b/, "形式・サイズの取得では本体を読まない");
  await ctx.inboundFileBytes(t, id, 100, 50);
  assert.match(queries[1].sql, /substring\(data from \$3 for \$4\)/);
  assert.equal(JSON.stringify(queries[1].params), JSON.stringify([id, "テスト", 101, 50]), "PostgreSQLのsubstringは1始まり");
  assert.equal(await ctx.inboundFileMeta(t, "../etc"), null);
  const route = source.slice(source.indexOf('app.get("/api/inbound-file/:id"'), source.indexOf("async function handleInbound(t, opts)"));
  assert.ok(route.indexOf('if (req.method === "HEAD") return res.end();') < route.indexOf("inboundFileBytes("), "HEADでは本体を読まない");
});

test("連続するメールの添付はスタッフLINE向けの要約で1行にまとめる", () => {
  const vm = require("node:vm");
  const fn = source.slice(source.indexOf("function staffLineHistoryText("), source.indexOf("async function staffLineSummary("));
  const ctx = {}; vm.createContext(ctx); vm.runInContext(fn, ctx);
  const msgs = [{ from: "us", text: "テスト前の返信" }].concat(Array.from({ length: 10 }, (_, i) => ({ from: "them", media: "image", mailAttachment: true, fileName: "p" + i + ".jpg" }))).concat([{ from: "them", text: "テスト本文" }]);
  const text = ctx.staffLineHistoryText({ msgs });
  assert.equal(text, "スタッフ: テスト前の返信\n患者: ［添付ファイル 10件］\n患者: テスト本文");
});
