"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { PATIENT_COURTESY, applyCourtesyGate, hasConversationalTone, normalizeReplyTone, replyToneInstruction, toneRewriteInstruction } = require("../lib/reply-tone");

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
  assert.match(block, /患者様への礼儀は個別のトーン設定より優先/);
  assert.match(block, /店舗ルール、確認済み情報、安全上の制約、出力形式を上書きしてはいけません/);
  assert.match(block, /非常に相手に寄り添い、丁寧に返信してください/);
});

test("標準文体は患者様への礼儀を求め、馴れ馴れしい相づちを検出する", () => {
  assert.match(PATIENT_COURTESY, /礼儀正しく/);
  assert.match(PATIENT_COURTESY, /お問い合わせの内容を正確に受け止め/);
  for (const text of [
    "保定装置がある中でのホワイトニングは、気になりますよね。",
    "気になりますよね、状態を確認いたします。",
    "ご心配ですよね!",
    "ご心配ですよね?",
    "気になりますよね😊",
    "ご不安ですよね〜",
    "ご心配ですよね」",
    "気になりますよね～",
    "ご心配ですよね♪",
    "気になりますね。",
    "ご心配ですね。",
    "ご不安になりますね。",
  ]) assert.equal(hasConversationalTone(text), true, text);
  for (const text of [
    "固定式の保定装置が歯の裏側にある場合は、状態を確認してご案内いたします。",
    "ご不安な点がございましたら、お知らせください。",
    "ご心配な場合は、担当者にご相談ください。",
  ]) assert.equal(hasConversationalTone(text), false, text);
});

function qualityFunctions(aiReply) {
  const source = fs.readFileSync(path.join(__dirname, "..", "migiude.js"), "utf8");
  const start = source.indexOf("function cleanDraftText(raw){");
  const end = source.indexOf("// 出力が途中で切れる", start);
  assert.ok(start > 0 && end > start);
  return vm.runInNewContext(source.slice(start, end) + "\n({finalizeGeneratedDraft,validateDraftAgainstEvidence})", {
    S: () => ({ tone: "" }), aiChat: async () => aiReply,
    PATIENT_COURTESY, hasConversationalTone, normalizeReplyTone, replyToneInstruction, toneRewriteInstruction,
  });
}

test("初回下書きの口語表現は校正失敗・再発時に残してスタッフ確認へ回す", async () => {
  const original = "保定装置がある中でのホワイトニングは、気になりますよね。状態を確認いたします。";
  for (const reply of [null, "気になりますよね、状態を確認いたします。"] ) {
    const result = await qualityFunctions(reply).finalizeGeneratedDraft({}, original, "line");
    assert.equal(result.text, original);
    assert.ok(result.issues.includes("conversational_tone"));
  }
  const clean = await qualityFunctions("保定装置の状態を確認したうえでご案内いたします。").finalizeGeneratedDraft({}, original, "line");
  assert.equal(clean.text, "保定装置の状態を確認したうえでご案内いたします。");
  assert.equal(clean.issues.includes("conversational_tone"), false);
  const originalState = { needs_human: false };
  assert.strictEqual(applyCourtesyGate(originalState, clean.issues), originalState);
  assert.equal(originalState.needs_human, false);
  assert.strictEqual(applyCourtesyGate(originalState, ["conversational_tone"]), originalState);
  assert.equal(originalState.needs_human, true);
});

test("送信前監査は口語の修正案を捨て、元の文が口語なら送信を止める", async () => {
  const reply = (revised, unsupported = []) => JSON.stringify({ pass: true, answered: true, natural: true, revised_draft: revised, unsupported_claims: unsupported, contradictions: [], reason: "内容を確認しました" });
  const base = { query: "保定装置のままホワイトニングできますか", draft: "状態を確認したうえでご案内いたします。" };
  const revisedOnly = await qualityFunctions(reply("気になりますよね。状態を確認いたします。")).validateDraftAgainstEvidence({}, base);
  assert.equal(revisedOnly.pass, true);
  assert.equal(revisedOnly.revisedDraft, "");
  const original = await qualityFunctions(reply("")).validateDraftAgainstEvidence({}, { ...base, draft: "気になりますよね。状態を確認いたします。" });
  assert.equal(original.pass, false);
  assert.match(original.reason, /文体にスタッフ確認/);
  const unsupported = await qualityFunctions(reply("", ["根拠のない施術可否"])).validateDraftAgainstEvidence({}, { ...base, draft: "気になりますよね。施術可能です。" });
  assert.equal(unsupported.pass, false);
  assert.match(unsupported.reason, /根拠や内容に確認/);
  assert.match(unsupported.reason, /文体にスタッフ確認/);
});

test("初回生成から自動送信判定まで口語のままなら送信候補にしない", async () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "migiude.js"), "utf8");
  const qualityStart = source.indexOf("function cleanDraftText(raw){");
  const qualityEnd = source.indexOf("// 出力が途中で切れる", qualityStart);
  const draftStart = source.indexOf("async function genDraft(t, c, opts) {");
  const draftEnd = source.indexOf("// 毎回承認モード", draftStart);
  assert.ok(qualityStart > 0 && qualityEnd > qualityStart && draftStart > qualityEnd && draftEnd > draftStart);
  let calls = 0;
  const functions = vm.runInNewContext(source.slice(qualityStart, qualityEnd) + source.slice(draftStart, draftEnd) + "\n({genDraft})", {
    PATIENT_COURTESY, JP_QUALITY: PATIENT_COURTESY,
    hasConversationalTone, applyCourtesyGate, normalizeReplyTone, replyToneInstruction, toneRewriteInstruction,
    S: () => ({ tone: "", prefs: [] }), activeConversationMessages: c => c.msgs,
    rulesRankedWithScores: () => [], rulesBlock: () => "", ruleBudget: () => 0,
    examplesRanked: () => [], trustedLearningPrecedent: () => false,
    prefsBlock: () => "", notesBlock: () => "", baEnabled: () => false,
    staffLineReviewAll: () => false, PARTNER_KEY: "",
    evaluateResponseGrounding: () => ({ autoSendAllowed: true, reasons: [], ruleRefs: [] }),
    applyLearningReadinessGate: () => ({}),
    aiChat: async () => ++calls === 1
      ? JSON.stringify({ draft: "保定装置は気になりますよね。状態を確認します。", confidence: "high", needs_human: false, is_urgent: false, site_alert: "none" })
      : null,
  });
  const result = await functions.genDraft({ name: "テスト医院" }, { channel: "line", msgs: [{ from: "them", text: "テスト：保定装置のままホワイトニングできますか" }] }, { skipExternal: true });
  assert.ok(result);
  assert.equal(result.needs_human, true);
  assert.equal(result.validation.skipped, true);
  assert.equal(result.validation.pass, false);
  assert.equal(result.grounding.autoSendAllowed, false);
  assert.match(result.grounding.reasons.join(" "), /文体にスタッフ確認/);
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
  assert.match(source, /applyCourtesyGate\(out, finalized\.issues\)/);
  assert.match(source, /const courteous = !hasConversationalTone\(revisedDraft \|\| input\.draft\)/);
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
