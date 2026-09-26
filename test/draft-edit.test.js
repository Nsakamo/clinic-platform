"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { explicitEditMismatch, normalizeDraftEditHistory, isDraftChatConsultation } = require("../lib/draft-edit");

const source = fs.readFileSync(path.join(__dirname, "..", "migiude.js"), "utf8");
const start = source.indexOf("async function reviewDraftChatCandidate(");
const end = source.indexOf('app.post("/api/draft-chat"', start);
assert.ok(start > 0 && end > start);

function reviewer(replies) {
  const calls = [];
  const context = {
    finalizeGeneratedDraft: async (_t, text) => ({ text }),
    aiChat: async (_t, sys, messages, _limit, task) => { calls.push({ sys, messages, task }); return replies.shift(); },
    explicitEditMismatch,
    hasConversationalTone: () => false,
    PATIENT_COURTESY: "患者様に礼儀正しく返信する。",
  };
  vm.runInNewContext(source.slice(start, end), context);
  return { review: context.reviewDraftChatCandidate, calls };
}

function input(instruction) {
  return {
    c: { channel: "line" }, latestInstruction: instruction,
    previousDraft: "以前誤って消化されたチケット分を、今回のキャンセルに充てられるか確認いたします。ご予約者様のお名前とお電話番号をお知らせください。",
    lastQ: "以前のチケットを今回のキャンセルに使いたいです",
  };
}

test("確定指示を可否確認へ戻す案は監査が通しても採用しない", async () => {
  const bad = input("").previousDraft;
  assert.match(explicitEditMismatch("キャンセルに充てる", bad), /適用する指示/);
  assert.match(explicitEditMismatch("キャンセルに当てる", bad), /適用する指示/);
  assert.match(explicitEditMismatch("確認するんじゃなくていい", bad), /確認を不要/);
  const { review, calls } = reviewer([
    '{"pass":true,"reason":"問題なし"}',
    "以前誤って消化されたチケット分を、今回のキャンセルに充当いたします。",
    '{"pass":true,"reason":"指示を反映"}',
  ]);
  const result = await review({}, input("キャンセルに充てる"), bad);
  assert.equal(result.text, "以前誤って消化されたチケット分を、今回のキャンセルに充当いたします。");
  assert.equal(result.error, "");
  assert.equal(calls.length, 3);
});

test("確認を求める指示は確約に変えず、確認不要の指示だけを確定扱いにする", () => {
  const checking = "以前のチケットを今回のキャンセルに充てられるか確認いたします。";
  assert.equal(explicitEditMismatch("充てるかどうか確認して", checking), "");
  assert.equal(explicitEditMismatch("適用するか確認すると伝えて", checking), "");
  assert.equal(explicitEditMismatch("確認しないといけないと伝えて", "確認いたします。"), "");
  assert.equal(explicitEditMismatch("キャンセルに充てるか確認中と伝えて", checking), "");
  assert.equal(explicitEditMismatch("充てるか確認でき次第連絡すると伝えて", checking), "");
  assert.equal(explicitEditMismatch("充てるか要確認", checking), "");
  assert.equal(explicitEditMismatch("充てるか確認お願い", checking), "");
  assert.equal(explicitEditMismatch("確認済みなのでキャンセルに充てる", checking).includes("適用する指示"), true);
  for (const decided of ["確認取れたのでキャンセルに充てる", "確認できたので充てて", "確認はいらない、キャンセルに充てる", "確認なしで充てて", "確認はしないで充てる"]) {
    assert.match(explicitEditMismatch(decided, checking), /適用する指示|確認を不要/, decided);
    assert.equal(explicitEditMismatch(decided, "今回のキャンセルに充当いたします。"), "", decided);
  }
  for (const patientCheck of ["キャンセルに充てて、ご確認お願いしますと添えて", "キャンセルに充てて、新しい予約日を確認してくださいと伝えて"]) {
    assert.equal(explicitEditMismatch(patientCheck, "今回のキャンセルに充当いたします。お手数ですがご確認をお願いいたします。"), "", patientCheck);
  }
  assert.match(explicitEditMismatch("充てるかどうか確認して", "今回のキャンセルに充当いたします。"), /確約/);
  assert.match(explicitEditMismatch("充てるか要確認", "今回のキャンセルに充当いたします。"), /確約/);
  assert.match(explicitEditMismatch("確認しないといけないと伝えて", "今回のキャンセルに充当いたします。"), /確約/);
  assert.match(explicitEditMismatch("確認しないでキャンセルに充てる", checking), /確認を不要/);
  assert.match(explicitEditMismatch("キャンセルに充てる", checking), /適用する指示/);
});

test("確認指示への確約案はAI監査が通しても修正し、直らなければ表示しない", async () => {
  const { review, calls } = reviewer([
    '{"pass":true,"reason":"問題なし"}',
    "今回のキャンセルに充てられるか確認いたします。",
    '{"pass":true,"reason":"指示を反映"}',
  ]);
  const result = await review({}, input("充てるかどうか確認して"), "今回のキャンセルに充当いたします。");
  assert.equal(result.text, "今回のキャンセルに充てられるか確認いたします。");
  assert.equal(result.error, "");
  assert.equal(calls.length, 3);
});

test("患者様へのご確認依頼を添えた確定案は誤って差し戻さない", async () => {
  const draft = "以前誤って消化されたチケット分は、今回のキャンセルに充当いたします。お手数ですがご確認をお願いいたします。";
  const { review, calls } = reviewer(['{"pass":true,"reason":"指示を反映"}']);
  const result = await review({}, input("キャンセルに充てて、ご確認お願いしますと添えて"), draft);
  assert.equal(result.text, draft);
  assert.equal(result.error, "");
  assert.equal(calls.length, 1);
});

test("相談と編集指示を区別し、長い編集履歴の先頭に孤立したAI回答を残さない", () => {
  assert.equal(isDraftChatConsultation("キャンセル料っていくらだっけ？"), true);
  assert.equal(isDraftChatConsultation("どっちの言い方がいいと思う？"), true);
  assert.equal(isDraftChatConsultation("この文で失礼はないでしょうか"), true);
  assert.equal(isDraftChatConsultation("充てますと伝えられますか？"), false);
  for (const edit of ["どちらの日程でも大丈夫ですと返して", "教えてくれてありがとうございますと添えて", "キャンセル料がいくらかも書き足して", "どっちの院か記載して"]) {
    assert.equal(isDraftChatConsultation(edit), false, edit);
  }
  assert.equal(isDraftChatConsultation("キャンセルに充てるかどうか確認して"), false);
  assert.equal(isDraftChatConsultation("もっと丁寧にできる？"), false);
  const edits = normalizeDraftEditHistory([
    { role: "assistant", content: "確認が必要です", kind: "reply" },
    { role: "user", content: "では丁寧にして" },
    { role: "assistant", content: "下書き", kind: "draft" },
    { role: "user", content: "もう少し短く" },
  ]);
  assert.equal(edits[0].role, "user");
  assert.equal(edits[0].content, "では丁寧にして");
  assert.equal(edits.at(-1).content, "もう少し短く");
});

test("修正しても指示に従わない場合は下書きカードへ渡さない", async () => {
  const bad = input("").previousDraft;
  const { review } = reviewer([
    '{"pass":false,"reason":"指示に反する"}',
    bad,
    '{"pass":false,"reason":"指示に反する"}',
  ]);
  const result = await review({}, input("確認は不要。キャンセルに充てる"), bad);
  assert.equal(result.text, "");
  assert.match(result.error, /正確に反映できませんでした/);
});

test("編集チャットは関連ルールだけを選び、両APIが同じ監査を通る", () => {
  const prep = source.slice(source.indexOf("async function draftChatPrep("), source.indexOf("function normalizeStaffBookingAction", source.indexOf("async function draftChatPrep(")));
  assert.match(prep, /filter\(x => x\.n > 0\)\.slice\(0, 20\)/);
  assert.match(prep, /rulesBlock\(rel, 16000\)/);
  assert.match(prep, /normalizeDraftEditHistory\(requestedEdits\)/);
  const routes = source.slice(source.indexOf('app.post("/api/draft-chat"'), source.indexOf("function staffAppointmentById", source.indexOf('app.post("/api/draft-chat"')));
  assert.match(routes, /reviewDraftChatCandidate\(t, p, out\.draft\)/);
  assert.match(routes, /reviewDraftChatCandidate\(t, p, match\[2\]\)/);
  assert.doesNotMatch(routes, /aiChatStream\(/);
});

test("相談への返事は患者向け下書きを作らず、返信だけのストリームを受け付ける", async () => {
  const routeStart = source.indexOf('app.post("/api/draft-chat"');
  const routeEnd = source.indexOf("function staffAppointmentById", routeStart);
  const handlers = new Map();
  const saved = [];
  const context = {
    app: { post: (route, ...handlersForRoute) => handlers.set(route, handlersForRoute.at(-1)) },
    guard() {}, oneMutationAtATime: () => (_req, _res, next) => next(),
    ANTHROPIC_KEY: "test", process: { env: {} },
    draftChatPrep: async () => ({ c: { channel: "line" }, consultation: true, base: "", edits: [], engLabel: "テスト", topicTs: 1 }),
    aiChat: async () => "@@REPLY@@\nキャンセル料は店舗ルールを確認してください。",
    reviewDraftChatCandidate: async () => { throw new Error("consultation must not review a draft"); },
    saveDraftChatSession: async (_t, _p, _body, text, kind) => { saved.push({ text, kind }); return true; },
    normalizeStaffBookingAction: () => null,
    DRAFTCHAT_MEMORY_RULE: "", DRAFTCHAT_RULE_RULE: "",
  };
  vm.runInNewContext(source.slice(routeStart, routeEnd), context);
  let output = "";
  const response = { setHeader() {}, write(text) { output += text; }, end() {}, status() { return this; } };
  await handlers.get("/api/draft-chat-stream")({ tenant: {}, body: { id: "テスト会話", messages: [] } }, response);
  assert.match(output, /キャンセル料は店舗ルールを確認してください/);
  assert.match(output, /"ok":true/);
  assert.doesNotMatch(output, /invalid_edit_response/);
  assert.deepEqual(saved, [{ text: "キャンセル料は店舗ルールを確認してください。", kind: "reply" }]);
  const unwantedDraft = "@@REPLY@@\n確認が必要です。\n@@DRAFT@@\n今回のキャンセルに充当いたします。\n@@ACTION@@\n{\"type\":\"none\"}";
  const stripped = await context.finalizeDraftChatEnvelope({}, unwantedDraft, { consultation: true });
  assert.match(stripped, /確認が必要です/);
  assert.doesNotMatch(stripped, /充当いたします/);
});

test("相談のJSON回答にAIが旧下書きを含めても、患者向け案として採用しない", async () => {
  const routeStart = source.indexOf('app.post("/api/draft-chat"');
  const routeEnd = source.indexOf("function staffAppointmentById", routeStart);
  const handlers = new Map();
  const context = {
    app: { post: (route, ...handlersForRoute) => handlers.set(route, handlersForRoute.at(-1)) },
    guard() {}, oneMutationAtATime: () => (_req, _res, next) => next(),
    ANTHROPIC_KEY: "test", process: { env: {} },
    draftChatPrep: async () => ({ c: { channel: "line" }, consultation: true, base: "", edits: [], engLabel: "テスト", topicTs: 1 }),
    aiChat: async () => JSON.stringify({ reply: "確認が必要です", draft: "患者様へ確約する誤った案", action: { type: "none" } }),
    reviewDraftChatCandidate: async (_t, p, draft) => ({ text: p.consultation ? "" : draft, error: "" }),
    saveDraftChatSession: async () => true, normalizeStaffBookingAction: () => null,
    DRAFTCHAT_MEMORY_RULE: "", DRAFTCHAT_RULE_RULE: "",
  };
  vm.runInNewContext(source.slice(routeStart, routeEnd), context);
  let result;
  await handlers.get("/api/draft-chat")({ tenant: {}, body: { id: "テスト会話", messages: [] } }, { json(value) { result = value; } });
  assert.equal(result.ok, true);
  assert.equal(result.draft, "");
  assert.match(result.reply, /確認が必要です/);
});

test("編集履歴は会話単位で保存され、一覧に一括で含めない", () => {
  assert.match(source, /app\.get\("\/api\/draft-chat-history", guard/);
  assert.match(source, /p\.c\.draftChatSession = \{ topicTs: p\.topicTs, messages: messages\.slice\(-20\)/);
  assert.match(source, /const \{ draftChatSession, \.\.\.publicConversation \} = c/);
});

test("監査や通信が失敗したらスタッフの入力を残して再試行できる", () => {
  const ui = source.slice(source.indexOf("async function dSend()"), source.indexOf("// ---- 右腕くん (rulebook editing chat)", source.indexOf("async function dSend()")));
  assert.match(ui, /function restoreFailedInput\(\)[\s\S]*?dHist\.pop\(\)[\s\S]*?x\.value=txt;dComposerDrafts\[owner\]=txt/);
  assert.match(ui, /if\(meta\.ok===false\)[\s\S]*?restoreFailedInput\(\)/);
  assert.match(ui, /通信エラーが発生しました[\s\S]*?restoreFailedInput\(\)/);
});

test("編集履歴は患者の新着後に旧話題へ上書きせず、同じ話題なら復元する", async () => {
  const sessionStart = source.indexOf('app.get("/api/draft-chat-history"');
  const sessionEnd = source.indexOf("function normalizeStaffBookingAction", sessionStart);
  const handlers = new Map();
  let saves = 0;
  const context = {
    app: { get: (route, _guard, handler) => handlers.set(route, handler) },
    guard() {},
    dbSave: async () => { saves += 1; return true; },
  };
  vm.runInNewContext(source.slice(sessionStart, sessionEnd), context);
  const c = { id: "テスト会話", ts: 100 };
  const t = { store: { [c.id]: c } };
  const body = { messages: [
    { role: "assistant", content: "確認いたします", kind: "draft" },
    { role: "user", content: "キャンセルに充てる" },
  ] };
  const saved = await context.saveDraftChatSession(t, { c, topicTs: 100 }, body, "キャンセルに充当いたします", "draft");
  assert.equal(saved, true);
  assert.equal(saves, 1);
  assert.equal(c.draftChatSession.messages.at(-1).content, "キャンセルに充当いたします");
  let response;
  handlers.get("/api/draft-chat-history")({ tenant: t, query: { id: c.id } }, { json: value => { response = value; } });
  assert.equal(response.messages.length, 3);
  assert.equal(response.draftAtSave, "");
  c.ts = 101;
  handlers.get("/api/draft-chat-history")({ tenant: t, query: { id: c.id } }, { json: value => { response = value; } });
  assert.equal(response.messages.length, 0);
  assert.equal(await context.saveDraftChatSession(t, { c, topicTs: 100 }, body, "古い案", "draft"), false);
  assert.equal(saves, 1);
});
