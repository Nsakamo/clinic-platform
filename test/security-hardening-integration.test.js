"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.join(__dirname, "..");
const source = fs.readFileSync(path.join(root, "migiude.js"), "utf8");

test("未使用の旧サーバーと既定共有鍵を残さない", () => {
  assert.equal(fs.existsSync(path.join(root, "server.js")), false);
  assert.doesNotMatch(source, /INGEST_KEY\s*\|\|\s*["']clinic-secret["']/);
});

test("管理環境はCRED_KEYなしで待受を開始しない", () => {
  const result = spawnSync(process.execPath, ["migiude.js"], {
    cwd: root,
    encoding: "utf8",
    timeout: 5000,
    env: Object.assign({}, process.env, {
      NODE_ENV: "production",
      CRED_KEY: "",
      DATABASE_URL: "",
      PORT: "0",
    }),
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /本番環境では有効なCRED_KEYが必須/);
  assert.doesNotMatch(result.stdout, /listening on/);
});

test("暗号化不能時に資格情報を平文へフォールバックしない", () => {
  const encStart = source.indexOf("function encField");
  const encEnd = source.indexOf("function decField", encStart);
  const encSource = source.slice(encStart, encEnd);
  assert.match(encSource, /credential_encryption_not_configured/);
  assert.match(encSource, /credential_encryption_failed/);
  assert.doesNotMatch(encSource, /return s;\s*\/\/ 鍵なし/);
  assert.match(source, /function connHasSecrets/);
});

test("セッションCookieは発行時と削除時の両方でSecure", () => {
  assert.match(source, /sess=.*HttpOnly; Secure; SameSite=Lax; Max-Age=2592000/);
  assert.match(source, /sess=; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=0/);
});

test("公開添付URLを共有キャッシュへ保存させない", () => {
  const start = source.indexOf('app.get("/files/:id"');
  const end = source.indexOf('app.post("/api/send-file"', start);
  const route = source.slice(start, end);
  assert.match(route, /Cache-Control", "private, no-store, max-age=0"/);
  assert.match(route, /X-Content-Type-Options", "nosniff"/);
  assert.doesNotMatch(route, /public, max-age/);
});

test("受付くん転送は完了まで待ち、失敗を患者受信処理へ波及させない", () => {
  assert.match(source, /await forwardToPartner\(t, c,/);
  assert.match(source, /const result = await deliverPartnerEvent/);
  assert.match(source, /return result\.ok/);
});
