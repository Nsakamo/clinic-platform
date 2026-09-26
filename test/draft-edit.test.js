"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { explicitEditMismatch } = require("../lib/draft-edit");

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
  const routes = source.slice(source.indexOf('app.post("/api/draft-chat"'), source.indexOf("function staffAppointmentById", source.indexOf('app.post("/api/draft-chat"')));
  assert.match(routes, /reviewDraftChatCandidate\(t, p, out\.draft\)/);
  assert.match(routes, /reviewDraftChatCandidate\(t, p, match\[2\]\)/);
  assert.doesNotMatch(routes, /aiChatStream\(/);
});

test("編集履歴は会話単位で保存され、一覧に一括で含めない", () => {
  assert.match(source, /app\.get\("\/api\/draft-chat-history", guard/);
  assert.match(source, /p\.c\.draftChatSession = \{ topicTs: p\.topicTs, messages: messages\.slice\(-20\)/);
  assert.match(source, /const \{ draftChatSession, \.\.\.publicConversation \} = c/);
});

test("監査や通信が失敗したらスタッフの入力を残して再試行できる", () => {
  const ui = source.slice(source.indexOf("async function dSend()"), source.indexOf("// ---- 右腕くん (rulebook editing chat)", source.indexOf("async function dSend()")));
  assert.match(ui, /if\(meta\.ok===false\)[\s\S]*?x\.value=txt;dComposerDrafts\[owner\]=txt/);
  assert.match(ui, /通信エラーが発生しました[\s\S]*?x\.value=txt;dComposerDrafts\[owner\]=txt/);
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
  c.ts = 101;
  handlers.get("/api/draft-chat-history")({ tenant: t, query: { id: c.id } }, { json: value => { response = value; } });
  assert.equal(response.messages.length, 0);
  assert.equal(await context.saveDraftChatSession(t, { c, topicTs: 100 }, body, "古い案", "draft"), false);
  assert.equal(saves, 1);
});
