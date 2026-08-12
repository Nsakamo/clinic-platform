const test = require("node:test");
const assert = require("node:assert/strict");
const { TOPIC_GAP_MS, selectConversationContext } = require("../lib/conversation-context");

const msg = (from, text, at) => ({ from, text, at });

test("短い間隔の会話は同じ現在話題として読む", () => {
  const base = Date.now();
  const result = selectConversationContext({ msgs: [
    msg("them", "今日予約できますか", base), msg("us", "希望時間を教えてください", base + 1000),
    msg("them", "17時希望です", base + 2000),
  ] });
  assert.equal(result.current.length, 3);
  assert.equal(result.olderRelevant.length, 0);
});

test("長い時間差がある別話題は最新回答の材料から外す", () => {
  const base = Date.now();
  const result = selectConversationContext({ msgs: [
    msg("them", "おととい今日予約できますか", base), msg("us", "ご案内します", base + 1000),
    msg("them", "今日は何時まで営業していますか", base + TOPIC_GAP_MS + 2000),
  ] });
  assert.deepEqual(result.current.map(item => item.text), ["今日は何時まで営業していますか"]);
  assert.equal(result.olderRelevant.length, 0);
});

test("長い時間差があっても過去説明を参照する質問なら関連部分だけ補助的に読む", () => {
  const base = Date.now();
  const result = selectConversationContext({ msgs: [
    msg("them", "キャンセル方法を教えてください", base), msg("us", "マイページから変更できます", base + 1000),
    msg("them", "先日説明いただいたキャンセル方法の続きですが、ボタンはどこですか", base + TOPIC_GAP_MS + 2000),
  ] });
  assert.equal(result.current.length, 1);
  assert.equal(result.olderRelevant.length, 2);
});

test("時刻を持たない旧履歴は互換性を保って直近文脈として扱う", () => {
  const result = selectConversationContext({ msgs: [msg("them", "質問1"), msg("us", "回答1"), msg("them", "質問2")] });
  assert.equal(result.current.length, 3);
});
