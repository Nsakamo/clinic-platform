"use strict";

// スタッフが AI 下書きをどう直して送ったかから「文体の直し方」だけを学ぶ。
// 判断・事実・料金は既存の判断メモリと店舗ルールの担当で、ここでは扱わない。
// 1回だけの直しは候補に留め、別の送信で同じ直しが再び出たものだけを下書きへ使う。

const { textSimilarity } = require("./learning-retrieval");

const STYLE_LESSON_MAX = 60;
const STYLE_LESSON_TEXT_MAX = 80;
const STYLE_LESSON_ACTIVE_MIN = 2;
const STYLE_LESSON_PROMPT_LIMIT = 8;
const STYLE_LESSON_MERGE_SIMILARITY = 0.6;

// 患者固有情報・事実・医療判断に触れる学びは文体の学習として扱わない。
const PERSONAL_DATA = /(?:[\w.%+-]+@[\w.-]+\.[A-Za-z]{2,})|[0-9]|(?:[一二三四五六七八九十百千]+(?:円|日|時|分|回|件|名|人))|(?:[月火水木金土日]曜)/u;
// 「LINEは3文以内」「2行で」など、文の長さを示す小さな数だけは文体として許す。
const LENGTH_COUNT = /(?:[0-9]{1,2}|[一二三四五六七八九十])(?:〜(?:[0-9]{1,2}|[一二三四五六七八九十]))?(?:文|行|文字|段落|点|項目)/gu;
const CONTENT_DECISION = /(?:料金|金額|価格|費用|円|無料|有料|割引|返金|キャンセル料|違約金|ポイント|回数券|診断|処方|薬|副作用|症状|治る|完治|大丈夫です|問題ありません|保証|免除|可否|受け付けます|受け付けません|できます|できません|予約(?:を)?(?:確定|変更|取消|キャンセル)しました|URL|http)/;

function cleanLessonText(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .replace(/^[・●*\-\s]+/, "")
    .trim();
}

// 文体の学びとして安全に再利用できる文だけを通す。
function acceptableStyleLesson(value, sourceTexts) {
  const text = cleanLessonText(value);
  if (text.length < 6 || text.length > STYLE_LESSON_TEXT_MAX) return "";
  if (PERSONAL_DATA.test(text.replace(LENGTH_COUNT, "")) || CONTENT_DECISION.test(text)) return "";
  // 元の会話に出た氏名らしき語（○○様／○○さん）を含む学びは使わない。
  const raw = (Array.isArray(sourceTexts) ? sourceTexts : [sourceTexts]).map(v => String(v || "")).join(" ");
  const names = Array.from(raw.matchAll(/([一-龯々ぁ-んァ-ヶーA-Za-z]{2,20})(?:様|さん)/gu), match => match[1]);
  if (names.some(name => text.includes(name))) return "";
  return text;
}

function sanitizeStyleLesson(value) {
  const v = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const text = acceptableStyleLesson(v.text);
  if (!text) return null;
  const now = Date.now();
  return {
    id: String(v.id || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40) || ("sl-" + now.toString(36)),
    text,
    count: Math.max(1, Math.min(9999, Math.floor(Number(v.count || 1)) || 1)),
    firstSeen: Math.max(0, Number(v.firstSeen || 0)) || now,
    lastSeen: Math.max(0, Number(v.lastSeen || 0)) || now,
    disabled: v.disabled === true,
    edited: v.edited === true,
  };
}

function styleLessonList(config) {
  const cfg = config && typeof config === "object" ? config : {};
  if (!Array.isArray(cfg.styleLessons)) cfg.styleLessons = [];
  const clean = cfg.styleLessons.map(sanitizeStyleLesson).filter(Boolean);
  cfg.styleLessons.length = 0;
  clean.forEach(item => cfg.styleLessons.push(item));
  return cfg.styleLessons;
}

function styleLessonActive(lesson) {
  return !!(lesson && !lesson.disabled && (lesson.edited || Number(lesson.count || 0) >= STYLE_LESSON_ACTIVE_MIN));
}

// 同じ直しは件数を足して1件にまとめ、上限を超えたら使われていない古い候補から外す。
function mergeStyleLessons(config, lessons, now, makeId) {
  const list = styleLessonList(config);
  const at = Number(now) || Date.now();
  const added = [], reinforced = [];
  const seenThisRound = new Set();
  (Array.isArray(lessons) ? lessons : []).forEach(raw => {
    const text = acceptableStyleLesson(raw);
    if (!text) return;
    const existing = list.find(item => item.text === text || textSimilarity(item.text, text) >= STYLE_LESSON_MERGE_SIMILARITY);
    if (existing) {
      // 1回の送信から言い換えで同じ学びが複数出ても、確認回数は1回分だけ数える。
      if (seenThisRound.has(existing.id)) return;
      seenThisRound.add(existing.id);
      existing.count = Math.min(9999, Number(existing.count || 1) + 1);
      existing.lastSeen = at;
      reinforced.push(existing);
      return;
    }
    const item = { id: typeof makeId === "function" ? makeId() : ("sl-" + at.toString(36) + "-" + list.length), text, count: 1, firstSeen: at, lastSeen: at, disabled: false, edited: false };
    list.push(item); seenThisRound.add(item.id); added.push(item);
  });
  while (list.length > STYLE_LESSON_MAX) {
    let index = -1;
    list.forEach((item, i) => {
      if (styleLessonActive(item) || item.edited) return;
      if (index < 0 || Number(item.lastSeen || 0) < Number(list[index].lastSeen || 0)) index = i;
    });
    if (index < 0) {
      list.forEach((item, i) => { if (index < 0 || Number(item.lastSeen || 0) < Number(list[index].lastSeen || 0)) index = i; });
    }
    list.splice(index, 1);
  }
  return { added, reinforced };
}

function rankedActiveStyleLessons(config, limit) {
  return styleLessonList(config).filter(styleLessonActive)
    .slice()
    .sort((a, b) => Number(b.count || 0) - Number(a.count || 0) || Number(b.lastSeen || 0) - Number(a.lastSeen || 0))
    .slice(0, limit || STYLE_LESSON_PROMPT_LIMIT);
}

function styleLessonsPromptBlock(config, limit) {
  const lessons = rankedActiveStyleLessons(config, limit);
  if (!lessons.length) return "";
  return "【スタッフの直し方から学んだ文体（スタッフが実際に繰り返し直した点）】\n"
    + "AIの下書きをスタッフが送信前に直した内容から学んだ書き方です。最初の案から反映し、スタッフが同じ直しをしなくて済むようにする。"
    + "文体・構成・長さ・言い回しだけに適用し、店舗ルール・確認済み情報・料金・可否・安全上の制約・患者様への礼儀は変えない。今回の会話やスタッフの最新指示と合わない項目は使わない。\n"
    + lessons.map(item => "・" + item.text).join("\n");
}

// AI 応答から学びを取り出す。形が崩れていれば何も学ばない。
function parseStyleLessonResponse(raw) {
  const match = String(raw || "").match(/\{[\s\S]*\}/);
  if (!match) return [];
  let parsed;
  try { parsed = JSON.parse(match[0]); } catch (e) { return []; }
  const list = parsed && Array.isArray(parsed.lessons) ? parsed.lessons : [];
  return list.slice(0, 3).map(item => cleanLessonText(item && typeof item === "object" ? item.text : item)).filter(Boolean);
}

// 文体の学びを探す価値がある直しか。事実だけを差し替えた直しや、AI案のない手書き返信は対象外。
function styleEditWorthLearning(draft0, final) {
  const before = String(draft0 || "").trim(), after = String(final || "").trim();
  if (!before || !after || before === after) return false;
  if (after.length < 12) return false;
  return textSimilarity(before, after) < 0.985;
}

const STYLE_LESSON_SYSTEM = "あなたはクリニック受付AIの文体コーチです。AIが作った患者向け下書き(before)と、スタッフが直して実際に送った返信(after)を比べ、スタッフの『書き方の直し方』のうち、他の患者様への返信でも毎回使える一般的な文体の学びだけを最大3件抜き出してください。"
  + "対象は、長さ・文の数、結論の位置、あいさつや締めの有無と言い方、敬語の強さ、言い回しの置き換え、改行や箇条書きの使い方、繰り返しの削除などです。"
  + "料金・可否・予約・日時・医療の内容、今回の問い合わせ固有の事情、患者様の氏名や番号、事実の追加や訂正は学びに含めないでください（それらは別の仕組みで扱います）。"
  + "1件は『〜する』『〜しない』で終わる60文字以内の具体的な日本語にし、数字・日付・固有名詞・引用した患者情報を入れないでください。"
  + "言い回しの置き換えは『「させていただきます」は「いたします」にする』のように短く示してよいです。"
  + "直しが事実だけ、または今回限りと思われる場合は空配列にしてください。迷う場合も空にしてください。"
  + "出力はJSONのみ: {\"lessons\":[{\"text\":\"…\"}]}";

function styleLessonUserPrompt(input) {
  return JSON.stringify({
    channel: String(input && input.channel || "").slice(0, 10),
    staffInstruction: String(input && input.instr || "").slice(0, 600),
    before: String(input && input.draft0 || "").slice(0, 1800),
    after: String(input && input.final || "").slice(0, 1800),
  });
}

module.exports = {
  STYLE_LESSON_ACTIVE_MIN,
  STYLE_LESSON_MAX,
  STYLE_LESSON_SYSTEM,
  acceptableStyleLesson,
  mergeStyleLessons,
  parseStyleLessonResponse,
  rankedActiveStyleLessons,
  sanitizeStyleLesson,
  styleEditWorthLearning,
  styleLessonActive,
  styleLessonList,
  styleLessonUserPrompt,
  styleLessonsPromptBlock,
};
