"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { normalizeReplyTone, replyToneInstruction, toneRewriteInstruction } = require("../lib/reply-tone");

test("空欄なら標準トーンのままにする", () => {
  assert.equal(replyToneInstruction("   "), "");
  assert.equal(toneRewriteInstruction("", "line"), "");
});

test("設定したトーンを参考情報ではなく返信全文の必須条件として渡す", () => {
  const block = replyToneInstruction("非常に相手に寄り添い、丁寧に返信してください。");
  assert.match(block, /最終回答の必須条件/);
  assert.match(block, /返信全文を書き直してください/);
  assert.match(block, /状況や気持ちを受け止める一言/);
  assert.match(block, /書き出し、説明、お願い、締めまで一貫/);
  assert.match(block, /店舗ルール、確認済み情報、安全上の制約、出力形式を上書きしてはいけません/);
  assert.match(block, /非常に相手に寄り添い、丁寧に返信してください/);
});

test("生成後の再確認でも事実を変えずにトーンを反映させる", () => {
  const instruction = toneRewriteInstruction("安心感のある丁寧な文章", "mail");
  assert.match(instruction, /事実・日時・料金・URL・可否・固有名詞/);
  assert.match(instruction, /メールの署名は残してください/);
  assert.match(instruction, /返信本文だけ/);
});

test("トーン設定は上限を超えてプロンプトへ入れない", () => {
  assert.equal(normalizeReplyTone("あ".repeat(1300)).length, 1200);
});

test("下書き・作り直し・送信前監査が共通のトーン指示と最終確認を使う", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "migiude.js"), "utf8");
  assert.ok((source.match(/replyToneInstruction\(S\(t\)\.tone/g) || []).length >= 5);
  assert.match(source, /toneRewriteInstruction\(tone, channel\)/);
  assert.match(source, /finalizeDraftChatEnvelope/);
  assert.doesNotMatch(source, /【トーン指示(?:（最優先）)?】/);
});
