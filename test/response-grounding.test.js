"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { evaluateResponseGrounding } = require("../lib/response-grounding");

test("一般的な挨拶は事実根拠がなくても自動送信候補にできる", () => {
  const result = evaluateResponseGrounding({ query: "ありがとうございます", draft: "ご連絡ありがとうございます。" });
  assert.equal(result.autoSendAllowed, true);
});

test("料金の回答は関連店舗ルールがなければ自動送信しない", () => {
  const result = evaluateResponseGrounding({ query: "料金はいくらですか", draft: "料金は5,000円です。" });
  assert.equal(result.autoSendAllowed, false);
  assert.match(result.reasons.join(" "), /料金・金額/);
});

test("過去対応例だけでは料金の根拠にならない", () => {
  const result = evaluateResponseGrounding({ query: "送料はいくらですか", draft: "送料は500円です。", learningExampleCount: 3 });
  assert.equal(result.autoSendAllowed, false);
  assert.ok(result.sources.includes("過去対応例（文章・手順の参考のみ）"));
});

test("関連店舗ルールがある料金案内は決定的ゲートを通る", () => {
  const result = evaluateResponseGrounding({
    query: "キャンセル料はいくらですか",
    draft: "前日のキャンセル料は1,100円です。",
    ruleMatches: [{ id: 2, title: "キャンセル料", overlap: 4, score: 0.5 }],
  });
  assert.equal(result.autoSendAllowed, true);
  assert.ok(result.sources.includes("店舗ルール"));
});

test("空き枠の断定はリアルタイム照会がなければ自動送信しない", () => {
  const blocked = evaluateResponseGrounding({ query: "明日15時は空いていますか", draft: "15時は空いております。" });
  const allowed = evaluateResponseGrounding({ query: "明日15時は空いていますか", draft: "15時は空いております。", verifiedSlots: true });
  assert.equal(blocked.autoSendAllowed, false);
  assert.equal(allowed.autoSendAllowed, true);
});

test("症状問い合わせと医療的な安全断定は必ずスタッフ確認へ回す", () => {
  const result = evaluateResponseGrounding({ query: "施術後に腫れと痛みがあります", draft: "問題ありません。様子を見てください。" });
  assert.equal(result.autoSendAllowed, false);
  assert.match(result.reasons.join(" "), /医療|安全断定/);
});
