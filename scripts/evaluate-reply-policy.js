"use strict";

// Manual, opt-in live evaluation using synthetic data only. No app DB, patient
// delivery, booking mutation, learning or provider fallback is connected here.
const fs = require("node:fs");
const vm = require("node:vm");
const assert = require("node:assert/strict");
const tone = require("../lib/reply-tone");
const decision = require("../lib/reply-decision");
const edit = require("../lib/draft-edit");
const { selectConversationContext } = require("../lib/conversation-context");
const { evaluateResponseGrounding } = require("../lib/response-grounding");
const { resolveAiRoute } = require("../lib/ai-model-router");
const source = fs.readFileSync(require.resolve("../migiude.js"), "utf8");
function section(start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  assert.ok(a > 0 && b > a);
  return source.slice(a, b);
}

async function main() {
  if (!process.env.OPENAI_KEY) throw new Error("OpenAI is not configured for this evaluation");
  const rules = [
    { id: 1, updated: Date.now(), title: "テスト：キャンセル料", content: "当日変更・キャンセルは3,300円、前日変更は1,100円。" },
    { id: 2, updated: Date.now(), title: "テスト：感染症免除", content: "感染症は予約前日の受診日・予約者名・病院名が分かる証明書の写真またはコピーを、この案内から12時間以内に提出した場合のみ免除対象となる。条件を満たさなければ通常のキャンセル料がかかる。証明書はスタッフが確認する。" },
  ];
  const current = new Date();
  const context = {
    ...tone, ...decision, ...edit, selectConversationContext, evaluateResponseGrounding,
    process, fetch, console, PATIENT_COURTESY: tone.PATIENT_COURTESY,
    S: t => t.config.settings, activeConversationMessages: c => c.msgs,
    rulesRankedWithScores: () => rules.map(r => ({ r, n: 4, score: 0.5 })),
    rulesBlock: list => list.map(r => r.title + ": " + r.content).join("\n"), ruleBudget: () => 16000,
    examplesRanked: () => [], trustedLearningPrecedent: () => false,
    prefsBlock: () => "", notesBlock: () => "", applyLearningReadinessGate: () => ({}),
    PARTNER_KEY: "", ANTHROPIC_KEY: "", baEnabled: () => false, staffLineReviewAll: () => false,
    staffBookingPrompt: () => "\n【予約の参考情報。今回の対象とは限らない】11月10日11時の将来予約があります。未実施の操作は完了と書かない。",
  };
  vm.createContext(context);
  vm.runInContext(section("async function aiChatOne(", "async function aiChat("), context);
  context.aiChat = async (t, sys, messages, maxTokens, task) => {
    const route = resolveAiRoute(t.config.settings, task);
    const result = await context.aiChatOne("gpt", sys, messages, maxTokens, route);
    if (!String(result.text || "").trim()) throw new Error("empty OpenAI response for " + task);
    return result.text;
  };
  vm.runInContext(section("const JP_QUALITY = ", "// 出力が途中で切れる"), context);
  vm.runInContext(section("async function reviewDraftChatCandidate(", 'app.post("/api/draft-chat"'), context);
  vm.runInContext(section("async function draftChatPrep(", 'app.get("/api/draft-chat-history"'), context);
  vm.runInContext(section("async function genDraft(t, c, opts) {", "// 毎回承認モード"), context);
  const t = { name: "テストクリニック", config: { settings: { engine: "gpt", tone: "患者様に配慮し丁寧に", prefs: [] } }, store: {} };
  const question = "テスト：インフルエンザになり、本日11時の予約に行けません。別の日に変更したいです。";
  const c = { id: "テスト患者", channel: "line", ts: current.getTime(), msgs: [{ from: "them", text: question, at: current.getTime(), sentAt: current.getTime() }] };
  t.store[c.id] = c;
  const draft = await context.genDraft(t, c, { skipExternal: true });
  assert.ok(draft && draft.draft);
  assert.match(draft.draft, /証明書/);
  assert.match(draft.draft, /免除/);
  assert.match(draft.draft, /3[,，]?300/);
  assert.match(draft.draft, /12/);
  assert.equal(draft.grounding.autoSendAllowed, false);
  console.log(JSON.stringify({ case: "initial", model: resolveAiRoute(t.config.settings, "draft").model, draft: draft.draft }));

  const p = await context.draftChatPrep(t, { id: c.id, messages: [
    { role: "assistant", content: "11月の予約の空き状況を確認し、ご連絡します。", kind: "draft" },
    { role: "user", content: "診断書のルールを使って今回の変更について伝えて。11月の予約の話はしないで。" },
  ] });
  const raw = await context.aiChat(t, p.base + "患者様への返信本文だけを出力してください。", p.edits, 4000, "chat");
  const revised = await context.reviewDraftChatCandidate(t, p, raw);
  assert.equal(revised.error, "");
  assert.match(revised.text, /証明書/);
  assert.match(revised.text, /3[,，]?300/);
  assert.doesNotMatch(revised.text, /11月/);
  console.log(JSON.stringify({ case: "staff-edit", model: resolveAiRoute(t.config.settings, "chat").model, draft: revised.text }));

  c.msgs.push({ from: "us", text: revised.text, at: current.getTime() + 1000, sentAt: current.getTime() + 1000 },
    { from: "them", text: "テスト：証明書の写真を提出しました。確認をお願いします。", at: current.getTime() + 2000, sentAt: current.getTime() + 2000 },
    { from: "them", media: "image", at: current.getTime() + 3000, sentAt: current.getTime() + 3000 });
  const after = await context.genDraft(t, c, { skipExternal: true });
  assert.ok(after && after.draft);
  assert.doesNotMatch(after.draft, /免除(?:しました|いたしました)|変更(?:しました|いたしました)|証明書を(?:ご)?提出(?:ください|いただけます)/);
  assert.equal(after.grounding.autoSendAllowed, false);
  console.log(JSON.stringify({ case: "proof-received-not-reviewed", model: resolveAiRoute(t.config.settings, "draft").model, draft: after.draft }));

  const ordinary = { id: "テスト証明書発行", channel: "line", msgs: [{ from: "them", text: "テスト：受診証明書を発行してもらえますか。", at: current.getTime(), sentAt: current.getTime() }] };
  const certificate = await context.genDraft(t, ordinary, { skipExternal: true });
  assert.ok(certificate && certificate.draft);
  assert.doesNotMatch(certificate.draft, /キャンセル|免除|3[,，]?300|12時間/);
  console.log(JSON.stringify({ case: "certificate-issuance-only", model: resolveAiRoute(t.config.settings, "draft").model, draft: certificate.draft }));
}

main().catch(error => { console.error("Synthetic evaluation failed:", String(error.message || error).slice(0, 300)); process.exitCode = 1; });
