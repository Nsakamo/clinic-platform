"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "..", "migiude.js"), "utf8");

test("patient LINE webhook is durably queued before returning 200", () => {
  const route = source.slice(source.indexOf('app.post("/webhook/line"'), source.indexOf("// ===== 法人専用スタッフLINE webhook"));
  assert.match(route, /await enqueueLineWebhookEvents\(t, acct, dest, events\)/);
  assert.match(route, /res\.status\(200\)\.end\(\)/);
  assert.ok(route.indexOf("await enqueueLineWebhookEvents") < route.indexOf("res.status(200).end()"));
});

test("LINE queue persists idempotency and uses a locked claim", () => {
  assert.match(source, /PRIMARY KEY\(tenant,event_id\)/);
  assert.match(source, /ON CONFLICT \(tenant,event_id\) DO NOTHING/);
  assert.match(source, /FOR UPDATE SKIP LOCKED/);
  assert.match(source, /status='done'/);
});

test("health endpoints separate liveness from database readiness", () => {
  assert.match(source, /app\.get\("\/health"/);
  assert.match(source, /app\.get\("\/health\/ready"/);
  assert.match(source, /pool\.query\("SELECT 1"\)/);
});
