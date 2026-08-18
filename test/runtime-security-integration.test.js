"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawn } = require("node:child_process");

const root = path.join(__dirname, "..");
const PORT = 43827;
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

test("実HTTPで認証・Origin・テナント分離・固定公開URLを検証する", { timeout: 15000 }, async () => {
  const child = spawn(process.execPath, ["migiude.js"], {
    cwd: root,
    env: Object.assign({}, process.env, {
      NODE_ENV: "test",
      PORT: String(PORT),
      DATABASE_URL: "",
      CRED_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      PUBLIC_BASE_URL: PUBLIC_BASE,
      PLATFORM_SECRET: PARTNER_KEY,
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await waitForListening(child);

    const unauthenticated = await json("/api/account");
    assert.equal(unauthenticated.response.status, 401);
    const wrongPartner = await json("/api/partner/tenants", { headers: { "x-partner-key": "wrong" } });
    assert.equal(wrongPartner.response.status, 401);

    for (const [slug, password] of [["tenant-a", "password-A-123"], ["tenant-b", "password-B-123"]]) {
      const created = await json("/api/partner/tenants", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-partner-key": PARTNER_KEY },
        body: JSON.stringify({ slug, name: slug, accountEmail: slug + "@example.test", password }),
      });
      assert.equal(created.response.status, 201);
    }

    async function login(loginId, password) {
      const result = await json("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ loginId, password }),
      });
      assert.equal(result.response.status, 200);
      return String(result.response.headers.get("set-cookie") || "").split(";")[0];
    }
    const cookieA = await login("tenant-a", "password-A-123");
    const cookieB = await login("tenant-b", "password-B-123");

    const csrf = await json("/api/account", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookieA, Origin: "https://evil.example" },
      body: JSON.stringify({ accountEmail: "changed@example.test" }),
    });
    assert.equal(csrf.response.status, 403);
    assert.equal(csrf.body.error, "origin");

    const upload = await json("/api/upload", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookieA, Origin: PUBLIC_BASE },
      body: JSON.stringify({ name: "test.txt", mime: "text/plain", data: Buffer.from("tenant-a").toString("base64") }),
    });
    assert.equal(upload.response.status, 200);
    assert.match(upload.body.fileId, /^[0-9a-f]{32}$/);
    const crossTenant = await fetch(BASE + "/files/" + upload.body.fileId, { headers: { Cookie: cookieB } });
    assert.equal(crossTenant.status, 404);
    const capabilityAccess = await fetch(BASE + "/files/" + upload.body.fileId);
    assert.equal(capabilityAccess.status, 200);
    assert.match(capabilityAccess.headers.get("cache-control"), /no-store/);

    const removedImport = await json("/api/import-own", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookieA, Origin: PUBLIC_BASE },
      body: JSON.stringify({ url: "https://127.0.0.1/" }),
    });
    assert.equal(removedImport.response.status, 404);

    const sso = await json("/api/partner/sso", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-partner-key": PARTNER_KEY, Host: "evil.example" },
      body: JSON.stringify({ slug: "tenant-a" }),
    });
    assert.equal(sso.response.status, 200);
    assert.match(sso.body.url, /^https:\/\/rightarm\.example\.test\/sso\?t=/);
  } finally {
    child.kill("SIGTERM");
  }
});
