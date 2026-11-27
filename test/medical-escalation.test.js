"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const med = require("../lib/medical-escalation");
const { explicitEditMismatch } = require("../lib/draft-edit");
const { REPLY_DECISION } = require("../lib/reply-decision");
const consultation = require("../lib/draft-consultation");
const { PATIENT_COURTESY } = require("../lib/reply-tone");

const source = fs.readFileSync(path.join(__dirname, "..", "migiude.js"), "utf8");
const LIP_Q = "テスト：本日ホワイトニングをした際に上唇が白く変色し、現在上唇に腫れとヒリヒリ感があります。病院に行くべきでしょうか？";
const STAFF = "テスト：ジェルが唇に触れた一時的な炎症で、数日から2週間で治るので大丈夫と伝えて。注意していても起きることがあるのでお詫びして、念のため歯磨きとうがいをしてもらって";
const ADDED = "ご連絡いただき、ありがとうございます。ご不安をおかけし、申し訳ございません。\n\nホワイトニングの薬剤が唇に触れたことによる一時的な炎症で、数日〜2週間ほどで落ち着いてまいります。\n念のため、歯磨きとうがいをお願いいたします。\n\n腫れが広がる、強い痛みが続く場合は、本日中に医療機関へご相談ください。息苦しさや飲み込みにくさがある場合は、すぐに119番へご連絡ください。\n\nどうぞお大事になさってくださいませ。";

test("テスト：受診・救急の案内に当たる文だけを見分け、証明書・当院の案内・金額は対象にしない", () => {
  for (const s of ["早めに医療機関へご相談ください。", "すぐに119番へご連絡ください。", "#7119の救急相談窓口へお電話ください。", "念のため皮膚科を受診してください。", "夜間の救急相談窓口をご利用ください。", "症状が続く場合は受診をご検討ください。"]) {
    assert.equal(med.isEscalationSentence(s), true, s);
  }
  for (const s of ["予約日前日に医療機関を受診したことが確認できる証明書類をご提出ください。", "当院の医師が確認のうえご連絡いたします。", "料金は11,900円です。", "当院を受診いただく際はご予約ください。", "数日〜2週間ほどで落ち着いてまいります。"]) {
    assert.equal(med.isEscalationSentence(s), false, s);
  }
});

test("テスト：スタッフが指示した時・命に関わる症状の連絡の時だけ受診・救急の案内を認め、否定の指示は数えない", () => {
  assert.equal(med.escalationAllowed({ staffTexts: [STAFF], patientText: LIP_Q }), false);
  assert.equal(med.escalationAllowed({ staffTexts: ["テスト：病院に行かなくても大丈夫と伝えて"], patientText: LIP_Q }), false);
  assert.equal(med.escalationAllowed({ staffTexts: ["テスト：受診は不要、数日で治るので"], patientText: LIP_Q }), false);
  assert.equal(med.escalationAllowed({ staffTexts: ["テスト：念のため皮膚科を受診するよう伝えて"], patientText: LIP_Q }), true);
  assert.equal(med.escalationAllowed({ staffTexts: [""], patientText: "テスト：施術後から息苦しくて、のどが腫れている感じがします" }), true);
  assert.equal(med.escalationAllowed({ staffTexts: [""], ruleText: "アナフィラキシーが疑われる場合は119番へ案内する", patientText: LIP_Q }), true);
});

test("テスト：指示にない受診・救急の文だけを取り除き、スタッフの説明・対処・お詫びは残す", () => {
  const r = med.stripUnrequestedEscalation(ADDED, { staffTexts: [STAFF], patientText: LIP_Q });
  assert.equal(r.removed.length, 2);
  assert.doesNotMatch(r.text, /119|医療機関|救急/);
  assert.match(r.text, /数日〜2週間ほどで落ち着いてまいります/);
  assert.match(r.text, /歯磨きとうがい/);
  assert.match(r.text, /申し訳ございません/);
  assert.doesNotMatch(r.text, /\n{3,}/);
  const kept = med.stripUnrequestedEscalation(ADDED, { staffTexts: ["テスト：悪化したら病院へ、と添えて"], patientText: LIP_Q });
  assert.equal(kept.text, ADDED);
});

function reviewer(replies) {
  const calls = [];
  const start = source.indexOf("async function reviewDraftChatCandidate(");
  const end = source.indexOf('app.post("/api/draft-chat"', start);
  const context = {
    ...consultation, ...med, explicitEditMismatch, REPLY_DECISION, PATIENT_COURTESY,
    finalizeGeneratedDraft: async (_t, text) => ({ text }),
    aiChat: async (_t, sys, messages, _limit, task) => { calls.push({ sys, messages, task }); return replies.shift(); },
    hasConversationalTone: () => false, cleanDraftText: x => String(x || "").trim(), draftQualityIssues: () => [],
  };
  vm.runInNewContext(source.slice(start, end), context);
  return { review: context.reviewDraftChatCandidate, calls };
}

function consult(extra) {
  return Object.assign({
    c: { channel: "line" }, latestInstruction: STAFF, previousDraft: "", lastQ: LIP_Q,
    staffHistory: "スタッフの指示: " + STAFF, escalationStaffText: STAFF, escalationRuleText: "", allowWarning: true, skipStylePass: true,
  }, extra || {});
}

test("テスト：照合AIが合格と返しても、スタッフ指示にない119番・受診案内の案は合格にせず、修正の指摘に理由を渡す", async () => {
  const fixed = ADDED.replace(/\n\n腫れが広がる[^\n]*\n\n/, "\n\n");
  const h = reviewer(['{"pass":true,"safety":false,"reason":"指示どおり"}', fixed, '{"pass":true,"safety":false,"reason":"指示どおり"}']);
  const r = await h.review({}, consult(), ADDED);
  assert.equal(r.text, fixed);
  assert.equal(r.warning, undefined);
  assert.match(h.calls[1].messages[0].content, /受診・救急の案内/);
  assert.match(h.calls[0].sys, /スタッフが指示した症状の説明・経過の見込み・対処・安心していただく言葉は医院としての案内/);
});

test("テスト：修正AIも119番・受診案内を足し続けたら、その文だけ取り除いて照合し直す", async () => {
  const h = reviewer(['{"pass":true,"safety":false}', ADDED, '{"pass":true,"safety":false}', '{"pass":true,"safety":false,"reason":"指示どおり"}']);
  const r = await h.review({}, consult(), ADDED);
  assert.doesNotMatch(r.text, /119|医療機関/);
  assert.match(r.text, /数日〜2週間ほどで落ち着いてまいります/);
  assert.equal(r.error, "");
});

test("テスト：スタッフが受診の案内を指示した時は、その案内を残す", async () => {
  const staff = "テスト：一時的な炎症と伝えて、念のため腫れが広がったら医療機関へ相談するよう添えて";
  const h = reviewer(['{"pass":true,"safety":false,"reason":"指示どおり"}']);
  const r = await h.review({}, consult({ latestInstruction: staff, staffHistory: "スタッフの指示: " + staff, escalationStaffText: staff }), ADDED);
  assert.equal(r.text, ADDED);
});

test("テスト：生成と照合のプロンプトに、医院としての案内を優先し受診・救急を勝手に足さない方針を入れる", () => {
  const genStart = source.indexOf("async function genDraft(");
  const gen = source.slice(genStart, source.indexOf("\n}\n", genStart));
  assert.match(gen, /MEDICAL_GUIDANCE_POLICY/);
  assert.match(gen, /stripUnrequestedEscalation\(out\.draft, escalationInput\)/);
  const prepStart = source.indexOf("async function draftChatPrep(");
  const prep = source.slice(prepStart, source.indexOf('app.get("/api/draft-chat-history"', prepStart));
  assert.match(prep, /MEDICAL_GUIDANCE_POLICY \+ STAFF_MEDICAL_INSTRUCTION/);
  assert.match(prep, /escalationStaffText: \[requestedEdits\.filter\(m => m\.role === "user"\)/);
  assert.match(med.MEDICAL_GUIDANCE_POLICY, /この医院自体が医療機関/);
  assert.match(PATIENT_COURTESY, /スタッフが指示した症状の説明・経過の見込み・安心していただく言葉は根拠のある医院の案内/);
});
