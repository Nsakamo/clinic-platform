"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "migiude.js"), "utf8");

function between(startText, endText) {
  const start = source.indexOf(startText);
  const end = source.indexOf(endText, start);
  assert.notEqual(start, -1, `missing ${startText}`);
  assert.notEqual(end, -1, `missing ${endText}`);
  return source.slice(start, end);
}

test("別患者向けの再利用文には生の質問・返信・氏名・予約日時を含めない", () => {
  const context = {};
  vm.runInNewContext(between("function sanitizeLearningMeta", "async function exampleLearningMetaUpdate"), context);
  const example = {
    q: "田中様の8月5日の予約を変更できますか",
    final: "田中様、8月10日14時へ変更しました",
    learningMeta: {
      scope: "reusable",
      intent: "予約変更",
      decision: "本人確認済みの予約情報を確認して変更手順を案内する",
      conditions: "予約変更の問い合わせ",
      avoid: "患者固有の氏名と予約日時",
      searchTerms: ["予約変更"],
    },
  };

  const search = context.learningMetaSearchText(example);
  const summary = context.reusableLearningSummary(example);

  assert.match(search, /予約変更/);
  assert.match(summary, /本人確認済みの予約情報/);
  assert.doesNotMatch(search + summary, /田中|8月5日|8月10日|14時/);
});

test("一般化未完了または今回限りの対応例は再利用文を作らない", () => {
  const context = {};
  vm.runInNewContext(between("function sanitizeLearningMeta", "async function exampleLearningMetaUpdate"), context);

  assert.equal(context.reusableLearningSummary({ learningMeta: {} }), "");
  assert.equal(context.reusableLearningSummary({ learningMeta: { scope: "one_off", intent: "予約変更", decision: "特例対応" } }), "");
});

test("再起動後と定期ワーカーでprocessing学習ジョブだけを再開する", () => {
  const scheduled = [];
  const processed = [];
  const context = {
    learningJobs: tenant => tenant.config.learningJobs,
    setImmediate: callback => scheduled.push(callback),
    processLearningJob: (_tenant, id) => processed.push(id),
    TEN: {},
  };
  vm.runInNewContext(between("function resumeLearningJobs", "async function checkFormalRuleConflict"), context);
  const tenant = { config: { learningJobs: [{ id: "processing-1", status: "processing" }, { id: "done-1", status: "done" }] } };

  context.resumeLearningJobs(tenant);
  scheduled.forEach(callback => callback());

  assert.deepEqual(processed, ["processing-1"]);
  assert.match(source, /setInterval\(processAllLearningJobs, 15000\)/);
  assert.match(source, /setTimeout\(processAllLearningJobs, 1000\)/);
});

test("下書き生成と送信前監査には一般化済み要約だけを渡す", () => {
  const draft = between("async function genDraft", "async function enrichStaffLineBookingPreview");
  assert.match(draft, /reusableLearningSummary\(e\)/);
  assert.doesNotMatch(draft, /String\(e\.originalQ \|\| e\.q\)/);
  assert.doesNotMatch(draft, /String\(e\.final\)/);
});
