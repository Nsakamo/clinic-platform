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
  for (const s of ["早めに医療機関へご相談ください。", "すぐに119番へご連絡ください。", "#7119の救急相談窓口へお電話ください。", "念のため皮膚科を受診してください。", "症状が続く場合は受診をご検討ください。", "腫れが続く場合は皮膚科を受診してください。", "夜間の場合は、お近くの夜間診療をご利用ください。", "かかりつけの医療機関へご相談ください。", "すぐに受診してください。", "腫れが引かなければ、早めに受診してください。", "医師の診察を受けてください。", "救急で診てもらってください。", "当院ではなく、お近くの皮膚科を受診してください。", "悪化した場合は、すぐに医療機関にご連絡ください。", "万一の際は、ためらわず医療機関へご連絡ください。", "異常があれば医療機関へ。", "当院は本日休診のため、お近くの医療機関へご相談ください。", "症状が続く場合は、写真を添えて医療機関を受診してください。", "お近くの歯医者さんへご相談ください。", "119へお電話ください。", "当院へのご連絡を待たずに、すぐに119番へご連絡ください。", "当院に連絡がつかない場合は、119番へお電話ください。", "当院では対応いたしかねますので、お近くの皮膚科を受診してください。", "ご来院が難しい場合は、お近くの医療機関を受診してください。", "一度受診されることをおすすめいたします。", "受診してください。", "診察を受けていただくことをおすすめします。", "お近くの歯科で診ていただいてください。", "専門の先生に診ていただいてください。", "念のため診療所でご相談ください。", "ドクターにご相談ください。", "119に通報してください。", "処方されたお薬で改善しない場合も、すぐに119番へご連絡ください。", "救命救急センターへご連絡ください。", "形成外科を受診してください。", "受診をお願いいたします。", "念のため診てもらってください。", "悪化したら受診してください。", "腫れが引かない時は受診してください。", "痛みが強いときは、受診してください。", "続く際は受診してください。", "症状があれば受診してください。", "改善しない場合は医療機関にかかってください。", "早急に受診してください。", "至急受診してください。", "受診なさってください。", "受診をお考えください。", "医師の判断を仰いでください。", "強い痛みが続く場合は、当院へご連絡いただくか、医療機関を受診してください。", "当院へご連絡のうえ、必要に応じて医療機関を受診してください。", "当院にご連絡いただくとともに、皮膚科を受診してください。", "当院で経過を確認いたしますが、症状が強い場合は医療機関を受診してください。", "症状が強い時は、医療機関を受診のうえ、当院へもご連絡ください。", "主治医にご相談ください。", "担当医にご相談ください。", "専門家にご相談ください。", "状態によっては受診が必要になる場合がございます。", "受診されたほうが安心かと存じます。", "当院へご連絡いただくか皮膚科を受診してください。", "当院にご連絡いただくか医療機関へご相談ください。", "当院までご連絡のうえ必要に応じて医療機関を受診してください。", "症状が強い場合は当院にご来院いただくか病院を受診してください。", "悪化した場合は当院を含む医療機関を受診してください。", "すぐに医師の診断を受けてください。", "専門医の診断をおすすめいたします。", "皮膚科の先生に見てもらってください。", "歯科医院で見てもらってください。", "医療機関を訪れてください。", "お近くの医療機関でご確認ください。", "専門の医療機関をご紹介いたします。"]) {
    assert.equal(med.isEscalationSentence("テスト：" + s), true, s);
  }
  for (const s of ["予約日前日に医療機関を受診したことが確認できる証明書類をご提出ください。", "当院の医師が確認のうえご連絡いたします。", "料金は11,900円です。", "料金は119,000円です。", "119分の施術です。", "救急セットをご用意しております。", "受診いただく際は保険証をお持ちください。", "ご予約いただいた日に受診してください。", "当院を受診いただく際はご予約ください。", "数日〜2週間ほどで落ち着いてまいります。", "医療機関を受診し、診断書をご提出ください。", "病院で発行された診断書をお送りください。", "病院を受診された際の処方箋の写真をお送りください。",
    "症状が続くようでしたら、再度ご来院のうえ受診してください。", "当院では夜間診療も行っております。", "当院は医療機関ですので、お気軽にご相談ください。", "保険診療をご希望の場合は、受診時に保険証をお持ちください。", "初めての場合は受診前に問診票のご記入をお願いいたします。", "当院の皮膚科でご相談ください。", "担当医師より改めてご連絡いたします。", "医師が確認し、ご連絡いたします。", "当日は施術前に医師の診察を受けていただきます。", "クリニックへのご連絡ありがとうございます。", "医院にご連絡いただき、ありがとうございます。", "他院で施術を受けられた方もご相談いただけます。", "担当の先生に確認してご連絡いたします。", "ドクターに確認のうえご連絡いたします。", "念のため一度ご来院いただき、医師に診ていただけますと安心です。", "当院へご来院いただき、医師が診察いたします。"]) {
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
  assert.match(h.calls[0].messages[0].content, /【確認：下書きにある受診・救急の案内[\s\S]*119番へご連絡ください/);
  assert.match(h.calls[0].sys, /この医院自体が医療機関/);
  assert.match(h.calls[0].sys, /スタッフが指示した症状の説明・経過の見込み・対処・安心していただく言葉は医院としての案内/);
  assert.match(h.calls[1].sys, /方針の（ア）〜（ウ）に当たらないものだけを削除し、当たるものは残す/);
  assert.match(h.calls[1].sys, /この医院自体が医療機関/);
  assert.doesNotMatch(h.calls[2].messages[0].content, /【確認：下書きにある受診・救急の案内/);
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
  const h3 = reviewer(['{"pass":false,"safety":false,"escalation":false,"reason":"受診・救急の案内は適切。お詫びが弱い"}', "テスト：別の案です。", '{"pass":false,"safety":false,"reason":"指示から離れた"}']);
  assert.equal((await h3.review({}, consult(), ADDED)).text, ADDED);
});

test("テスト：受診・救急を足さない文には、店舗ルールの明記と命に関わる症状の例外を必ず付ける", () => {
  const { STAFF_DRAFT_POLICY } = consultation;
  assert.match(med.MEDICAL_GUIDANCE_POLICY, /（ウ）患者様の連絡に命に関わる緊急の症状/);
  assert.match(med.MEDICAL_GUIDANCE_POLICY, /（ウ）の時は、スタッフが大丈夫と伝えるよう指示していても、スタッフの説明を保ったうえで救急の案内（119番・救急相談。他院への通常の受診案内ではない）を添え/);
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
  assert.match(r.error, /編集指示を正確に反映できませんでした（理由：スタッフの指示にない受診・救急の案内が残りました）/);
  // （ウ）の救急案内が欠けて safety:true、修正AIが応答しない時も、救急案内の無い最初の案を返さない
  const h2 = reviewer(['{"pass":false,"safety":true,"emergency_missing":true,"reason":"息苦しさがあるのに救急案内が無い"}', null]);
  const r2 = await h2.review({}, consult({ lastQ: "テスト：さっきから息が苦しいです" }), "テスト：一時的な炎症で大丈夫です。");
  assert.equal(r2.text, "");
  assert.match(r2.error, /命に関わる症状があるのに、救急の案内がありません/);
  // emergency_missing だけが付き safety が false の矛盾した結果でも、救急案内の無い最初の案を返さない
  const h4 = reviewer(['{"pass":false,"safety":false,"escalation":false,"emergency_missing":true}', null]);
  const r4 = await h4.review({}, consult({ lastQ: "テスト：さっきから息が苦しいです" }), "テスト：一時的な炎症で大丈夫です。");
  assert.equal(r4.text, "");
  const h5 = reviewer(['{"pass":false,"safety":false,"escalation":false,"emergency_missing":true}', "テスト：別の案です。", '{"pass":false,"safety":false,"escalation":false,"reason":"お詫びが弱い"}']);
  assert.notEqual((await h5.review({}, consult({ lastQ: "テスト：さっきから息が苦しいです" }), "テスト：一時的な炎症で大丈夫です。")).text, "テスト：一時的な炎症で大丈夫です。");
  // 受診・救急らしい文がある案で escalation が無い不合格は、理由が受診に触れていれば escalation とみなし最初の案を使わない
  const h6 = reviewer(['{"pass":false,"safety":false,"reason":"指示にない受診案内"}', null]);
  const r6 = await h6.review({}, consult(), "テスト：一時的な炎症です。念のため皮膚科を受診してください。");
  assert.equal(r6.text, "");
  assert.match(r6.error, /受診・救急の案内/);
  // 受診・救急らしい文が無い案（感染症の証明書の相談など）は、理由に「医療機関」があっても止めない
  const h7 = reviewer(['{"pass":false,"safety":false,"reason":"医療機関の証明書の提出について条件が欠けている"}', null]);
  const cert = "テスト：前日に受診された際の証明書類をお送りくださいませ。";
  const r7 = await h7.review({}, consult(), cert);
  assert.equal(r7.text, cert);
  // 最初の照合では見落とし、修正後の照合で（ウ）の欠落・指示にない受診案内が見つかった時も、最初の案を使わない
  const h8 = reviewer(['{"pass":false,"safety":false,"escalation":false,"reason":"お詫びが無い"}', "テスト：別の案です。", '{"pass":false,"safety":false,"escalation":true}']);
  assert.equal((await h8.review({}, consult(), ADDED)).text, "");
  const h9 = reviewer(['{"pass":false,"safety":false,"reason":"お詫びが無い"}', "テスト：別の案です。", '{"pass":false,"safety":false,"emergency_missing":"true"}']);
  assert.equal((await h9.review({}, consult({ lastQ: "テスト：息が苦しいです" }), "テスト：一時的な炎症で大丈夫です。")).text, "");
  // S2b: 拾えない言い方の受診案内で escalation が無い不合格 → 修正案が別の理由で落ちても最初の案を使わない
  const h10 = reviewer(['{"pass":false,"safety":false,"reason":"指示にない受診案内がある"}', "テスト：一時的な炎症です。", '{"pass":false,"safety":false,"escalation":false,"reason":"お詫びが無い"}']);
  const r10 = await h10.review({}, consult(), "テスト：一時的な炎症です。様子がおかしければ受診も。");
  assert.equal(r10.text, "テスト：一時的な炎症です。");
  // S1: 救急案内の欠落を理由文だけで返した時も（ウ）の欠落として扱う
  const h11 = reviewer(['{"pass":false,"safety":true,"reason":"息苦しさがあるのに救急の案内が無い"}', null]);
  const r11 = await h11.review({}, consult({ lastQ: "テスト：息苦しいです" }), "テスト：一時的な炎症で大丈夫です。");
  assert.equal(r11.text, "");
  assert.match(r11.error, /救急の案内がありません/);
  // 理由が受診に触れる不合格で修正AIが応答しない時も、最初の案を表示しない
  const h12 = reviewer(['{"pass":false,"safety":false,"reason":"指示にない受診案内がある"}', null]);
  const r12 = await h12.review({}, consult(), "テスト：一時的な炎症です。様子を見ても治らなければ、ご相談を。");
  assert.equal(r12.text, "");
  // emergency_missing を付け忘れ、理由文が救急の欠落を述べる時は欠落として扱う
  const h13 = reviewer(['{"pass":false,"safety":false,"escalation":false,"reason":"息苦しさがあるのに救急の案内が無い"}', null]);
  assert.equal((await h13.review({}, consult({ lastQ: "テスト：息苦しいです" }), "テスト：一時的な炎症で大丈夫です。")).text, "");
  // A: 指示にない119番で escalation:true・理由が「指示になく不要」→ 理由は「指示にない受診・救急の案内」
  const hA = reviewer(['{"pass":false,"safety":false,"escalation":true,"emergency_missing":false,"reason":"119番の案内はスタッフ指示になく不要"}', ADDED, '{"pass":false,"safety":false,"escalation":true,"emergency_missing":false,"reason":"119番の案内はスタッフ指示になく不要"}']);
  const rA = await hA.review({}, consult(), ADDED);
  assert.match(rA.error, /スタッフの指示にない受診・救急の案内が残りました/);
  // B: 受診案内の無い正しい案で「救急の案内は不要なので問題ないが、お詫びが弱い」→ 確認ポイント付きで表示
  const okDraft = "テスト：一時的な炎症で、数日〜2週間ほどで落ち着いてまいります。";
  const hB = reviewer(['{"pass":false,"safety":false,"escalation":false,"emergency_missing":false,"reason":"救急の案内は不要なので問題ないが、お詫びが弱い"}', "テスト：別の案です。", '{"pass":false,"safety":false,"escalation":false,"emergency_missing":false,"reason":"指示から離れた"}']);
  const rB = await hB.review({}, consult(), okDraft);
  assert.equal(rB.text, okDraft);
  // 文字列の "false" も false として読む
  const hC = reviewer(['{"pass":false,"safety":"false","escalation":"false","emergency_missing":"false","reason":"お詫びが弱い"}', "テスト：別の案です。", '{"pass":false,"safety":false,"escalation":false,"reason":"指示から離れた"}']);
  assert.equal((await hC.review({}, consult(), ADDED)).text, ADDED);
  // 医療以外の safety（未実施の予約操作の完了表記など）は、従来どおり確認ポイント付きで表示する（最初の案は使わない）
  const h3 = reviewer(['{"pass":false,"safety":true,"escalation":false,"reason":"未実施の予約操作を完了と書いている"}', "テスト：キャンセルについて確認いたします。", '{"pass":false,"safety":true,"escalation":false,"reason":"未実施の予約操作"}']);
  const r3 = await h3.review({}, consult({ latestInstruction: "テスト：キャンセル済みと伝えて" }), "テスト：キャンセルが完了いたしました。");
  assert.equal(r3.text, "テスト：キャンセルについて確認いたします。");
  assert.match(r3.warning, /未実施の予約操作/);
});

test("テスト：照合AIが escalation を付け忘れた・合否が矛盾した時は合格にも最初の案の採用にもしない", async () => {
  const fixed = ADDED.replace(/\n\n腫れが広がる[^\n]*\n\n/, "\n\n");
  const h = reviewer(['{"pass":false,"safety":false,"reason":"スタッフの指示にない受診・救急の案内：119番"}', fixed, '{"pass":false,"safety":false,"escalation":false,"reason":"お詫びが弱い"}']);
  const r = await h.review({}, consult(), ADDED);
  assert.equal(r.text, fixed);
  const h2 = reviewer(['{"pass":true,"safety":false,"escalation":true}', fixed, '{"pass":true,"safety":false,"escalation":false}']);
  assert.equal((await h2.review({}, consult(), ADDED)).text, fixed);
  assert.match(med.escalationAuditHint(ADDED), /必ず "escalation":true\|false/);
});

test("テスト：手がかりを示した照合が escalation を返さない時は、合格にも表示にもしない", async () => {
  const h = reviewer(['{"pass":true,"safety":false,"reason":"ok"}', ADDED, '{"pass":true,"safety":false,"reason":"ok"}']);
  const r = await h.review({}, consult(), ADDED);
  assert.equal(r.text, "");
  assert.match(r.error, /受診・救急の案内が残っていますが、指示どおりか確認できませんでした/);
  // 修正AIが応答しない
  const h2 = reviewer(['{"pass":false,"safety":false,"reason":"スタッフの指示にない受診・救急の案内"}', null]);
  assert.equal((await h2.review({}, consult(), ADDED)).text, "");
  // 修正案に受診の文が残り、最後の照合が別の理由だけを返す
  const keep = "テスト：一時的な炎症です。念のため皮膚科を受診してください。";
  const h3 = reviewer(['{"pass":false,"safety":false,"escalation":true}', keep, '{"pass":false,"safety":false,"reason":"お詫びが弱い"}']);
  assert.equal((await h3.review({}, consult(), ADDED)).text, "");
  // 最後の照合を読み取れない
  const h4 = reviewer(['{"pass":false,"safety":false,"escalation":true}', keep, 'not json']);
  assert.equal((await h4.review({}, consult(), ADDED)).text, "");
  // 照合AIが例外に当たると確認した（escalation:false）案は、別の理由の確認ポイント付きで表示できる
  const h5 = reviewer(['{"pass":false,"safety":false,"escalation":true}', keep, '{"pass":false,"safety":false,"escalation":false,"reason":"お詫びが弱い"}']);
  const r5 = await h5.review({}, consult(), ADDED);
  assert.equal(r5.text, keep);
  assert.match(r5.warning, /お詫びが弱い/);
});

test("テスト：受診案内の時期や条件だけを書いた一般的なルールは（イ）に当たらないと明記する", () => {
  assert.match(med.MEDICAL_GUIDANCE_POLICY, /受診案内を出す時期や条件だけを書いた一般的なルール（例:『受診案内は患者から質問がある場合に記載する』）は（イ）に当たらない/);
  assert.equal(med.isEscalationSentence("テスト：念のため医師にご相談ください。"), true);
});

test("テスト：スタッフ指示を優先しない照合（感染症の証明書など）では、safety:true を合否に使わない", async () => {
  const cert = "テスト：前日に受診された際の証明書類をお送りくださいませ。";
  const h = reviewer(['{"pass":true,"safety":true,"escalation":false,"emergency_missing":false,"reason":"安全"}']);
  const r = await h.review({}, consult({ staffHistory: "", allowWarning: undefined, escalationCheck: undefined }), cert);
  assert.equal(r.text, cert);
  assert.equal(r.error, "");
  assert.match(source, /safety は、スタッフの指示や店舗ルールに無い診断・治療判断の追加/);
});

test("テスト：手がかりの上限を超える受診・救急の文がある案は確認済みにしない", async () => {
  const many = Array.from({ length: med.HINT_LIMIT + 1 }, (_, i) => "テスト" + i + "：腫れが続く場合は病院へご相談ください。").join("\n");
  const h = reviewer(['{"pass":false,"safety":false,"escalation":false,"reason":"お詫びが無い"}', null]);
  const r = await h.review({}, consult(), many);
  assert.equal(r.text, "");
  assert.match(source, /"safety\\":true\|false,\\"escalation\\":true\|false,\\"emergency_missing\\":true\|false/);
});

test("テスト：施術部位だけの腫れ・ヒリヒリは命に関わる症状に当たらないと方針に明記する", () => {
  assert.match(med.MEDICAL_GUIDANCE_POLICY, /施術した部位（唇・歯ぐき・口元・歯）だけの腫れ・ヒリヒリ・しみる・白くなる・痛みは、（ウ）に当たらない/);
  const gen = source.slice(source.indexOf("async function genDraft("), source.indexOf("async function genDraft(") + 6000);
  assert.match(gen, /スタッフの指示・店舗ルールに無い医療判断・診断はAIが独自にしない/);
  assert.doesNotMatch(source, /断定や医療判断は避ける。/);
});

test("テスト：受診が不要と伝える文は、照合AIへ案内に当たらないと示す", () => {
  const hint = med.escalationAuditHint("テスト：病院へ行かれる必要はございません。");
  assert.match(hint, /受診・救急が不要と伝える文（例:『病院へ行かれる必要はございません』）[^。]*この理由で不合格にしない/);
});

test("テスト：照合AIが例外に当たると判断した受診・救急の案内（スタッフ指示・命に関わる症状）は、そのまま残す", async () => {
  const h = reviewer(['{"pass":true,"safety":false,"escalation":false,"reason":"患者が息苦しさを訴えているため救急案内は適切"}']);
  const r = await h.review({}, consult({ lastQ: "テスト：さっきから息が苦しいです" }), ADDED);
  assert.equal(r.text, ADDED);
});

test("テスト：受診・救急の文がある時は、文体だけの指示でも照合を省かない", async () => {
  const h = reviewer(['{"pass":true,"safety":false,"escalation":false}']);
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
  assert.doesNotMatch(h.calls[0].messages[0].content, /【確認：下書きにある受診・救急の案内/);
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

test("テスト：唇のヒリヒリ・しみる・息苦しい等の問い合わせは、自動送信せずスタッフ確認に回す", () => {
  const { evaluateResponseGrounding } = require("../lib/response-grounding");
  for (const q of ["テスト：唇がヒリヒリして白くなっています", "テスト：歯がしみます", "テスト：赤くなってかゆい", "テスト：息が苦しいです"]) {
    const g = evaluateResponseGrounding({ query: q, draft: "テスト：ご連絡ありがとうございます。" });
    assert.equal(g.autoSendAllowed, false, q);
    assert.ok(g.domains.includes("medical"), q);
  }
});
