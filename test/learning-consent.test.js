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
  const context = {};
  vm.runInNewContext(between("const LEARNING_PROMPT_MS", "function publicLearningJob"), context);
  return context;
}

test("URLだけ・絵文字だけ・短い定型応答には学習確認を出さない", () => {
  const context = eligibilityContext();
  assert.equal(context.shouldOfferLearningConsent("予約方法を教えてください", "https://example.com/guide"), false);
  assert.equal(context.shouldOfferLearningConsent("予約方法を教えてください", "こちらです https://example.com/guide"), false);
  assert.equal(context.shouldOfferLearningConsent("届きましたか", "👍✨"), false);
  assert.equal(context.shouldOfferLearningConsent("確認をお願いします", "承知しました。"), false);
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

