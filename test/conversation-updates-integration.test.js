"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "..", "migiude.js"), "utf8");

test("conversation polling switches from a full load to revision updates", () => {
  assert.match(source, /app\.get\("\/api\/conversation-updates"/);
  assert.match(source, /c\._rev = t\._convRev/);
  assert.match(source, /DATA_READY\?\("\/api\/conversation-updates\?since=/);
  assert.match(source, /const byId=new Map\(DATA\.map/);
});

test("incremental response preserves server ordering and shared settings metadata", () => {
  const route = source.slice(source.indexOf('app.get("/api/conversation-updates"'), source.indexOf("async function deliverText"));
  assert.match(route, /order: arr\.map\(c => c\.id\)/);
  assert.match(route, /meta: \{ staffLineReviewAvailable, inboxOrder \}/);
});
