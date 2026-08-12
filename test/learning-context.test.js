const test = require("node:test");
const assert = require("node:assert/strict");
const { contextualLearningFallback, formatLearningProposal } = require("../lib/learning-context");

test("短い『大丈夫』ではなく予約確認の判断手順へ一般化する", () => {
  const text = contextualLearningFallback({
    q: "キレイパス経由で8月20日17時からTHE DENTEにて予約しましたが問題ないでしょうか？ 会員IDは62354です",
    final: "大丈夫です",
    instr: "大丈夫",
  });
  assert.match(text, /キレイパスなどの外部予約サイト/);
  assert.match(text, /予約システム上の最新情報と照合/);
  assert.match(text, /確認できた場合のみ問題ない旨/);
  assert.doesNotMatch(text, /62354|8月20日|17時/);
  assert.notEqual(text.trim(), "大丈夫");
});

test("AIの学習提案を適用状況・確認・回答方針の形へ整える", () => {
  const fallback = contextualLearningFallback({ q: "予約を確認したい" });
  const text = formatLearningProposal({
    situation: "外部サイト経由の予約確認を求められたとき",
    checks: ["本人情報を確認する", "予約内容を照合する"],
    response: { verified: "確認できた場合だけ問題ない旨を伝える", unverified: "未確認なら断定しない" },
    exclusions: ["今回の会員IDは流用しない"],
  }, fallback);
  assert.match(text, /【適用する状況】/);
  assert.match(text, /【確認すること】/);
  assert.match(text, /【回答方針】/);
  assert.match(text, /【引き継がない情報】/);
  assert.match(text, /未確認なら断定しない/);
  assert.match(text, /【適用する状況】\n・外部サイト/);
  assert.match(text, /\n\n【確認すること】\n・本人情報/);
  assert.match(text, /・予約内容を照合する/);
  assert.doesNotMatch(text, /\[object Object\]/);
});

test("項目が欠けたAI提案は安全な既定案へ戻す", () => {
  const fallback = contextualLearningFallback({ q: "予約を確認したい" });
  assert.equal(formatLearningProposal({ situation: "予約確認" }, fallback), fallback);
});
