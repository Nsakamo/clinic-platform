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

function eligibilityContext() {
  const context = { learningJobs: tenant => tenant.config.learningJobs };
  vm.runInNewContext(between("const LEARNING_PROMPT_MS", "function publicLearningJob"), context);
  return context;
}

test("URLだけ・絵文字だけ・短い定型応答には学習確認を出さない", () => {
  const context = eligibilityContext();
  assert.equal(context.shouldOfferLearningConsent("予約方法を教えてください", "https://example.com/guide"), false);
  assert.equal(context.shouldOfferLearningConsent("予約方法を教えてください", "example.com/guide"), false);
  assert.equal(context.shouldOfferLearningConsent("予約方法を教えてください", "こちらです https://example.com/guide"), false);
  assert.equal(context.shouldOfferLearningConsent("届きましたか", "👍✨"), false);
  for (const reply of ["❤️", "☺️", "🙇‍♀️", "👨‍👩‍👧", "1️⃣"]) {
    assert.equal(context.shouldOfferLearningConsent("届きましたか", reply), false, reply);
  }
  assert.equal(context.shouldOfferLearningConsent("確認をお願いします", "承知しました。"), false);
  assert.equal(context.shouldOfferLearningConsent("確認をお願いします", "よろしくお願いいたします。"), false);
  assert.equal(context.shouldOfferLearningConsent("確認をお願いします", "はい、承知いたしました。"), false);
});

test("裸ドメイン判定は長大入力でも速く、日本語の判断部分を消さない", () => {
  const context = eligibilityContext();
  const longAscii = "a".repeat(100000);
  const started = performance.now();
  assert.equal(context.shouldOfferLearningConsent("質問です", longAscii), true);
  assert.ok(performance.now() - started < 50);
  assert.equal(context.shouldOfferLearningConsent("変更期限はいつですか", "smilemedi.jp/reserveから前日まで変更できます"), true);
});

test("短くても再利用できる判断を含む回答には学習確認を出す", () => {
  const context = eligibilityContext();
  assert.equal(context.shouldOfferLearningConsent("当日でも変更できますか", "可能です"), true);
  assert.equal(context.shouldOfferLearningConsent("何日前まで変更できますか", "前日の18時まで変更できます"), true);
  assert.equal(context.shouldOfferLearningConsent("", "前日の18時まで変更できます"), false);
});

test("確認候補の段階では対応例を保存せず、3秒表示用の期限を返す", async () => {
  const saved = [];
  const context = {
    recentCustomerQuestion: () => "何日前まで変更できますか",
    shouldOfferLearningConsent: () => true,
    sanitizeLearningChat: value => Array.isArray(value) ? value : [],
    learningReviewPayload: () => null,
    contextualLearningFallback: () => "変更期限を確認して案内する",
    learningJobs: tenant => tenant.config.learningJobs,
    saveTenantConfig: async tenant => { saved.push(tenant.config.learningJobs.length); },
    publicLearningJob: job => ({ ...job }),
    LEARNING_CONSENT_TTL_MS: 10000,
    LEARNING_PROMPT_MS: 3000,
    crypto: { randomBytes: () => Buffer.from("abcdef", "hex") },
  };
  vm.runInNewContext(between("async function prepareStaffLearningConsent", "// 2つのテキストがほぼ同内容か"), context);
  const tenant = { config: { learningJobs: [] } };

  const prompt = await context.prepareStaffLearningConsent(tenant, { id: "conversation-1" }, { final: "前日の18時まで変更できます" });

  assert.equal(prompt.status, "awaiting_consent");
  assert.equal(prompt.promptMs, 3000);
  assert.equal(tenant.config.learningJobs.length, 1);
  assert.deepEqual(saved, [1]);
  assert.equal(tenant.config.learningJobs[0].exampleId, 0);
});

test("時間切れといいえは学習候補を削除し、はいだけ処理中へ進める", () => {
  const route = between('app.post("/api/learning-scope"', 'app.post("/api/learning-conflict-consult"');
  assert.match(route, /status === "awaiting_consent" && Number\(job\.expiresAt \|\| 0\) <= Date\.now\(\)/);
  assert.match(route, /return res\.status\(410\)\.json\(\{ ok: false, error: "consent_expired" \}\)/);
  assert.match(route, /job && job\.status === "awaiting_consent"[\s\S]{0,180}splice\(index, 1\)/);
  assert.match(route, /\["awaiting_decision", "awaiting_consent"\]\.includes\(job\.status\)/);
  assert.match(route, /job\.status = "processing"/);
});

test("再起動等で取り残された同意受理中ジョブだけを5分後に整理する", () => {
  const context = eligibilityContext();
  const now = Date.now();
  const recent = { id: "recent", status: "accepting_consent", updatedAt: now - 1000 };
  const abandoned = { id: "abandoned", status: "accepting_consent", updatedAt: now - (5 * 60 * 1000) - 1 };
  const tenant = { config: { learningJobs: [recent, abandoned] } };
  assert.equal(context.expireLearningConsents(tenant, now), 1);
  assert.deepEqual(Array.from(tenant.config.learningJobs), [recent]);
});

test("はいの保存待ち中に同じ会話へ次の送信が来ても、処理中ジョブを削除しない", async () => {
  let finishExample;
  const delayedExample = new Promise(resolve => { finishExample = resolve; });
  const context = {
    recentCustomerQuestion: () => "次の質問です",
    shouldOfferLearningConsent: () => true,
    sanitizeLearningChat: value => Array.isArray(value) ? value : [],
    learningReviewPayload: (_example, opts) => ({ conversationId: opts.conversationId, q: opts.q, final: opts.final, text: "判断手順" }),
    contextualLearningFallback: () => "判断手順",
    learningJobs: tenant => tenant.config.learningJobs,
    saveTenantConfig: async () => {},
    publicLearningJob: job => ({ ...job }),
    exampleAdd: async () => delayedExample,
    LEARNING_CONSENT_TTL_MS: 10000,
    LEARNING_PROMPT_MS: 3000,
    crypto: { randomBytes: () => Buffer.from("abcdef", "hex") },
  };
  vm.runInNewContext(between("async function prepareStaffLearningConsent", "// 2つのテキストがほぼ同内容か"), context);
  const original = {
    id: "consent-1", conversationId: "conversation-1", status: "awaiting_consent", expiresAt: Date.now() + 10000,
    learningReview: { text: "判断手順" }, payload: { q: "元の質問", final: "元の回答", source: "web" },
  };
  const tenant = { config: { learningJobs: [original] } };

  const accepting = context.acceptLearningConsentJob(tenant, original, "判断手順");
  assert.equal(original.status, "accepting_consent");
  await context.prepareStaffLearningConsent(tenant, { id: "conversation-1" }, { final: "次の回答" });
  assert.equal(tenant.config.learningJobs.includes(original), true);
  assert.equal(tenant.config.learningJobs.filter(job => job.status === "awaiting_consent").length, 1);

  finishExample({ id: 77, reused: false });
  const saved = await accepting;
  assert.equal(saved.id, 77);
  assert.equal(original.status, "processing");
  assert.equal(original.exampleId, 77);
});

test("学習同意の実処理はawait前にジョブを確保し、共通処理を通る", () => {
  const accept = between("async function acceptLearningConsentJob", "// 2つのテキストがほぼ同内容か");
  const claimAt = accept.indexOf('job.status = "accepting_consent"');
  const awaitAt = accept.indexOf("await exampleAdd");
  assert.ok(claimAt >= 0 && awaitAt > claimAt);
  const route = between('app.post("/api/learning-scope"', 'app.post("/api/learning-conflict-consult"');
  assert.match(route, /ex = await acceptLearningConsentJob\(t, job, text\)/);
});
