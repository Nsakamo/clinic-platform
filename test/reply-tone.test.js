"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { PATIENT_COURTESY, hasConversationalTone, normalizeReplyTone, replyToneInstruction, toneRewriteInstruction } = require("../lib/reply-tone");

test("空欄なら標準トーンのままにする", () => {
  assert.equal(replyToneInstruction("   "), "");
  assert.equal(toneRewriteInstruction("", "line"), "");
});

test("設定したトーンを参考情報ではなく返信全文の必須条件として渡す", () => {
  const block = replyToneInstruction("非常に相手に寄り添い、丁寧に返信してください。");
  assert.match(block, /最終回答の必須条件/);
  assert.match(block, /返信全文を書き直してください/);
  assert.match(block, /気持ちを決めつける/);
  assert.match(block, /気になりますよね/);
  assert.match(block, /書き出しから締めまで一貫/);
  assert.match(block, /店舗ルール、確認済み情報、安全上の制約、出力形式を上書きしてはいけません/);
  assert.match(block, /非常に相手に寄り添い、丁寧に返信してください/);
});

test("標準文体は患者様への礼儀を求め、馴れ馴れしい相づちを検出する", () => {
  assert.match(PATIENT_COURTESY, /礼儀正しく/);
  assert.match(PATIENT_COURTESY, /お問い合わせの内容を正確に受け止め/);
  assert.equal(hasConversationalTone("保定装置がある中でのホワイトニングは、気になりますよね。"), true);
  assert.equal(hasConversationalTone("ご心配ですよね。確認いたします。"), true);
  assert.equal(hasConversationalTone("固定式の保定装置が歯の裏側にある場合は、状態を確認してご案内いたします。"), false);
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
  assert.ok((source.match(/replyToneInstruction\(S\(t\)\.tone/g) || []).length >= 7);
  assert.match(source, /toneRewriteInstruction\(tone, channel\)/);
  assert.match(source, /finalizeDraftChatEnvelope/);
  assert.match(source, /const JP_QUALITY = .*PATIENT_COURTESY/);
  assert.match(source, /if \(finalized\.issues\.includes\("conversational_tone"\)\) out\.needs_human = true/);
  assert.match(source, /const courteous = !hasConversationalTone\(candidateDraft \|\| input\.draft\)/);
  assert.doesNotMatch(source, /【トーン指示(?:（最優先）)?】/);
});

test("スタッフLINEの返信修正にも共通トーン指示と生成後の確認を適用する", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "migiude.js"), "utf8");
  const start = source.indexOf("async function staffLineReviseDraft");
  const end = source.indexOf("const staffLineInFlight", start);
  const body = source.slice(start, end);
  assert.match(body, /replyToneInstruction\(S\(t\)\.tone\)/);
  assert.match(body, /finalizeGeneratedDraft\(t, out, c\.channel\)/);
});

test("品質テストは最終トーン確認が成功した場合だけ確認済みと返す", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "migiude.js"), "utf8");
  assert.match(source, /toneApplied:Array\.isArray\(out\.qualityIssues\)&&out\.qualityIssues\.includes\("tone_reviewed"\)/);
  assert.doesNotMatch(source, /toneApplied:!!normalizeReplyTone/);
});
