"use strict";
// migiude.js の一部を vm で実行するテスト用に、プロンプト組み立ての補助関数の既定値を用意する。
// 各テストの文脈で同名の値を指定した場合はそちらが優先される（スプレッドの後ろに書くため）。
module.exports = function promptStubs() {
  return {
    promptRulesText: (_t, ranked) => (Array.isArray(ranked) ? ranked : []).map(r => String((r && r.content) || "")).join("\n"),
    formatLearnedExamples: () => "",
    LEARNED_EXAMPLES_K: 8,
    styleSamples: () => [],
    styleSamplesBlock: () => "",
    STAFF_TONE_PRIORITY: "【スタッフの口調指示の優先】",
    ruleBudget: () => 16000,
    examplesRanked: () => [],
    baContextCached: () => Promise.resolve(null),
  };
};
