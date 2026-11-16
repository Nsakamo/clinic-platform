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
  assert.deepEqual(M.parseRange("bytes=1000-", 1000), { unsatisfiable: true }, "ファイルの外は416");
  assert.equal(M.parseRange("bytes=5-1", 1000), null, "無効な指定は無視して全体を返す");
  assert.equal(M.parseRange("bytes=0-1,5-9", 1000), null, "複数範囲は無視して全体を返す");
  assert.equal(M.parseRange("items=0-1", 1000), null);
  assert.equal(M.parseRange("bytes=-", 1000), null);
  // 終わりの無い指定（動画の preload が送る bytes=0-）は区切って返す
  assert.deepEqual(M.parseRange("bytes=0-", 10 * 1024 * 1024), { start: 0, end: M.RANGE_OPEN_END_MAX_BYTES - 1 });
  assert.match(M.skippedLabel({ name: "テスト.jpg", reason: "storage_full" }), /保存容量の上限に達したため/);
});

test("IMAPの受信で添付を取り出し、添付つきメールは自動送信しない", () => {
  assert.match(source, /const mailFiles = tooLarge \? \{ keep: \[\], skipped: \[\{ name: "このメールの添付", reason: "mail_too_large" \}\] \} : selectMailAttachments\(parsed\.attachments\);/);
  assert.match(source, /attachments: mailFiles\.keep, skippedAttachments: mailFiles\.skipped,/);
  assert.match(source, /!med && !attachmentUnreviewed && grounded;/);
  assert.match(source, /!med && !attachmentUnreviewed && groundedForStaffLine;/);
  // 添付は本文より先に並べ、AIへ渡す最新の患者の文が本文になるようにする
  const core = source.slice(source.indexOf("async function handleInboundCore("), source.indexOf("statBump(t, \"in\");", source.indexOf("async function handleInboundCore(")));
  assert.ok(core.indexOf("pushInboundMailAttachments(") < core.indexOf('c.msgs.push({ from: "them", text: opts.text'));
  // 公開URLの files とは別の表に保存し、ログイン必須の経路だけで配信する
  assert.match(source, /CREATE TABLE IF NOT EXISTS inbound_files/);
  assert.match(source, /app\.get\("\/api\/inbound-file\/:id", guard,/);
  assert.match(source, /SELECT name,mime,size FROM inbound_files WHERE id=\$1 AND tenant=\$2/);
  assert.match(source, /SELECT substring\(data from \$3 for \$4\) AS part FROM inbound_files WHERE id=\$1 AND tenant=\$2/);
  // 予約自動受付（はい/いいえの確定・AIの操作依頼・うまくいかなかったときの即時送信）にも添付つきメールは入れない
  assert.match(source, /if \(!med && !attachmentUnreviewed && typeof opts\.draft !== "string" && baEnabled\(t\) && PARTNER_KEY\)/);
  assert.match(source, /if \(g && !attachmentUnreviewed && !g\.replyRequiresStaff && !staffLineReviewAll\(t\) && baEnabled\(t\)/);
  assert.match(source, /attachmentUnreviewed \? "メールに添付ファイルがあり、AIでは中身を確認できないため確認が必要です"/);
  // 圧縮なしで保存し、法人ごとの容量上限を確かめてから保存する
  assert.match(source, /ALTER TABLE inbound_files ALTER COLUMN data SET STORAGE EXTERNAL/);
  assert.match(source, /SELECT COALESCE\(SUM\(size\),0\)::bigint AS used FROM inbound_files WHERE tenant=\$1/);
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
    env: Object.assign({}, process.env, { NODE_ENV: "test", PORT: String(PORT), DATABASE_URL: "", CRED_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", PUBLIC_BASE_URL: BASE, PLATFORM_SECRET: PARTNER_KEY, ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "", RAILWAY_ENVIRONMENT: "", RAILWAY_PROJECT_ID: "", INBOUND_FILES_TENANT_MAX_BYTES: "60000" }),
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
    // 法人の容量上限（テストでは60KB）を超えた添付は保存せず、理由つきで表示する。本文の無いメールで空の吹き出しは作らない
    assert.deepEqual(onlyConv.msgs.map(m => [m.media || "text", !!m.url]), [["file", false]]);
    assert.match(onlyConv.msgs[0].fileName, /😀写真\.jpg（保存容量の上限に達したため右腕くんでは表示できません/);
    const alerts = await call("/api/alerts", { headers: { Cookie: cookieA } });
    assert.ok(JSON.stringify(alerts.body).includes("メール添付の保存容量の上限に達した"), "容量上限の通知が出る");
    const openEnded = await fetch(BASE + msgs[1].url, { headers: { Cookie: cookieA, Range: "bytes=0-" } });
    assert.equal(openEnded.status, 206);
    const multi = await fetch(BASE + msgs[1].url, { headers: { Cookie: cookieA, Range: "bytes=0-1,5-9" } });
    assert.equal(multi.status, 200, "複数範囲は無視して全体");
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
  const ctx = { INBOUND_FILES: {}, Buffer, process, pool: { query: async (sql, params) => { queries.push({ sql, params }); return { rows: [/substring/.test(sql) ? { part: Buffer.from("テスト") } : { name: "a.mp4", mime: "video/mp4", size: "5000" }] }; } } };
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
  const headIdx = route.indexOf('if (req.method === "HEAD") { sendHead(); return res.end(); }');
  assert.ok(headIdx > 0 && headIdx < route.indexOf("inboundFileBytes("), "HEADでは本体を読まない");
  assert.match(route, /Math\.min\(INBOUND_FILE_CHUNK_BYTES, remaining\)/, "本体は1MBずつ読む");
  assert.match(source, /SELECT \$1,\$2,\$3,\$4,\$5,\$6,\$7,\$8 WHERE EXISTS \(SELECT 1 FROM tenants WHERE slug=\$2\)/, "法人が存在するときだけ保存");
  assert.match(source, /const autoBooking = !!\(g && !attachmentUnreviewed && /, "未確認の添付があれば予約は提案カードへ");
  assert.match(source, /loading="lazy" decoding="async" onerror="mediaImgFallback\(this\)"/);
});

test("連続するメールの添付はスタッフLINE向けの要約で1行にまとめる", () => {
  const vm = require("node:vm");
  const fn = source.slice(source.indexOf("function collapseMailAttachmentMessages("), source.indexOf("async function staffLineSummary("));
  const ctx = {}; vm.createContext(ctx); vm.runInContext(fn, ctx);
  const msgs = [{ from: "us", text: "テスト前の返信" }].concat(Array.from({ length: 10 }, (_, i) => ({ from: "them", media: "image", mailAttachment: true, fileName: "p" + i + ".jpg" }))).concat([{ from: "them", text: "テスト本文" }]);
  const text = ctx.staffLineHistoryText({ msgs });
  assert.equal(text, "スタッフ: テスト前の返信\n患者: ［添付ファイル 10件（中身は確認できません）］\n患者: テスト本文");
});

test("画面: 添付のファイル名はエスケープし、保存できなかった添付はリンクなしで表示する", () => {
  const vm = require("node:vm");
  const start = source.indexOf("const PAGE = `");
  const end = source.indexOf("</html>`;", start);
  const ctx0 = {}; vm.runInNewContext("PAGE=" + source.slice(start + "const PAGE = ".length, end + "</html>`".length), ctx0);
  const script = [...ctx0.PAGE.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]).join("\n");
  const pick = (a, b) => script.slice(script.indexOf(a), script.indexOf(b, script.indexOf(a)));
  const ctx = { location: { origin: "https://example.test" }, URL };
  vm.createContext(ctx);
  vm.runInContext(pick("function esc(", "\n") + "\n" + pick("function safeMediaUrl(", "\n") + "\n" + pick("function mediaHtml(", "\n"), ctx);
  const evil = '"><img src=x onerror=alert(1)>`';
  for (const media of ["image", "video", "file", "audio"]) {
    const html = ctx.mediaHtml({ from: "them", media, url: "/api/inbound-file/0123456789abcdef0123456789abcdef", fileName: evil, mailAttachment: true });
    assert.doesNotMatch(html, /<img src=x/, media);
  }
  const failed = ctx.mediaHtml({ from: "them", media: "file", fileName: "テスト.jpg（保存できませんでした）", mailAttachment: true });
  assert.match(failed, /📎 テスト\.jpg（保存できませんでした）/);
  assert.doesNotMatch(failed, /<a /, "保存できなかった添付はリンクにしない");
});

test("スタッフLINE: 添付つきメールには、どの経路からでも送信ボタン付きのカードを出さず、LINEからの送信も断る", async () => {
  const vm = require("node:vm");
  const cut = (a, b) => source.slice(source.indexOf(a), source.indexOf(b, source.indexOf(a)));
  const escalateSrc = cut("const staffLineInFlight", "// ---------- auth");
  const helperSrc = cut("function hasUnreviewedMailAttachment(", "async function staffLineRequestApproval(");
  // 承認カードの入口の判定までを実物で動かし、その先（カード作成）に進んだら数える
  const approvalSrc = source.slice(source.indexOf("async function staffLineRequestApproval("), source.indexOf("\n", source.indexOf("予約操作は右腕くん画面の提案カードで実行してから送る")))
    + "\n  approvalCount(); return true;\n}\n";
  let approvals = 0; const pushed = [];
  const ctx = {
    S: () => ({ staffLineEnabled: true }), staffLineReady: () => true, sha: x => x, publicConversationUrl: () => "", staffLineText: x => x,
    staffLinePush: async (_t, _g, messages) => { pushed.push(messages); return { ok: true }; }, dbSave: () => {}, approvalCount: () => { approvals++; },
  };
  vm.createContext(ctx);
  vm.runInContext(escalateSrc + "\n" + helperSrc + "\n" + approvalSrc, ctx);
  const t = { slug: "テスト", name: "テスト医院", config: { conn: { staffLineGroupId: "テストG" } } };
  const withAttachment = () => ({ id: "mail:テスト", name: "テスト", draft: "テストの返信案", msgs: [
    { from: "us", text: "テスト前回" }, { from: "them", media: "image", mailAttachment: true, url: "/api/inbound-file/x" }, { from: "them", text: "テスト本文", time: "1" } ] });
  // 直接の承認依頼（毎回確認モード・例外確認・AIの要対応判定など、どの経路からでもここを通る）
  await ctx.staffLineRequestApproval(t, withAttachment(), "毎回確認モードのため、送信前に承認が必要です");
  await ctx.staffLineEscalate(t, withAttachment(), "AIが人による判断を必要と判定しました");
  assert.equal(approvals, 0, "送信ボタン付きのカードは出ない");
  assert.ok(pushed.length >= 1);
  assert.ok(pushed.every(m => /右腕くんでスタッフ対応が必要です/.test(String(m[0])) && /添付ファイルがあります|右腕くん/.test(String(m[0]))));
  // スタッフが返信した後の新しいメール（添付なし）なら、通常どおり承認カードを出せる
  const answered = { id: "mail:テスト2", name: "テスト", draft: "テストの返信案", msgs: [ { from: "them", media: "image", mailAttachment: true }, { from: "us", text: "テスト返信" }, { from: "them", text: "テスト追加の質問", time: "2" } ] };
  await ctx.staffLineRequestApproval(t, answered, "テスト");
  assert.equal(approvals, 1);
  // 以前に出たカードの送信ボタンが押されても、添付が未確認なら送らない（送信ロックより前に断る）
  const handler = cut('const action = q.get("migiude"), found = staffLineApprovalById(t, q.get("id"));', "sendLocks.add(lockKey)");
  assert.ok(handler.indexOf('action === "send" && hasUnreviewedMailAttachment(found.c)') > 0);
  assert.ok(handler.indexOf("hasUnreviewedMailAttachment(found.c)") < handler.indexOf("const lockKey"));
});

test("容量の集計に失敗したときは上限扱いにせず「一時的に保存できなかった」と表示し、上限の通知を出さない", () => {
  assert.match(M.skippedLabel({ name: "テスト.jpg", reason: "save_failed" }), /一時的に保存できなかったため/);
  const push = source.slice(source.indexOf("async function pushInboundMailAttachments("), source.indexOf('app.get("/api/inbound-file/:id"'));
  assert.match(push, /if \(usageFailed\) \{ skipped\.push\(\{[^}]*reason: "save_failed" \}\); continue; \}/);
  assert.match(push, /if \(!usageFailed && allowed\.length < keep\.length\)/);
  assert.match(source, /if \(TEN\[t\.slug\] !== t \|\| t\._deleting\) throw new Error\("tenant_gone"\);/);
  assert.match(source, /if \(storage\.rows\[0\] && storage\.rows\[0\]\.attstorage !== "e"\) await pool\.query\("ALTER TABLE inbound_files ALTER COLUMN data SET STORAGE EXTERNAL"\)/);
});

test("添付つきメールの後に本文だけのメールが来ても、スタッフが確認するまで自動送信・予約自動受付をしない（実動作）", async () => {
  const vm = require("node:vm");
  const decision = require("../lib/reply-decision.js");
  const { preserveTopicBoundary } = require("../lib/conversation-context.js");
  const cut = (a, b) => source.slice(source.indexOf(a), source.indexOf(b, source.indexOf(a)));
  const start = source.indexOf("async function handleInboundCore("), end = source.indexOf("// ===== 複数アカウント対応", start);
  const helperSrc = cut("function hasUnreviewedMailAttachment(", "async function staffLineRequestApproval(");
  for (const prior of [true, false]) {
    let delivered = 0, scheduled = 0, baCalls = 0;
    const context = {
      ...decision, preserveTopicBoundary, pushInboundMailAttachments: async () => 0, cancelAutoReply: () => {}, colorFor: () => "", nowt: () => "テスト", statBump: () => {}, lastText: () => "テスト", dbSave: () => {},
      baEnabled: () => true, staffLineReviewAll: () => false, staffBookingSuggestEnabled: () => false, PARTNER_KEY: "テスト",
      baHandlePending: async () => { baCalls++; return false; }, enrichStaffLineBookingPreview: async (_t, _c, g) => g,
      genDraft: async () => ({ draft: "テスト：ご連絡ありがとうございます。", confidence: "high", needs_human: false, replyRequiresStaff: false,
        grounding: { autoSendAllowed: true, reasons: [] }, validation: { pass: true }, action: { type: "cancel", appointmentId: "a1" }, baCtx: { ok: true, verified: true } }),
      startLearningUsageTrace: async () => {}, baAction: async () => { baCalls++; return true; }, S: () => ({ autoReply: true, level: "high", autoDelayMin: 0, staffLineEnabled: false }),
      deliverText: async () => { delivered++; return { sent: true }; }, notifyAll: () => {}, staffLineEscalate: async () => false, staffLineRequestApproval: async () => false,
      staffLineReady: () => false, scheduleAutoReply: () => { scheduled++; }, aiUsageContext: { getStore: () => ({ entries: [] }) }, forwardToPartner: async () => {},
      baDeliverOrEscalate: async () => { delivered++; return true; }, inboundMessageTimes: () => ({}),
    };
    vm.runInNewContext(helperSrc + "\n" + source.slice(start, end), context);
    const t = { slug: "テスト", store: {}, config: { conn: {} } };
    if (prior) t.store["mail:テスト"] = { id: "mail:テスト", userId: "テスト", channel: "mail", status: "todo", msgs: [{ from: "them", text: "テスト写真です" }, { from: "them", media: "image", mailAttachment: true, url: "/api/inbound-file/x" }], draft: "" };
    await context.handleInboundCore(t, { channel: "mail", uid: "テスト", text: "テスト：届いていますか？明日はキャンセルでお願いします" });
    if (prior) {
      assert.equal(delivered + scheduled, 0, "未確認の添付がある会話は自動送信しない");
      assert.equal(baCalls, 0, "予約自動受付もしない");
    } else {
      assert.ok(delivered + scheduled + baCalls > 0, "添付の無い会話は従来どおり自動処理に進む（テストが空振りしていない確認）");
    }
  }
  // 待ち時間つき送信も、送る直前に未確認の添付を確かめる
  assert.match(cut("function scheduleAutoReply(", "cur.lastAuto = true;"), /if \(hasUnreviewedMailAttachment\(cur\)\) return;/);
  // 画面からの再送も、未確認の添付があれば専用のエラーで断る
  assert.match(source, /if \(hasUnreviewedMailAttachment\(c\)\) return res\.status\(409\)\.json\(\{ ok: false, error: "mail_attachment_unreviewed" \}\);/);
});

test("実HTTP: 1MBを超える添付も分割して読み出し、全体・境界をまたぐ範囲とも元のファイルと一致する", { timeout: 20000 }, async () => {
  const port = 43843, base = "http://127.0.0.1:" + port;
  const child = spawn(process.execPath, ["migiude.js"], {
    cwd: root,
    env: Object.assign({}, process.env, { NODE_ENV: "test", PORT: String(port), DATABASE_URL: "", CRED_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", PUBLIC_BASE_URL: base, PLATFORM_SECRET: PARTNER_KEY, ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "", RAILWAY_ENVIRONMENT: "", RAILWAY_PROJECT_ID: "" }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = ""; child.stdout.on("data", d => { output += d; }); child.stderr.on("data", d => { output += d; });
  try {
    for (let i = 0; i < 80 && !output.includes("listening on"); i++) await new Promise(r => setTimeout(r, 100));
    const created = await fetch(base + "/api/partner/tenants", { method: "POST", headers: { "Content-Type": "application/json", "x-partner-key": PARTNER_KEY }, body: JSON.stringify({ slug: "mail-big", name: "mail-big", accountEmail: "mail-big@example.test", password: "password-Test-123" }) });
    assert.equal(created.status, 201);
    const lr = await fetch(base + "/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ loginId: "mail-big", password: "password-Test-123" }) });
    const cookie = String(lr.headers.get("set-cookie") || "").split(";")[0];
    const big = require("node:crypto").randomBytes(2.5 * 1024 * 1024);
    const r = await fetch(base + "/__test/mail-inbound", { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie, Origin: base }, body: JSON.stringify({ email: "big@example.test", text: "テスト大きい写真", attachments: [{ filename: "big.jpg", contentType: "image/jpeg", base64: big.toString("base64") }] }) });
    assert.equal(r.status, 200);
    const convs = await (await fetch(base + "/api/conversations", { headers: { Cookie: cookie } })).json();
    const url = convs.find(c => c.id === "mail:big@example.test").msgs[0].url;
    const full = await fetch(base + url, { headers: { Cookie: cookie } });
    assert.equal(full.status, 200);
    assert.equal(full.headers.get("content-length"), String(big.length));
    assert.ok(Buffer.from(await full.arrayBuffer()).equals(big), "全体が一致");
    const from = 1024 * 1024 - 10, to = 2 * 1024 * 1024 + 9;
    const part = await fetch(base + url, { headers: { Cookie: cookie, Range: "bytes=" + from + "-" + to } });
    assert.equal(part.status, 206);
    assert.ok(Buffer.from(await part.arrayBuffer()).equals(big.subarray(from, to + 1)), "チャンクの境界をまたぐ範囲も一致");
  } finally { child.kill(); }
});

test("P3: 送信予約・自動送信の返信は添付を確認済みにせず、スタッフの返信だけが確認済みにする", () => {
  const vm = require("node:vm");
  const fn = source.slice(source.indexOf("function hasUnreviewedMailAttachment("), source.indexOf("\n}\n", source.indexOf("function hasUnreviewedMailAttachment(")) + 3);
  const ctx = {}; vm.createContext(ctx); vm.runInContext(fn, ctx);
  const att = { from: "them", media: "image", mailAttachment: true };
  assert.equal(ctx.hasUnreviewedMailAttachment({ msgs: [att, { from: "us", text: "テスト予約送信", scheduled: true }] }), true);
  assert.equal(ctx.hasUnreviewedMailAttachment({ msgs: [att, { from: "us", text: "テスト自動", auto: true }] }), true);
  assert.equal(ctx.hasUnreviewedMailAttachment({ msgs: [att, { from: "us", text: "テストスタッフ返信" }] }), false);
  assert.equal(ctx.hasUnreviewedMailAttachment({ msgs: [{ from: "them", text: "テスト本文" }] }), false);
});

test("P3: 自動下書き・相談・作り直しのAIへ『添付の中身は見えない』と伝え、連続する添付は1件にまとめる", () => {
  const { ATTACHMENT_UNSEEN_POLICY } = require("../lib/mail-attachments");
  assert.match(ATTACHMENT_UNSEEN_POLICY, /AIには中身が見えない/);
  assert.match(ATTACHMENT_UNSEEN_POLICY, /スタッフが確認/);
  assert.equal((source.match(/\+ "(?:\\n){1,2}" \+ ATTACHMENT_UNSEEN_POLICY/g) || []).length, 3);
  const gen = source.slice(source.indexOf("async function genDraft("), source.indexOf("async function enrichStaffLineBookingPreview("));
  assert.match(gen, /ATTACHMENT_UNSEEN_POLICY/);
  assert.match(gen, /const contextMsgs = collapseMailAttachmentMessages\(activeMsgs\)\.slice\(-16\)/);
  const vm = require("node:vm");
  const fn = source.slice(source.indexOf("function collapseMailAttachmentMessages("), source.indexOf("function staffLineHistoryText("));
  const ctx = {}; vm.createContext(ctx); vm.runInContext(fn, ctx);
  const list = [{ from: "them", mailAttachment: true }, { from: "them", mailAttachment: true }, { from: "them", text: "テスト本文" }, { from: "them", mailAttachment: true }];
  const out = ctx.collapseMailAttachmentMessages(list);
  assert.equal(out.length, 3);
  assert.equal(out[0].text, "［添付ファイル 2件（中身は確認できません）］");
  assert.equal(out[2].text, "［添付ファイル 1件（中身は確認できません）］");
  assert.equal(list[0].text, undefined, "元の会話は書き換えない");
});

test("P3: 未確認の添付があるときはスタッフLINEからの修正でも送信カードを作り直さない", () => {
  const fn = source.slice(source.indexOf("async function staffLineApplyRevision("), source.indexOf("\n}\n", source.indexOf("async function staffLineApplyRevision(")));
  assert.match(fn, /if \(hasUnreviewedMailAttachment\(c\)\) return false;/);
});

test("P3: 添付の配信は接続が切れたら書き込みを止め、待ち受けの登録を毎回外す", async () => {
  const vm = require("node:vm");
  const { EventEmitter } = require("node:events");
  const fn = source.slice(source.indexOf("function waitForDrainOrClose("), source.indexOf("\n}\n", source.indexOf("function waitForDrainOrClose(")) + 3);
  const ctx = {}; vm.createContext(ctx); vm.runInContext(fn, ctx);
  const res = new EventEmitter();
  for (let i = 0; i < 20; i++) { const p = ctx.waitForDrainOrClose(res); res.emit("drain"); await p; }
  assert.equal(res.listenerCount("drain") + res.listenerCount("close") + res.listenerCount("error"), 0);
  const p = ctx.waitForDrainOrClose(res); res.emit("close"); await p;
  await ctx.waitForDrainOrClose(Object.assign(new EventEmitter(), { destroyed: true }));
  const route = source.slice(source.indexOf('app.get("/api/inbound-file/:id", guard,'), source.indexOf("\n});\n", source.indexOf('app.get("/api/inbound-file/:id", guard,')));
  assert.match(route, /if \(res\.destroyed \|\| res\.writableEnded\) return;/);
});

test("P3: IMAPは大きさを先に見て1通ずつ取得し、処理に失敗したメールは既読にせずやり直す", () => {
  const poll = source.slice(source.indexOf("async function pollAll("), source.indexOf("emailPolling = false;\n}", source.indexOf("async function pollAll(")));
  assert.ok(poll.includes("2 * 86400000) }, { uid: true, size: true })"), "先にUIDと大きさだけを取得する");
  assert.doesNotMatch(poll, /\{ source: true \}\)\)/, "全件の本文をまとめて取得しない");
  assert.match(poll, /client\.fetchOne\(String\(it\.uid\), \{ source: tooLarge \? \{ start: 0, maxLength: MAIL_RAW_HEAD_BYTES \} : true \}, \{ uid: true \}\)/);
  const okIdx = poll.indexOf("await handleInbound(t,");
  assert.ok(okIdx > 0 && poll.indexOf("markUids.push(it.uid);", okIdx) > okIdx, "処理が終わってから既読にする");
  assert.match(poll, /if \(mid\) seenIds\.delete\(mid\);/);
  assert.match(poll, /if \(n >= 3\) \{ markUids\.push\(it\.uid\);/);
  const { skippedLabel } = require("../lib/mail-attachments");
  assert.match(String(skippedLabel({ name: "テスト", reason: "mail_too_large" })), /大きすぎる/);
});

test("P3: 法人削除では法人の行を消した後にも受信添付を消し直し、メモリ上の添付も消す", () => {
  const del = source.slice(source.indexOf("t._deleting = true"), source.indexOf("t._deleting = true") + 3000);
  const a = del.indexOf("DELETE FROM tenants"), b = del.indexOf("DELETE FROM inbound_files WHERE tenant=$1", a);
  assert.ok(a > 0 && b > a);
});
