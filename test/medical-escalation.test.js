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
const ADDED = "テスト：ご連絡いただき、ありがとうございます。ご不安をおかけし、申し訳ございません。\n\nホワイトニングの薬剤が唇に触れたことによる一時的な炎症で、数日〜2週間ほどで落ち着いてまいります。\n念のため、歯磨きとうがいをお願いいたします。\n\n腫れが広がる、強い痛みが続く場合は、本日中に医療機関へご相談ください。息苦しさや飲み込みにくさがある場合は、すぐに119番へご連絡ください。\n\nどうぞお大事になさってくださいませ。";

test("テスト：受診・救急の案内に当たる文だけを見分け、証明書・当院の案内・金額は対象にしない", () => {
  for (const s of ["早めに医療機関へご相談ください。", "すぐに119番へご連絡ください。", "#7119の救急相談窓口へお電話ください。", "念のため皮膚科を受診してください。", "症状が続く場合は受診をご検討ください。", "腫れが続く場合は皮膚科を受診してください。", "夜間の場合は、お近くの夜間診療をご利用ください。", "かかりつけの医療機関へご相談ください。", "すぐに受診してください。", "腫れが引かなければ、早めに受診してください。", "医師の診察を受けてください。", "救急で診てもらってください。", "当院ではなく、お近くの皮膚科を受診してください。", "悪化した場合は、すぐに医療機関にご連絡ください。", "万一の際は、ためらわず医療機関へご連絡ください。", "異常があれば医療機関へ。", "当院は本日休診のため、お近くの医療機関へご相談ください。", "症状が続く場合は、写真を添えて医療機関を受診してください。", "お近くの歯医者さんへご相談ください。", "119へお電話ください。"]) {
    assert.equal(med.isEscalationSentence("テスト：" + s), true, s);
  }
  for (const s of ["予約日前日に医療機関を受診したことが確認できる証明書類をご提出ください。", "当院の医師が確認のうえご連絡いたします。", "料金は11,900円です。", "料金は119,000円です。", "119分の施術です。", "救急セットをご用意しております。", "受診いただく際は保険証をお持ちください。", "ご予約いただいた日に受診してください。", "当院を受診いただく際はご予約ください。", "数日〜2週間ほどで落ち着いてまいります。", "医療機関を受診し、診断書をご提出ください。", "病院で発行された診断書をお送りください。", "病院を受診された際の処方箋の写真をお送りください。",
    "症状が続くようでしたら、再度ご来院のうえ受診してください。", "当院では夜間診療も行っております。", "当院は医療機関ですので、お気軽にご相談ください。", "保険診療をご希望の場合は、受診時に保険証をお持ちください。", "初めての場合は受診前に問診票のご記入をお願いいたします。", "当院の皮膚科でご相談ください。"]) {
    assert.equal(med.isEscalationSentence("テスト：" + s), false, s);
  }
});

test("テスト：照合AIへの手がかりは、受診・救急の文がある時だけ付け、例外（ア）〜（ウ）を確認させる", () => {
  assert.equal(med.escalationAuditHint("テスト：数日〜2週間ほどで落ち着いてまいります。"), "");
  const hint = med.escalationAuditHint(ADDED);
  assert.match(hint, /119番へご連絡ください/);
  assert.match(hint, /医療機関へご相談ください/);
  assert.match(hint, /（ア）スタッフが指示した/);
  assert.match(hint, /"escalation":true/);
  assert.match(hint, /命に関わる緊急の症状/);
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
    isStyleOnlyInstruction: () => true, preservesReplyFacts: () => true, decisionTermsPreserved: () => true, styleEditPreservesContent: () => true,
    sentenceCount: x => String(x || "").split("。").length, borrowsFromSamples: () => false,
  };
  vm.runInNewContext(source.slice(start, end), context);
  return { review: context.reviewDraftChatCandidate, calls };
}

function consult(extra) {
  return Object.assign({
    c: { channel: "line" }, latestInstruction: STAFF, previousDraft: "", lastQ: LIP_Q,
    staffHistory: "スタッフの指示: " + STAFF, escalationCheck: true, allowWarning: true, skipStylePass: true,
  }, extra || {});
}

test("テスト：相談の照合では受診・救急の文を照合AIへ示し、不合格なら修正し直した案を返す（機械では削除しない）", async () => {
  const fixed = ADDED.replace(/\n\n腫れが広がる[^\n]*\n\n/, "\n\n");
  const h = reviewer(['{"pass":false,"safety":false,"reason":"スタッフの指示にない受診・救急の案内：119番へご連絡ください"}', fixed, '{"pass":true,"safety":false,"reason":"指示どおり"}']);
  const r = await h.review({}, consult(), ADDED);
  assert.equal(r.text, fixed);
  assert.equal(r.warning, undefined);
  assert.match(h.calls[0].messages[0].content, /【確認：下書きにある受診・救急の案内】[\s\S]*119番へご連絡ください/);
  assert.match(h.calls[0].sys, /この医院自体が医療機関/);
  assert.match(h.calls[0].sys, /スタッフが指示した症状の説明・経過の見込み・対処・安心していただく言葉は医院としての案内/);
  assert.match(h.calls[1].sys, /方針の（ア）〜（ウ）に当たらないものだけを削除し、当たるものは残す/);
  assert.match(h.calls[1].sys, /この医院自体が医療機関/);
  assert.doesNotMatch(h.calls[2].messages[0].content, /【確認：下書きにある受診・救急の案内】/);
});

test("テスト：最初の案が指示にない受診・救急の案内で不合格なら、修正案が別の理由で落ちても最初の案を返さない", async () => {
  const fixed = ADDED.replace(/\n\n腫れが広がる[^\n]*\n\n/, "\n\n");
  const h = reviewer(['{"pass":false,"safety":false,"escalation":true,"reason":"スタッフの指示にない受診・救急の案内"}', fixed, '{"pass":false,"safety":false,"reason":"お詫びの表現が弱い"}']);
  const r = await h.review({}, consult(), ADDED);
  assert.equal(r.text, fixed);
  assert.match(r.warning, /お詫びの表現が弱い/);
  // 修正AIが応答しなかった時は、119番入りの最初の案を表示しない
  const h2 = reviewer(['{"pass":false,"safety":false,"escalation":true,"reason":"スタッフの指示にない受診・救急の案内"}', null]);
  const r2 = await h2.review({}, consult(), ADDED);
  assert.equal(r2.text, "");
  assert.match(r2.error, /編集指示を正確に反映できませんでした/);
  // 理由の文に「受診・救急の案内」とあるだけでは escalation 扱いにしない（指示どおりの最初の案を使える）
  const h3 = reviewer(['{"pass":false,"safety":false,"reason":"受診・救急の案内は適切。お詫びが弱い"}', "テスト：別の案です。", '{"pass":false,"safety":false,"reason":"指示から離れた"}']);
  assert.equal((await h3.review({}, consult(), ADDED)).text, ADDED);
});

test("テスト：受診・救急を足さない文には、店舗ルールの明記と命に関わる症状の例外を必ず付ける", () => {
  const { STAFF_DRAFT_POLICY } = consultation;
  assert.match(med.MEDICAL_GUIDANCE_POLICY, /（ウ）患者様の連絡に命に関わる緊急の症状/);
  assert.match(med.MEDICAL_GUIDANCE_POLICY, /（ウ）の時は、スタッフが大丈夫と伝えるよう指示していても、スタッフの説明を保ったうえで救急の案内を添え/);
  assert.match(med.MEDICAL_GUIDANCE_POLICY, /証明書・診断書など提出物の案内は、受診や救急の案内に当たらない/);
  assert.match(med.STAFF_MEDICAL_INSTRUCTION, /（イ）（ウ）の時を除く/);
  assert.match(STAFF_DRAFT_POLICY, /受診・救急の案内[^。]*足さない（店舗ルールが今回の症状に明記している時と、患者様の連絡に命に関わる緊急の症状がある時を除く）/);
  assert.match(PATIENT_COURTESY, /受診や救急の案内を加えない（[^）]*命に関わる緊急の症状のいずれかがある時は加えてよい）/);
  const tone = source.match(/const STAFF_TONE_PRIORITY = "[^\n]*/)[0];
  assert.match(tone, /命に関わる緊急の症状のいずれかがある時は加えてよい/);
  assert.doesNotMatch(source, /下の方針の/);
  assert.match(source, /（ウ）に当たる（患者様の連絡に命に関わる緊急の症状がある）のに救急の案内が無い/);
  assert.match(source, /そのまま書かれていることを理由に不合格にしない（（ウ）に当たるのに救急の案内が無い時を除く/);
  assert.match(med.MEDICAL_GUIDANCE_POLICY, /受診や救急の案内を足さない（（イ）（ウ）の時を除く）/);
  assert.match(med.STAFF_MEDICAL_INSTRUCTION, /そのまま丁寧な文にする（上の方針の（ウ）の時は、説明を保ったうえで救急の案内を添える）/);
  const regen = source.slice(source.indexOf('app.post("/api/ai-regen"'), source.indexOf('app.post("/api/ai-regen"') + 4000);
  assert.match(regen, /MEDICAL_GUIDANCE_POLICY \+ STAFF_MEDICAL_INSTRUCTION/);
});

test("テスト：修正後の案も指示にない受診・救急の案内や安全面で不合格なら、確認ポイント付きでも表示しない", async () => {
  const other = "テスト：一時的な炎症です。念のため皮膚科を受診してください。";
  const h = reviewer(['{"pass":false,"safety":false,"escalation":true,"reason":"指示にない受診案内"}', other, '{"pass":false,"safety":false,"escalation":true,"reason":"指示にない受診案内（皮膚科）"}']);
  const r = await h.review({}, consult(), ADDED);
  assert.equal(r.text, "");
  assert.match(r.error, /編集指示を正確に反映できませんでした/);
  // （ウ）の救急案内が欠けて safety:true、修正AIが応答しない時も、救急案内の無い最初の案を返さない
  const h2 = reviewer(['{"pass":false,"safety":true,"reason":"息苦しさがあるのに救急案内が無い"}', null]);
  const r2 = await h2.review({}, consult({ lastQ: "テスト：さっきから息が苦しいです" }), "テスト：一時的な炎症で大丈夫です。");
  assert.equal(r2.text, "");
  assert.match(r2.error, /編集指示を正確に反映できませんでした/);
});

test("テスト：受診が不要と伝える文は、照合AIへ案内に当たらないと示す", () => {
  const hint = med.escalationAuditHint("テスト：病院へ行かれる必要はございません。");
  assert.match(hint, /受診・救急が不要と伝える文（例:『病院へ行かれる必要はございません』）[^。]*この理由で不合格にしない/);
});

test("テスト：照合AIが例外に当たると判断した受診・救急の案内（スタッフ指示・命に関わる症状）は、そのまま残す", async () => {
  const h = reviewer(['{"pass":true,"safety":false,"reason":"患者が息苦しさを訴えているため救急案内は適切"}']);
  const r = await h.review({}, consult({ lastQ: "テスト：さっきから息が苦しいです" }), ADDED);
  assert.equal(r.text, ADDED);
});

test("テスト：受診・救急の文がある時は、文体だけの指示でも照合を省かない", async () => {
  const h = reviewer(['{"pass":true,"safety":false}']);
  const r = await h.review({}, consult({ latestInstruction: "テスト：もっと丁寧に", previousDraft: ADDED, styleFastPath: true }), ADDED);
  assert.equal(h.calls.length, 1);
  assert.equal(r.fastPath, undefined);
  const plain = ADDED.replace(/\n\n腫れが広がる[^\n]*\n\n/, "\n\n");
  const h2 = reviewer([]);
  const r2 = await h2.review({}, consult({ latestInstruction: "テスト：もっと丁寧に", previousDraft: plain, styleFastPath: true }), plain);
  assert.equal(r2.fastPath, true);
  assert.equal(h2.calls.length, 0);
});

test("テスト：スタッフ指示のない経路（自動下書きの感染症の確認など）では、照合AIへ受診・救急の手がかりを付けない", async () => {
  const h = reviewer(['{"pass":true,"safety":false,"reason":"指示どおり"}']);
  const r = await h.review({}, consult({ escalationCheck: undefined, allowWarning: undefined, staffHistory: "" }), ADDED);
  assert.equal(r.text, ADDED);
  assert.doesNotMatch(h.calls[0].messages[0].content, /【確認：下書きにある受診・救急の案内】/);
});

test("テスト：生成と照合のプロンプトに、医院としての案内を優先し受診・救急を勝手に足さない方針を入れる", () => {
  const genStart = source.indexOf("async function genDraft(");
  const gen = source.slice(genStart, source.indexOf("\n}\n", genStart));
  assert.match(gen, /MEDICAL_GUIDANCE_POLICY/);
  assert.doesNotMatch(gen, /escalationAuditHint|escalationCheck/); // 自動下書きは方針文だけ
  const prepStart = source.indexOf("async function draftChatPrep(");
  const prep = source.slice(prepStart, source.indexOf('app.get("/api/draft-chat-history"', prepStart));
  assert.match(prep, /MEDICAL_GUIDANCE_POLICY \+ STAFF_MEDICAL_INSTRUCTION/);
  assert.match(prep, /escalationCheck: true,/);
  assert.match(med.MEDICAL_GUIDANCE_POLICY, /この医院自体が医療機関/);
  assert.match(PATIENT_COURTESY, /スタッフが指示した症状の説明・経過の見込み・安心していただく言葉は根拠のある医院の案内/);
  assert.doesNotMatch(source, /stripUnrequestedEscalation|unrequestedEscalation\(/); // 受診・救急の文を機械で削除しない
});
