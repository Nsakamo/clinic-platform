"use strict";

// 症状・施術後の不調の問い合わせで、スタッフが指示していない
// 「他の医療機関への受診」「救急相談」「119番」「悪化したら〜」をAIが勝手に足さないための方針と検査。
// この医院自体が医療機関であり、スタッフが指示した説明・経過・対処は医院としての案内として扱う。
// 検査と除去は、スタッフが指示を出した下書き（相談チャット・スタッフLINEの修正）だけに使う。

const MEDICAL_GUIDANCE_POLICY = "【症状・施術後の不調への返信（受診・救急の案内）】この医院自体が医療機関であり、スタッフが示した症状の説明・経過の見込み・対処方法・安心していただく言葉は、医院としての案内である。"
  + "他の医療機関・病院・皮膚科への受診、救急相談窓口、119番、『悪化したら〜』『〜の場合はすぐに〜』のような受診や救急の条件付き案内は、自分の判断で加えない。"
  + "加えてよいのは、(1)スタッフが今回または相談の中でその案内を指示した、(2)店舗ルールが今回の症状にその案内をするよう明記している、(3)患者様の連絡に命に関わる緊急の症状（息苦しさ・呼吸がしにくい、意識がもうろうとする、胸の痛み、のど・舌・顔全体の急な腫れ、全身のじんましん、止まらない出血等）が書かれている、のいずれかだけ。"
  + "患者様が『病院に行くべきか』と尋ねていても、スタッフが説明・経過・対処を指示していれば、それがこの医院としての回答であり、受診や救急の案内を足さない。"
  + "スタッフの指示がまだ無い時は、症状を断定せず、店舗ルールにある一般的な説明の範囲で伝え、医院で施術時の状況を確認して改めてご案内する旨を書く（受診や救急の案内は(2)(3)の時だけ）。";

const STAFF_MEDICAL_INSTRUCTION = "スタッフが症状の説明・経過の見込み（例:『数日〜2週間ほどで落ち着きます』）・対処方法・お詫び・安心していただく言葉を指示したら、医院としての案内として、その内容と結論を弱めたり条件を付けたりせず、そのまま丁寧な文にする。AIが指示にない新しい診断・治療判断・受診や救急の案内を加えることはしない。";

// 受診・救急の案内（他の医療機関へ行く・相談する・119番）に当たる文
const EMERGENCY_TERMS = /119番|(?:#|＃)7119|救急(?:車|外来|相談|窓口|病院|医療|安心|の窓口|へ|に|を)|夜間(?:・休日)?(?:の)?(?:診療|窓口|相談)|休日診療/;
const OTHER_PROVIDER = /(?:医療機関|病院|皮膚科|耳鼻科|耳鼻咽喉科|口腔外科|内科|眼科|お医者|他院|専門医)[^。\n]{0,14}(?:受診|ご相談|相談|診察|診て|行って|行かれ|へ行|お越し)/;
const CONDITIONAL_SEE_DOCTOR = /(?:場合|ようでしたら|ようなら|ようであれば|際は)[^。\n]{0,12}受診|受診を(?:ご検討|おすすめ|お勧め)/;
// 提出物（証明書・診断書など）の案内は、受診を勧める文ではない
const NON_ESCALATION_CONTEXT = /証明|書類|免除|キャンセル料|受診日|領収|診断書|処方|検査結果|陽性|発行|写真/;
const OWN_CLINIC = /当院|当クリニック|弊院/;
function isEscalationSentence(sentence) {
  const s = String(sentence || "").normalize("NFKC");
  if (!s.trim() || NON_ESCALATION_CONTEXT.test(s)) return false;
  if (EMERGENCY_TERMS.test(s) || OTHER_PROVIDER.test(s)) return true;
  return CONDITIONAL_SEE_DOCTOR.test(s) && !OWN_CLINIC.test(s);
}

// 患者の連絡にある、命に関わる緊急の症状（迷う表現は残す方へ倒す）
const LIFE_THREATENING = new RegExp([
  "息.{0,3}(?:苦し|くるし|でき(?:な|ませ)|しづら|しにく|しずら|が止ま)", "いきぐるし", "呼吸", "窒息",
  "意識", "気を失", "失神", "ぐったり", "朦朧|もうろう", "けいれん|痙攣", "ろれつ",
  "胸.{0,3}(?:痛|苦し|いた)", "胸痛", "動悸",
  "(?:全身|体中|からだ中|身体中)[^。\\n]{0,10}(?:じんま|蕁麻|発疹|ぶつぶつ|かゆ|痒|赤)", "(?:じんま|蕁麻|発疹)[^。\\n]{0,10}(?:全身|体中|からだ中|広が)", "アナフィラキシー",
  "(?:のど|喉|舌|まぶた|瞼)[^。\\n]{0,8}(?:腫|詰ま|狭|苦し|はれ)", "顔[^。\\n]{0,6}(?:パンパン|大きく腫|全体が腫)", "(?:唇|くちびる)[^。\\n]{0,6}(?:パンパン|紫)", "紫色", "チアノーゼ",
  "飲み込(?:め|みにく|みづら|むのが)", "目が開(?:か|け)", "見えにく|視界",
  "出血[^。\\n]{0,8}(?:止まら|止まりませ|止まな)", "血が止まら",
].join("|"));
function hasLifeThreateningSymptom(patientText) {
  return LIFE_THREATENING.test(String(patientText || "").normalize("NFKC"));
}

function splitSentences(text) {
  const out = [];
  for (const line of String(text || "").split(/(\n)/)) {
    if (line === "\n") { out.push(line); continue; }
    // 閉じかっこは前の文に含める
    const parts = line.match(/[^。！？!?]*[。！？!?]+[」』）)】]*|[^。！？!?]+$/g);
    if (parts) out.push(...parts); else if (line) out.push(line);
  }
  return out;
}

function escalationSentences(text) {
  return splitSentences(text).filter(s => s !== "\n" && isEscalationSentence(s)).map(s => s.trim()).filter(Boolean);
}

// スタッフ側の文章で、受診・救急の案内を指示していると読める語
const STAFF_ESCALATION_WORDS = /119|救急|受診|病院|医療機関|皮膚科|他院|専門医/;
// 受診・救急の語に直接かかる否定・削除の指示（「病院に行かなくて大丈夫」「救急の案内は消して」）
const STAFF_NEGATION = /(?:119番?|救急|受診|病院|医療機関|皮膚科|他院|専門医)[^。]{0,10}?(?:行かな|いかな|行く必要|いく必要|不要|いらない|要らない|必要(?:は|も)?(?:ない|ありません|ございません)|しなくて|しなくても|書かな|消して|けして|削除|外して|はずして|入れな|なしで|ナシ|やめて|止めて)|(?:行かなく|いかなく|受診しなく)て(?:も)?(?:大丈夫|いい|よい|平気|問題)/;
// 患者から聞かれたこと・確認済みのことの報告で、指示ではない
const STAFF_REPORT_ONLY = /聞かれ|質問され|と言って(?:る|い|ます)|確認済|確認しました|相談済/;
function staffAsksEscalation(staffText) {
  const fragments = splitSentences(String(staffText || "").normalize("NFKC").replace(/\n/g, "。"));
  return fragments.some(x => STAFF_ESCALATION_WORDS.test(x) && !STAFF_NEGATION.test(x) && !STAFF_REPORT_ONLY.test(x));
}

// 受診・救急の案内を書いてよい状況か。
// staffTexts: スタッフが書いた指示・共通指示・対応メモ（AIの旧案や患者の引用は入れない）
// ruleText: 関連する店舗ルール、patientText: 患者の直近の連絡（数通）
function escalationAllowed(input) {
  input = input || {};
  const staff = (Array.isArray(input.staffTexts) ? input.staffTexts : [input.staffTexts]).map(v => String(v || "")).join("\n");
  if (staffAsksEscalation(staff)) return true;
  if (escalationSentences(input.ruleText).length || /119番|救急(?:車|相談)/.test(String(input.ruleText || ""))) return true;
  return hasLifeThreateningSymptom(input.patientText);
}

// 指示にない受診・救急の案内が下書きにあれば、その文を返す（無ければ空配列）。
// keepText（スタッフが手で書いた編集前の下書きなど）にある文は、スタッフの案内として対象にしない。
function unrequestedEscalation(draft, input) {
  if (escalationAllowed(input)) return [];
  const keep = new Set(escalationSentences(input && input.keepText));
  return escalationSentences(draft).filter(s => !keep.has(s));
}

// スタッフ指示の内容語（漢字・カタカナ2文字以上）。除去でこれらが下書きから失われる時は除去しない。
function contentWords(text) {
  return Array.from(new Set((String(text || "").normalize("NFKC").match(/[一-龥々ァ-ヶー]{2,}/g) || [])
    .filter(w => !STAFF_ESCALATION_WORDS.test(w) && !/^(?:場合|症状|悪化|心配|念|伝|大丈夫|丁寧|返信|患者|様|客様)$/.test(w))));
}

// 指示にない受診・救急の案内の文だけを取り除く（他の文は変えない）。
// 取り除くとスタッフ指示の内容まで失われる時は、取り除かずに blocked を返す（照合・確認ポイントへ回す）。
function stripUnrequestedEscalation(draft, input) {
  const found = unrequestedEscalation(draft, input);
  if (!found.length) return { text: String(draft || ""), removed: [], blocked: false };
  const target = new Set(found);
  // 行ごとに対象の文だけを除き、対象の文だけでできていた行（箇条書きの1項目など）は行ごと除く
  const lines = [];
  for (const line of String(draft || "").split("\n")) {
    if (!line.trim()) { lines.push(""); continue; }
    const rest = splitSentences(line).filter(x => !target.has(x.trim())).join("").replace(/[ \t　]+$/, "");
    if (rest.trim() && !/^[・\-*●■◆※]\s*$/.test(rest.trim())) lines.push(rest);
  }
  const text = lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  const staff = (Array.isArray(input && input.staffTexts) ? input.staffTexts : [input && input.staffTexts]).map(v => String(v || "")).join("\n");
  const lost = contentWords(staff).filter(w => found.some(s => s.includes(w)) && !text.includes(w));
  if (lost.length || !text) return { text: String(draft || ""), removed: [], blocked: true };
  return { text, removed: found, blocked: false };
}

const ESCALATION_AUDIT_REASON = "スタッフの指示にない受診・救急の案内（他院・病院への受診、救急相談、119番、悪化時の条件付き案内）が加えられています。その文を削除し、スタッフの指示どおりの説明にしてください";
const ESCALATION_REMOVED_WARNING = "スタッフの指示にない受診・救急の案内を削除しました。必要な場合は、受診の案内を入れるよう指示してください";

module.exports = {
  isEscalationSentence, MEDICAL_GUIDANCE_POLICY, STAFF_MEDICAL_INSTRUCTION, ESCALATION_AUDIT_REASON, ESCALATION_REMOVED_WARNING,
  escalationSentences, hasLifeThreateningSymptom, staffAsksEscalation, escalationAllowed, unrequestedEscalation, stripUnrequestedEscalation,
};
