"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawn } = require("node:child_process");

const root = path.join(__dirname, "..");
const PORT = 43831;
const BASE = `http://127.0.0.1:${PORT}`;
const PUBLIC_BASE = "https://rightarm.example.test";
const PARTNER_KEY = "integration-partner-key";

function waitForListening(child) {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error("server_start_timeout: " + output)), 5000);
    const onData = chunk => {
      output += String(chunk);
      if (output.includes("listening on")) { clearTimeout(timer); resolve(); }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("exit", code => { clearTimeout(timer); reject(new Error("server_exited_early: " + code + " " + output)); });
  });
}

async function json(pathname, options) {
  const response = await fetch(BASE + pathname, options);
  let body = {}; try { body = await response.json(); } catch (e) {}
  return { response, body };
}

test("文体の学習の取得・更新・削除はログイン中の法人のデータだけを扱う", { timeout: 15000 }, async () => {
  const child = spawn(process.execPath, ["migiude.js"], {
    cwd: root,
    env: Object.assign({}, process.env, {
      NODE_ENV: "test", PORT: String(PORT), DATABASE_URL: "",
      CRED_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      PUBLIC_BASE_URL: PUBLIC_BASE, PLATFORM_SECRET: PARTNER_KEY,
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await waitForListening(child);
    const created = await json("/api/partner/tenants", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-partner-key": PARTNER_KEY },
      body: JSON.stringify({ slug: "style-test", name: "テスト院", accountEmail: "style-test@example.test", password: "password-S-123" }),
    });
    assert.equal(created.response.status, 201);
    const loggedIn = await json("/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ loginId: "style-test", password: "password-S-123" }) });
    const cookie = String(loggedIn.response.headers.get("set-cookie") || "").split(";")[0];
    const headers = { "Content-Type": "application/json", Cookie: cookie, Origin: PUBLIC_BASE };

    assert.equal((await json("/api/style-lesson-update", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).response.status, 401);
    const data = await json("/api/learning-data", { headers: { Cookie: cookie } });
    assert.equal(data.response.status, 200);
    assert.deepEqual(data.body.styles, []);
    const missing = await json("/api/style-lesson-update", { method: "POST", headers, body: JSON.stringify({ id: "sl-none", disabled: true }) });
    assert.equal(missing.response.status, 404);
    const missingDelete = await json("/api/style-lesson-delete", { method: "POST", headers, body: JSON.stringify({ id: "sl-none" }) });
    assert.equal(missingDelete.response.status, 404);
    const foreignOrigin = await json("/api/style-lesson-delete", { method: "POST", headers: Object.assign({}, headers, { Origin: "https://evil.example" }), body: JSON.stringify({ id: "sl-none" }) });
    assert.equal(foreignOrigin.response.status, 403);
  } finally {
    child.kill();
  }
});
