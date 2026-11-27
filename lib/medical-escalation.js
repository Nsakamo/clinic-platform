"use strict";

// 症状・施術後の不調の問い合わせで、スタッフが指示していない
// 「他の医療機関への受診」「救急相談」「119番」「悪化したら〜」をAIが勝手に足さないための方針と検査。
// この医院自体が医療機関であり、スタッフが指示した説明・経過・対処は医院としての案内として扱う。

const MEDICAL_GUIDANCE_POLICY = "【症状・施術後の不調への返信（受診・救急の案内）】この医院自体が医療機関であり、スタッフが示した症状の説明・経過の見込み・対処方法・安心していただく言葉は、医院としての案内である。"
  + "他の医療機関・病院・皮膚科への受診、救急相談窓口、119番、『悪化したら〜』『〜の場合はすぐに〜』のような受診や救急の条件付き案内は、自分の判断で加えない。"
  + "加えてよいのは、(1)スタッフが今回または相談の中でその案内を指示した、(2)店舗ルールが今回の症状にその案内をするよう明記している、(3)患者様の連絡に命に関わる緊急の症状（息苦しさ・呼吸がしにくい、意識がもうろうとする、胸の痛み、のど・顔全体の急な腫れ、全身のじんましん等）が書かれている、のいずれかだけ。"
  + "患者様が『病院に行くべきか』と尋ねていても、スタッフが説明・経過・対処を指示していれば、それがこの医院としての回答であり、受診や救急の案内を足さない。"
  + "スタッフの指示がまだ無い時は、症状を断定せず、店舗ルールにある一般的な説明の範囲で伝え、医院で施術時の状況を確認して改めてご案内する旨を書く（受診や救急の案内は(2)(3)の時だけ）。";

const STAFF_MEDICAL_INSTRUCTION = "スタッフが症状の説明・経過の見込み（例:『数日〜2週間ほどで落ち着きます』）・対処方法・お詫び・安心していただく言葉を指示したら、医院としての案内として、その内容と結論を弱めたり条件を付けたりせず、そのまま丁寧な文にする。AIが指示にない新しい診断・治療判断・受診や救急の案内を加えることはしない。";

// 受診・救急の案内（他の医療機関へ行く・相談する・119番）に当たる文
const EMERGENCY_TERMS = /(?<![0-9０-９,，])(?:#|＃)?(?:7119|119)(?![0-9０-９])|救急|夜間(?:・休日)?(?:の)?(?:診療|窓口|相談)|休日診療/;
const OTHER_PROVIDER = /(?:医療機関|病院|皮膚科|耳鼻科|耳鼻咽喉科|口腔外科|内科|お医者|他院)[^。\n]{0,14}(?:受診|ご相談|相談|診察|診て|診断|ご連絡|連絡|行)/;
const SEE_DOCTOR = /受診(?:を(?:ご検討|おすすめ|お勧め|お願い)|して(?:ください|いただ)|され(?:て|ます|る)|くださ|いただ)/;
// キャンセル料免除の証明書類など、受診そのものを勧めていない文
const NON_ESCALATION_CONTEXT = /証明|書類|免除|キャンセル料|受診日|領収/;
const OWN_CLINIC = /当院|当クリニック|弊院/;
function isEscalationSentence(sentence) {
  const s = String(sentence || "").normalize("NFKC");
  if (!s.trim() || NON_ESCALATION_CONTEXT.test(s)) return false;
  if (EMERGENCY_TERMS.test(s) || OTHER_PROVIDER.test(s)) return true;
  return SEE_DOCTOR.test(s) && !OWN_CLINIC.test(s);
}
// 患者の連絡にある、命に関わる緊急の症状
const LIFE_THREATENING = /息苦し|息がし(?:づら|にく|ずら)|呼吸(?:が|困難|しにく|しづら)|意識|気を失|失神|胸(?:が|の)?(?:痛|苦し)|胸痛|全身[^。\n]{0,8}(?:じんま|蕁麻|発疹|かゆ|痒)|アナフィラキシー|(?:のど|喉)[^。\n]{0,6}(?:腫|詰ま|狭)|顔(?:全体|中)?[^。\n]{0,4}(?:が|も)?(?:パンパン|大きく腫)|飲み込(?:め|みにく|みづら)|けいれん|痙攣/;
// スタッフ側の文章で、受診・救急の案内を指示していると読める語
const STAFF_ESCALATION_WORDS = /119番?|救急|受診|病院|医療機関|皮膚科|医師|お医者|診てもら|診察/;

function splitSentences(text) {
  const out = [];
  for (const line of String(text || "").split(/(\n)/)) {
    if (line === "\n") { out.push(line); continue; }
    const parts = line.match(/[^。！？!?]*[。！？!?]+|[^。！？!?]+$/g);
    if (parts) out.push(...parts); else if (line) out.push(line);
  }
  return out;
}

function escalationSentences(text) {
  return splitSentences(text).filter(s => s !== "\n" && isEscalationSentence(s)).map(s => s.trim()).filter(Boolean);
}

function hasLifeThreateningSymptom(patientText) {
  return LIFE_THREATENING.test(String(patientText || "").normalize("NFKC"));
}

// 受診・救急の案内を書いてよい状況か。staffTexts はスタッフの指示・相談履歴・共通指示・対応メモ、ruleText は関連する店舗ルール。
function escalationAllowed(input) {
  input = input || {};
  const staff = (Array.isArray(input.staffTexts) ? input.staffTexts : [input.staffTexts]).map(v => String(v || "")).join("\n");
  // 「病院に行かなくて大丈夫」「受診は不要」のような否定の指示は、受診の案内の指示に数えない
  const asksEscalation = splitSentences(staff.normalize("NFKC").replace(/[、,]/g, "。")).some(x => STAFF_ESCALATION_WORDS.test(x)
    && !/(?:行か|いか|受診し|相談し|連絡し|し)な(?:く|い|いで)|不要|必要(?:は|も)?(?:ない|ありません|ございません)|せず/.test(x));
  if (asksEscalation) return true;
  if (/119番|救急/.test(String(input.ruleText || ""))) return true;
  return hasLifeThreateningSymptom(input.patientText);
}

// 指示にない受診・救急の案内が下書きにあれば、その文を返す（無ければ空配列）。
function unrequestedEscalation(draft, input) {
  // 編集前の案にあった文も指摘する（以前のAI案が勝手に足した文を引き継がないため。スタッフが指示すれば allowed で通る）。
  if (escalationAllowed(input)) return [];
  return escalationSentences(draft);
}

// 指示にない受診・救急の案内の文だけを取り除く（他の文は変えない）。
function stripUnrequestedEscalation(draft, input) {
  const found = unrequestedEscalation(draft, input);
  if (!found.length) return { text: String(draft || ""), removed: [] };
  const kept = splitSentences(draft).filter(s => s === "\n" || !isEscalationSentence(s));
  const text = kept.join("").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return { text, removed: found };
}

const ESCALATION_AUDIT_REASON = "スタッフの指示にない受診・救急の案内（他院・病院への受診、救急相談、119番、悪化時の条件付き案内）が加えられています。その文を削除し、スタッフの指示どおりの説明にしてください";

module.exports = {
  isEscalationSentence, MEDICAL_GUIDANCE_POLICY, STAFF_MEDICAL_INSTRUCTION, ESCALATION_AUDIT_REASON,
  escalationSentences, hasLifeThreateningSymptom, escalationAllowed, unrequestedEscalation, stripUnrequestedEscalation,
};
