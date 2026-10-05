"use strict";
// Opt-in local-only UI smoke fixture. Starts the real app in memory with synthetic
// records and real AI, but no database, mail/LINE, partner API or auto sending.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const crypto = require("node:crypto");
if (!process.env.OPENAI_KEY) throw new Error("OpenAI not configured");
const allowed = new Set(["PATH", "HOME", "OPENAI_KEY", "TMPDIR", "SYSTEMROOT"]);
for (const key of Object.keys(process.env)) if (!allowed.has(key)) delete process.env[key];
process.env.NODE_ENV = "test";
process.env.PORT = "4318";
process.env.CRED_KEY = crypto.randomBytes(32).toString("base64");
process.env.AI_USAGE_SPOOL_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "draft-consultation-test-")), "usage.jsonl");
const originalFetch = global.fetch;
global.fetch = (url, options) => {
  const parsed = new URL(String(url));
  if (parsed.origin !== "https://api.openai.com") throw new Error("test_outbound_blocked");
  return originalFetch(url, options);
};
const filename = require.resolve("../migiude.js");
const source = fs.readFileSync(filename, "utf8").replace("app.listen(PORT,", 'app.listen(PORT, "127.0.0.1",');
const fixture = `
const testTenant = TEN["consultation-test"] = newTenant("consultation-test", "テスト相談クリニック", {
  loginId: "consultation-test", passHash: hashPassword("local-test-only"), conn: {},
  settings: { engine: "gpt", autoReply: false, bookingActions: false, staffLineEnabled: false, tone: "丁寧で自然な敬語。不要な追加質問をしない" }
});
testTenant.rules[1] = { id: 1, title: "テスト：キャンセル料", content: "当日キャンセル料は3,300円。感染症の免除には予約当日の受診日・氏名・医療機関名が分かる証明書を12時間以内に提出する。" };
testTenant.rules[2] = { id: 2, title: "テスト：医院所在地", content: "銀座本院：東京都中央区銀座1-5-1 Holon Ginza2 703号室。THE DENTE：東京都中央区銀座2-2-19 藤間ビル9階。" };
const testNow = Date.now();
testTenant.store["test-fee"] = { id: "test-fee", name: "テスト患者：相談", channel: "email", userId: "test@example.invalid", ts: testNow, unread: true, status: "draft", draft: "当日キャンセル料3,300円をお支払いください。", msgs: [
  { from: "us", text: "テスト：キャンセル料3,300円をご案内しました。", at: testNow - 1000, sentAt: testNow - 1000 },
  { from: "them", text: "テスト：予約確定の連絡を待っていたのですが、キャンセル料を支払う必要がありますか？", at: testNow, sentAt: testNow }
] };
console.log("Synthetic UI only: http://127.0.0.1:4318/");
`;
const mod = new Module(filename, module);
mod.filename = filename;
mod.paths = Module._nodeModulePaths(path.dirname(filename));
mod._compile(source + fixture, filename);
