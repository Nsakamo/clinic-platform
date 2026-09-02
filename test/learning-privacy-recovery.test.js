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

test("自動学習は一般化済み判断メモリだけを保存し店舗ルールを変更しない", () => {
  const process = between("async function processLearningJob", "async function queueStaffLearning");
  assert.match(process, /await exampleLearningMetaUpdate\(t, ex\.id, learningMeta\)/);
  assert.match(process, /const learningMeta = proposed\.meta/);
  assert.match(process, /最優先の店舗ルールは明示確認なしに追加・更新しない/);
  assert.doesNotMatch(process, /distillRules\(/);
  assert.doesNotMatch(process, /ruleAdd\(|ruleUpdate\(/);
});

test("一般化AIが失敗した対応は今回限りに倒して再利用しない", async () => {
  const context = {
    contextualLearningFallback: () => "安全な既定案",
    formatLearningProposal: () => "一般化済み案",
    aiChat: async () => { throw new Error("ai_unavailable"); },
    sanitizeLearningMeta: value => ({
      intent: String(value.intent || ""), decision: String(value.decision || ""), conditions: String(value.conditions || ""),
      avoid: String(value.avoid || ""), searchTerms: value.searchTerms || [], scope: value.scope === "reusable" ? "reusable" : "one_off", updated: Number(value.updated || 0),
    }),
    learningIntentKey: () => "booking_change",
    sanitizeLearningChat: () => [],
    console: { error() {} },
  };
  vm.runInNewContext(between("function learningMetaContainsPatientSpecificData", "// 「送信しない」で対応終了した問い合わせ"), context);

  const result = await context.proposeContextualLearning({}, { q: "予約変更" });

  assert.equal(result.text, "安全な既定案");
  assert.equal(result.meta.scope, "one_off");
});

test("AI提案に患者名・日時・連絡先が残った場合は再利用しない", () => {
  const context = {};
  vm.runInNewContext(between("function learningMetaContainsPatientSpecificData", "async function proposeContextualLearning"), context);
  const input = { q: "田中様の9月8日14:30の予約を変更してください" };

  assert.equal(context.learningMetaContainsPatientSpecificData({ intent: "予約変更", decision: "田中様の9月8日14:30の予約を確認する" }, input), true);
  assert.equal(context.learningMetaContainsPatientSpecificData({ intent: "予約変更", decision: "提示された本人確認情報と予約日時を確認する" }, input), false);
  assert.equal(context.learningMetaContainsPatientSpecificData({ intent: "連絡", decision: "090-1234-5678へ連絡する" }, input), true);
});

test("再利用候補は独立した個人情報監査が明示承認した場合だけ通す", async () => {
  const context = {
    sanitizeLearningMeta: value => value,
    aiChat: async () => '{"safe":true,"reason":"一般的な手順のみ"}',
    console: { error() {} },
  };
  vm.runInNewContext(between("async function auditReusableLearningPrivacy", "async function proposeContextualLearning"), context);

  assert.equal(await context.auditReusableLearningPrivacy({}, { q: "予約変更" }, { intent: "予約変更" }), true);
  context.aiChat = async () => { throw new Error("audit_unavailable"); };
  assert.equal(await context.auditReusableLearningPrivacy({}, { q: "予約変更" }, { intent: "予約変更" }), false);
});

test("自動学習エラーでも送信済み対応例を削除しない", () => {
  const process = between("async function processLearningJob", "async function queueStaffLearning");
  assert.match(process, /exampleLearningMetaUpdate\(t, Number\(job\.exampleId\), \{ scope: "one_off" \}\)/);
  assert.doesNotMatch(process, /exampleDelete\(/);
});

test("旧学習範囲APIも個人情報監査キューを迂回しない", () => {
  const route = between('app.post("/api/learning-scope"', 'app.post("/api/learning-conflict-consult"');
  assert.match(route, /if \(!job\) \{/);
  assert.match(route, /status: "processing"/);
  assert.match(route, /setImmediate\(\(\) => processLearningJob\(t, job\.id\)\)/);
  assert.doesNotMatch(route, /distillRules\(/);
  assert.match(route, /const proposed = await proposeContextualLearning/);
  assert.match(route, /proposed\.meta\.scope !== "reusable"/);
});

test("学習データ管理からの再利用化も個人情報監査を必須にする", () => {
  const route = between('app.post("/api/example-update"', 'app.post("/api/example-delete"');
  assert.match(route, /learningMetaContainsPatientSpecificData/);
  assert.match(route, /await auditReusableLearningPrivacy/);
  assert.match(route, /privacy_review_failed/);
});

test("学習確認履歴の整理で未解決項目を先に削除しない", () => {
  const add = between("async function learningConflictAdd", "function publicLearningConflict");
  assert.match(add, /findIndex\(conflict => conflict && conflict\.status !== "pending"\)/);
  assert.match(add, /if \(resolvedIndex < 0\) break/);
  assert.doesNotMatch(add, /\.shift\(\)/);
});
