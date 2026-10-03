"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const decision = require("../lib/reply-decision");
const { selectConversationContext } = require("../lib/conversation-context");
const { explicitEditMismatch, normalizeDraftEditHistory, isDraftChatConsultation } = require("../lib/draft-edit");
const { evaluateResponseGrounding } = require("../lib/response-grounding");
const source = fs.readFileSync(require.resolve("../migiude.js"), "utf8");
const rules = "感染症による変更は、予約前日の受診日・予約者名・病院名のある証明書を12時間以内に提出した場合のみ免除対象。条件を満たさない当日変更は3,300円。";
const query = "テスト：インフルになり、本日11時の予約に行けません。日付を変更したいです。";

test("感染症の変更理由から免除・証明書ルールも取得し、インフルエンサーは誤検出しない", () => {
  assert.match(decision.replyRuleQuery(query), /受診証明/);
  assert.match(decision.replyRuleQuery("診断書のルールを使って伝えて"), /キャンセル.*免除/);
  assert.equal(decision.replyRuleQuery("インフルエンサーの来院予約を変更したい"), "インフルエンサーの来院予約を変更したい");
  assert.equal(decision.needsCancellationPolicyReview(query, rules), true);
  assert.equal(decision.needsCancellationPolicyReview("テスト：ご来院ありがとうございます", rules), false);
  assert.equal(decision.needsCancellationPolicyReview(query, "免除規定なし"), false);
});

test("患者連絡の実際の日付をJSTで渡し、時刻だけの旧履歴には日付を補わない", () => {
  const text = decision.replyMessageText({ from: "them", text: query, at: Date.parse("2026-10-02T23:54:00Z") });
  assert.match(text, /2026\/10\/3.*8:54:00/);
  assert.match(text, /本日11時/);
  assert.equal(decision.replyMessageText({ text: query, time: "09:54" }), query);
  assert.match(decision.REPLY_DECISION, /別の月の次回予約/);
  assert.match(decision.REPLY_DECISION, /連絡を送った日時を基準/);
});

function reviewHarness(responses) {
  const calls = [];
  const start = source.indexOf("async function reviewDraftChatCandidate(");
  const end = source.indexOf('app.post("/api/draft-chat"', start);
  const context = {
    ...decision, explicitEditMismatch,
    finalizeGeneratedDraft: async (_t, text) => ({ text, issues: [] }),
    hasConversationalTone: () => false, PATIENT_COURTESY: "丁寧に",
    aiChat: async (_t, sys, messages, _limit, task) => { calls.push({ sys, messages, task }); return responses.shift(); },
  };
  vm.runInNewContext(source.slice(start, end), context);
  return { review: context.reviewDraftChatCandidate, calls };
}

test("編集後の照合・修復・再照合に正式ルールを渡し、証明書案内の抜けを修復する", async () => {
  const corrected = "ご連絡ありがとうございます。証明書を12時間以内にご提出いただき、予約前日の受診日・予約者名・病院名が確認できれば免除対象となります。条件を満たさない当日変更は3,300円です。";
  const h = reviewHarness(['{"pass":false,"reason":"証明書の案内がない"}', corrected, '{"pass":true,"reason":"ルールに一致"}']);
  const p = { c: { channel: "line" }, lastQ: query, latestInstruction: "診断書のルールを使って伝えて", evidence: rules + "\n参考の将来予約：11月10日", previousDraft: "11月の予約の空き状況を確認します。" };
  const result = await h.review({}, p, p.previousDraft);
  assert.equal(result.text, corrected);
  assert.equal(result.error, "");
  assert.equal(h.calls.length, 3);
  for (const call of h.calls) {
    assert.match(call.messages[0].content, /予約前日の受診日/);
    assert.match(call.messages[0].content, /3,300円/);
    assert.match(call.sys, /今回のキャンセル対象や料金判断に使わない/);
  }
});

test("照合失敗や修復失敗は旧い案を採用せず、免除や予約操作も実行しない", async () => {
  for (const reply of [null, "壊れたJSON", '{"pass":false,"reason":"証明未確認なのに免除を確定"}']) {
    const h = reviewHarness([reply, null]);
    const result = await h.review({}, { c: { channel: "line" }, lastQ: query, latestInstruction: "診断書の条件を案内して", evidence: rules }, "免除しました。予約を変更しました。");
    assert.equal(result.text, "");
    assert.match(result.error, /正確に反映できません/);
    assert.equal(h.calls.every(c => ["audit", "chat"].includes(c.task)), true);
  }
});

test("編集準備は関連証明書ルールと会話日時を照合資料へ含める", async () => {
  const start = source.indexOf("async function draftChatPrep(");
  const end = source.indexOf('app.get("/api/draft-chat-history"', start);
  const queries = [];
  const context = {
    ...decision, selectConversationContext, normalizeDraftEditHistory, isDraftChatConsultation,
    rulesRankedWithScores: (_t, q) => { queries.push(q); return [{ n: 2, r: { content: rules } }]; },
    rulesBlock: rel => rel.map(r => r.content).join("\n"),
    S: () => ({ engine: "gpt", tone: "" }), notesBlock: () => "", prefsBlock: () => "", replyToneInstruction: () => "",
    baEnabled: () => false, PARTNER_KEY: "", staffBookingPrompt: () => "", ANTHROPIC_KEY: "", process: { env: {} }, JP_QUALITY: "",
  };
  vm.runInNewContext(source.slice(start, end), context);
  const c = { id: "テスト患者", channel: "line", ts: 1, msgs: [{ from: "them", text: query, at: Date.parse("2026-10-03T00:54:00Z") }] };
  const result = await context.draftChatPrep({ store: { [c.id]: c } }, { id: c.id, messages: [{ role: "user", content: "診断書のやつ使って伝えて" }] });
  assert.match(queries[0], /受診証明/);
  assert.match(result.evidence, /12時間以内/);
  assert.match(result.evidence, /送信日時.*2026\/10\/3/);
  assert.match(result.base, /旧下書きの誤りを最新指示より優先しない/);
  assert.equal(result.consultation, false);
});

test("初回生成は人の確認が必要でも免除案内の漏れを照合する", async () => {
  const start = source.indexOf("async function genDraft(t, c, opts) {");
  const end = source.indexOf("// 毎回承認モード", start);
  let reviewed = false, prompt = "";
  const context = {
    ...decision, activeConversationMessages: c => c.msgs,
    S: () => ({ tone: "", prefs: [] }),
    rulesRankedWithScores: () => [{ r: { content: rules }, n: 3, score: 0.5 }], rulesBlock: () => rules, ruleBudget: () => 16000,
    examplesRanked: () => [], trustedLearningPrecedent: () => false, prefsBlock: () => "", notesBlock: () => "", replyToneInstruction: () => "",
    JP_QUALITY: "", PATIENT_COURTESY: "", baEnabled: () => false, staffLineReviewAll: () => false, PARTNER_KEY: "",
    aiChat: async (_t, sys) => { prompt = sys; return JSON.stringify({ draft: "空き状況を確認します。", confidence: "high", needs_human: true }); },
    finalizeGeneratedDraft: async (_t, text) => ({ text, issues: [] }), applyCourtesyGate: () => {},
    reviewDraftChatCandidate: async (_t, p) => { reviewed = true; assert.match(p.evidence, /12時間以内/); return { text: "証明書の条件を確認し、規定を案内します。", error: "" }; },
    evaluateResponseGrounding, applyLearningReadinessGate: () => ({}),
  };
  vm.runInNewContext(source.slice(start, end), context);
  const result = await context.genDraft({}, { channel: "line", msgs: [{ from: "them", text: query, at: Date.parse("2026-10-03T00:54:00Z") }] }, { skipExternal: true });
  assert.equal(reviewed, true);
  assert.equal(result.grounding.autoSendAllowed, false);
  assert.match(prompt, /既知の規定を省略しない/);
});

test("感染症免除は根拠があっても患者申告だけで自動確定・自動送信しない", () => {
  const result = evaluateResponseGrounding({ query, draft: "証明書をご提出ください。", ruleMatches: [{ overlap: 4, score: 0.5 }], verifiedBooking: true });
  assert.equal(result.autoSendAllowed, false);
  assert.match(result.reasons.join(" "), /スタッフ確認/);
});
