"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "..", "migiude.js"), "utf8");

test("作り直しの規定照合失敗は保存済み下書きや学習履歴を変更しない", async () => {
  let handler, writes = 0;
  const start = source.indexOf('app.post("/api/redraft",');
  const end = source.indexOf('app.post("/api/draft-edited",', start);
  const context = {
    app: { post: (...args) => { handler = args.at(-1); } }, guard: () => {},
    genDraft: async () => ({ draft: "", qualityIssues: ["policy_review_failed"] }),
    startLearningUsageTrace: async () => { writes++; }, dbSave: async () => { writes++; },
  };
  vm.runInNewContext(source.slice(start, end), context);
  const c = { draft: "保存済みの案", draft0: "元の案", topics: ["旧話題"] };
  const before = JSON.stringify(c);
  const res = { code: 200, status(code) { this.code = code; return this; }, json(body) { this.body = body; } };
  await handler({ tenant: { store: { test: c } }, body: { id: "test", selected: ["証明書"] } }, res);
  assert.equal(res.code, 502);
  assert.equal(res.body.error, "policy_review_failed");
  assert.equal(JSON.stringify(c), before);
  assert.equal(writes, 0);
});

test("作り直し失敗は入力中の案を保持し、理由を表示してボタンを戻す", async () => {
  const btn = { disabled: false, textContent: "選んだ内容で下書きを作成" };
  const draft = { value: "入力中の案" }, alerts = [], row = { id: "test", draft: "保存済みの案" };
  const start = source.indexOf("async function redraftSelected(){");
  const end = source.indexOf("async function markDone", start);
  const context = {
    current: "test", selTopics: new Set(["証明書"]), DATA: [row],
    document: { getElementById: id => id === "redraftBtn" ? btn : draft },
    api: async () => ({ json: async () => ({ ok: false, error: "policy_review_failed" }) }),
    uiAlert: text => alerts.push(text), renderGrounding: () => { throw new Error("失敗した案は表示しない"); },
  };
  vm.runInNewContext(source.slice(start, end), context);
  await context.redraftSelected();
  assert.equal(draft.value, "入力中の案");
  assert.equal(row.draft, "保存済みの案");
  assert.match(alerts[0], /入力中の下書きは変更していません/);
  assert.equal(btn.disabled, false);
  assert.equal(btn.textContent, "選んだ内容で下書きを作成");
});
