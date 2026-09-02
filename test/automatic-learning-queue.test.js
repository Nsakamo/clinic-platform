"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "migiude.js"), "utf8");
const start = source.indexOf("async function queueStaffLearning");
const end = source.indexOf("// 2つのテキストがほぼ同内容か", start);
assert.notEqual(start, -1);
assert.notEqual(end, -1);

function createContext(overrides = {}) {
  const scheduled = [];
  const context = {
    recentCustomerQuestion: () => "予約を変更できますか",
    sanitizeLearningChat: value => Array.isArray(value) ? value : [],
    exampleAdd: async () => ({ id: 41 }),
    learningReviewPayload: ex => ({ exampleId: ex.id, text: "予約変更の条件を確認する" }),
    crypto: { randomBytes: () => Buffer.from("abcdef", "hex") },
    learningJobs: tenant => tenant.config.learningJobs,
    saveTenantConfig: async tenant => { tenant.saved = true; },
    setImmediate: callback => { scheduled.push(callback); },
    processLearningJob: async () => {},
    publicLearningJob: job => ({ ...job }),
    ...overrides,
  };
  vm.runInNewContext(source.slice(start, end), context);
  return { context, scheduled };
}

test("送信済み回答を処理中候補として保存してからバックグラウンド確認を開始する", async () => {
  const tenant = { config: { learningJobs: [] } };
  const conversation = { id: "conversation-1" };
  const { context, scheduled } = createContext();

  const result = await context.queueStaffLearning(tenant, conversation, {
    final: "予約日時を確認して変更方法をご案内します",
    draft0: "変更できます",
    instr: "確認してから案内",
    source: "web",
  });

  assert.equal(result.learnedId, 41);
  assert.equal(result.job.status, "processing");
  assert.equal(result.job.exampleId, 41);
  assert.equal(tenant.saved, true);
  assert.equal(tenant.config.learningJobs.length, 1);
  assert.equal(scheduled.length, 1);
});

test("患者の質問または送信本文がない場合は学習データを作らない", async () => {
  let added = 0;
  const { context, scheduled } = createContext({
    recentCustomerQuestion: () => "",
    exampleAdd: async () => { added += 1; return { id: 1 }; },
  });

  const result = await context.queueStaffLearning({ config: { learningJobs: [] } }, { id: "conversation-2" }, { final: "回答" });

  assert.equal(result, null);
  assert.equal(added, 0);
  assert.equal(scheduled.length, 0);
});

test("設定保存が一時失敗してもメモリ上の学習ジョブ処理を開始する", async () => {
  const tenant = { config: { learningJobs: [] } };
  const { context, scheduled } = createContext({
    saveTenantConfig: async () => { throw new Error("temporary_db_error"); },
  });

  await assert.rejects(
    context.queueStaffLearning(tenant, { id: "conversation-3" }, { q: "質問", final: "回答" }),
    /temporary_db_error/,
  );

  assert.equal(tenant.config.learningJobs[0].status, "processing");
  assert.equal(scheduled.length, 1);
});
