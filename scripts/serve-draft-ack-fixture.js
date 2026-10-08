"use strict";
// Opt-in synthetic UI fixture for an isolated staging service. No database,
// delivery credentials, booking transport or real patient records are loaded.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const crypto = require("node:crypto");
if (process.env.DRAFT_ACK_FIXTURE !== "isolated-staging") throw new Error("fixture_not_enabled");
if (!process.env.OPENAI_KEY) throw new Error("fixture_ai_missing");
if (String(process.env.DRAFT_ACK_TEST_PASSWORD || "").length < 32) throw new Error("fixture_password_missing");
const allowed = new Set(["PATH", "HOME", "OPENAI_KEY", "TMPDIR", "SYSTEMROOT", "PORT", "PUBLIC_BASE_URL", "DRAFT_ACK_TEST_PASSWORD"]);
for (const key of Object.keys(process.env)) if (!allowed.has(key)) delete process.env[key];
process.env.NODE_ENV = "test";
process.env.PORT = process.env.PORT || "8080";
process.env.CRED_KEY = crypto.randomBytes(32).toString("base64");
process.env.AI_USAGE_SPOOL_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "draft-ack-test-")), "usage.jsonl");
const originalFetch = global.fetch;
global.fetch = (url, options) => {
  if (new URL(String(url)).origin !== "https://api.openai.com") throw new Error("fixture_outbound_blocked");
  return originalFetch(url, options);
};
const filename = require.resolve("../migiude.js");
const source = fs.readFileSync(filename, "utf8");
const fixture = `
const ackTenant = TEN["draft-ack-test"] = newTenant("draft-ack-test", "テストお礼クリニック", {
  loginId: "draft-ack-test", passHash: hashPassword(process.env.DRAFT_ACK_TEST_PASSWORD), conn: {},
  settings: { engine: "gpt", autoReply: false, bookingActions: false, staffLineEnabled: false, tone: "受付として丁寧で自然な敬語。不要な説明は追加しない" }
});
delete process.env.DRAFT_ACK_TEST_PASSWORD;
ackTenant.rules[1] = { id: 1, title: "テスト：キャンセル規定", content: "当日キャンセル料は3,300円。感染症の免除には予約当日の受診日・氏名・医療機関名が分かる証明書を12時間以内に提出する。書類はスタッフが確認する。" };
const ackNow = Date.now();
for (const [id, name, draft, text] of [
  ["test-empty", "テスト患者：下書きなし", "", "テスト：ご連絡を確認しました。ありがとうございます。"],
  ["test-replace", "テスト患者：お礼へ作り直し", "当日キャンセル料3,300円をお支払いください。感染症の免除には12時間以内に証明書を提出してください。", "テスト：証明書を送ります。免除できますか？"],
  ["test-append", "テスト患者：お礼を追加", "当日キャンセル料は3,300円です。", "テスト：当日キャンセルの料金を教えてください。"]
]) ackTenant.store[id] = { id, name, channel: "email", userId: "test@example.invalid", ts: ackNow, unread: true, status: "draft", draft, msgs: [{ from: "them", text, at: ackNow, sentAt: ackNow }] };
console.log("Isolated synthetic draft fixture ready; external delivery and booking are unconfigured.");
`;
const mod = new Module(filename, module);
mod.filename = filename;
mod.paths = Module._nodeModulePaths(path.dirname(filename));
mod._compile(source + fixture, filename);
