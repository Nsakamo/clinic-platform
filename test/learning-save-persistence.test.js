"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "migiude.js"), "utf8");

function sourceBetween(startText, endText) {
  const start = source.indexOf(startText);
  const end = source.indexOf(endText, start);
  assert.notEqual(start, -1, `missing source start: ${startText}`);
  assert.notEqual(end, -1, `missing source end: ${endText}`);
  return source.slice(start, end);
}

test("学習判断待ちをコピーではなくテナント設定の正本へ追加する", () => {
  const context = {};
  vm.runInNewContext(sourceBetween("function learningJobs", "function publicLearningJob"), context);

  const tenant = { config: { learningJobs: [null] } };
  const canonical = tenant.config.learningJobs;
  const job = { id: "テスト-learning-job", status: "awaiting_decision" };
  context.learningJobs(tenant).push(job);

  assert.equal(tenant.config.learningJobs, canonical);
  assert.deepEqual(Array.from(tenant.config.learningJobs), [job]);
});

test("同一法人の設定保存を開始順に直列化し、古い更新で学習候補を消さない", async () => {
  let releaseFirst;
  const calls = [];
  const pool = {
    query(_sql, values) {
      calls.push(JSON.parse(JSON.stringify(values[2])));
      if (calls.length === 1) return new Promise(resolve => { releaseFirst = resolve; });
      return Promise.resolve({ rowCount: 1 });
    },
  };
  const context = { pool, encryptConnSecrets() {} };
  vm.runInNewContext(sourceBetween("async function saveTenantConfig", "// ===== 自動化ダッシュボード"), context);

  const tenant = { slug: "test-tenant", name: "テスト法人", config: { conn: {}, learningJobs: [] } };
  const first = context.saveTenantConfig(tenant);
  await Promise.resolve();
  tenant.config.learningJobs.push({ id: "テスト-learning-job" });
  const second = context.saveTenantConfig(tenant);
  await Promise.resolve();

  assert.equal(calls.length, 1);
  releaseFirst({ rowCount: 1 });
  await first;
  await second;
  assert.equal(calls.length, 2);
  assert.equal(calls[1].learningJobs[0].id, "テスト-learning-job");
});

test("候補IDが失われても画面に保持した会話内容から学習を復元できる", () => {
  const route = sourceBetween('app.post("/api/learning-scope"', 'app.post("/api/learning-conflict-consult"');
  assert.match(route, /req\.body\.q/);
  assert.match(route, /req\.body\.final/);
  assert.match(route, /source: "web-recovered"/);

  const browser = sourceBetween("async function saveLearningScope", "function openRuleLearning");
  assert.match(browser, /q:data\.q,final:data\.final,draft0:data\.draft0,instr:data\.instr/);
  assert.doesNotMatch(browser, /内容は確認待ちに残しています/);
});
