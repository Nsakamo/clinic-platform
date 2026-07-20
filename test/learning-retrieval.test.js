"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { intentTokens, rankLearningExamples, sameLearningExample } = require("../lib/learning-retrieval");

const NOW = Date.UTC(2026, 6, 19);

test("患者の質問が近い対応例を、定型敬語が似ているだけの例より優先する", () => {
  const examples = [
    { id: 1, q: "商品の発送はいつになりますか？", final: "お問い合わせありがとうございます。3営業日以内に発送します。", ts: NOW - 86400000 },
    { id: 2, q: "予約をキャンセルしたいです", final: "お問い合わせありがとうございます。承知いたしました。", ts: NOW },
  ];
  const ranked = rankLearningExamples(examples, "発送は何日くらいかかりますか？", 4, NOW);
  assert.equal(ranked[0].id, 1);
  assert.equal(ranked.some((item) => item.id === 2), false);
});

test("直前の短い質問だけで足りない場合は会話文脈も使う", () => {
  const examples = [
    { id: 1, q: "ホワイトニングの料金はいくらですか？", final: "料金は1回8,000円です。", ts: NOW },
    { id: 2, q: "駐車場はありますか？", final: "提携駐車場をご利用ください。", ts: NOW },
  ];
  const ranked = rankLearningExamples(examples, { latest: "それはいくらですか？", context: "ホワイトニングを検討しています。それはいくらですか？" }, 4, NOW);
  assert.equal(ranked[0].id, 1);
});

test("関係の薄い対応例はAIへ渡さない", () => {
  const examples = [
    { id: 1, q: "駐車場はありますか？", final: "あります。", ts: NOW },
    { id: 2, q: "支払い方法を教えてください", final: "カードをご利用いただけます。", ts: NOW },
  ];
  assert.deepEqual(rankLearningExamples(examples, "施術後に腫れがあります", 4, NOW), []);
});

test("似た問い合わせが複数ある場合は新しい確認済み例を1件だけ使う", () => {
  const examples = [
    { id: 1, q: "発送はいつですか？", final: "5営業日以内です。", ts: NOW - 30 * 86400000, confirmedCount: 1 },
    { id: 2, q: "発送はいつ頃ですか？", final: "3営業日以内です。", ts: NOW, confirmedCount: 3 },
  ];
  const ranked = rankLearningExamples(examples, "発送はいつ頃になりますか？", 4, NOW);
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].id, 2);
});

test("同じ質問と最終返信は重複例として判定する", () => {
  assert.equal(sameLearningExample(
    { q: "発送はいつですか？", final: "3営業日以内に発送します。" },
    { q: "発送はいつですか", final: "3営業日以内に発送します" },
  ), true);
});

test("表現が違っても同じ問い合わせ意図の対応例を取得する", () => {
  const examples = [
    { id: 1, q: "発送時期を教えてください", final: "3営業日以内に発送します。", ts: NOW },
    { id: 2, q: "駐車場はありますか", final: "提携駐車場があります。", ts: NOW },
  ];
  const ranked = rankLearningExamples(examples, "商品はいつ届きますか？", 4, NOW);
  assert.equal(ranked[0].id, 1);
  assert.equal(ranked.some((item) => item.id === 2), false);
});

test("クリニック対応で頻出する問い合わせ種類を意味分類する", () => {
  assert.equal(intentTokens("初めてですが予約を取りたいです").has("booking_new"), true);
  assert.equal(intentTokens("妊娠中でも受けられますか").has("eligibility"), true);
  assert.equal(intentTokens("来院時の持ち物を教えてください").has("preparation"), true);
  assert.equal(intentTokens("領収書を再発行できますか").has("documents"), true);
});
