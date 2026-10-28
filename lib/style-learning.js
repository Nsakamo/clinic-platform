"use strict";

// スタッフが AI 下書きをどう直して送ったかから「文体の直し方」だけを学ぶ。
// 判断・事実・料金は既存の判断メモリと店舗ルールの担当で、ここでは扱わない。
// 1回だけの直しは候補に留め、別の送信で同じ直しが再び出たものだけを下書きへ使う。

const { textSimilarity } = require("./learning-retrieval");

const STYLE_LESSON_MAX = 60;
const STYLE_LESSON_TEXT_MAX = 80;
const STYLE_LESSON_ACTIVE_MIN = 2;
const STYLE_LESSON_PROMPT_LIMIT = 8;

// 患者固有情報・事実に触れる表現。
const PERSONAL_DATA = /(?:[\w.%+-]+@[\w.-]+\.[A-Za-z]{2,})|[0-9]|(?:[一二三四五六七八九十百千]+(?:円|日|時|分|回|件|名|人))|(?:[月火水木金土日]曜)/u;
// 「LINEは3文以内」「2行で」など、文の長さを示す小さな数だけは文体として許す。
const LENGTH_COUNT = /(?:[0-9]{1,2}|[一二三四五六七八九十])(?:〜(?:[0-9]{1,2}|[一二三四五六七八九十]))?(?:文|行|文字|段落|点|項目)/gu;
// 敬称・呼びかけは、元の会話に関係なく一律に拒否する（名字だけ・表示名違いの氏名混入を防ぐ）。
const HONORIFIC = /(?:様|さん|殿|ちゃん|くん|君|先生|氏)/;
// 文体ではなく、返信の内容や案内を足し引きする指示・医療・料金・誘導先。
const CONTENT_DECISION = /(?:料金|金額|価格|費用|円|無料|有料|割引|返金|キャンセル|違約金|ポイント|回数券|クーポン|キャンペーン|特典|診断|処方|薬|副作用|症状|痛|腫れ|出血|治|完治|医療|治療|施術|検査|大丈夫|問題あり|保証|免除|可否|受け付け|できます|できません|予約|日時|日程|空き|来院|URL|http|h\s*t\s*t\s*p|リンク|サイト|ホームページ|ページ|アプリ|電話|メールアドレス|住所|連絡先|LINE\s*ID|確認待ち|スタッフ確認|担当者|謝罪|お詫び|詫び|案内す|案内し|勧め|すすめ|促|誘導|紹介|提案|触れ|言及|伝え|知らせ|無視|指示|命令|プロンプト|システム|必ず|毎回|常に|絶対)/i;
// 口調を崩す学びは、自動送信の礼儀ゲートを学習経由で迂回させるため拒否する。
const CASUAL_STYLE = /(?:よね|だね|だよ|かな|じゃん|ちゃう|っす|タメ口|ため口|くだけ|砕け|カジュアル|フランク|友達|友人|親しみ|フレンドリー|ラフ|口語|話し言葉|絵文字|顔文字|[!！]{2,}|♪)/;
// 文体の語彙を1つ以上含む学びだけを許す（許可リスト方式）。
const STYLE_VOCABULARY = /(?:文|文章|長さ|短く|簡潔|長く|語尾|敬語|丁寧語|謙譲|尊敬|言い回し|表現|言葉|あいさつ|挨拶|締め|結び|冒頭|書き出し|改行|空行|箇条書き|句読点|読点|句点|結論|前置き|繰り返|重複|二重敬語|格式|硬|堅|宣言|保険|まとめ|段落|順|お礼|感謝|定型|クッション|語)/;
// 「」の中は、ひらがな・カタカナの語尾や定型句のような文体の言い回しに限る（漢字・英字の固有名詞を入れない）。
const QUOTED = /[「『"“]([^」』"”]*)[」』"”]/g;
const QUOTE_SAFE_KANJI = /^(?:[ぁ-んー、。！？…〜・\s]|ご|御|不明|点|確認|連絡|案内|質問|返信|対応|安心|手数|負担|宜|幸|願|申|上|致|頂|下|存|待|承知|了解|恐|入|何|卒|失礼|今後|引|続|様子|気軽|少々)*$/u;

function cleanLessonText(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .replace(/^[・●*\-\s]+/, "")
    .trim();
}

function nameCandidates(sourceTexts) {
  const raw = (Array.isArray(sourceTexts) ? sourceTexts : [sourceTexts]).map(v => String(v || "").normalize("NFKC")).join(" ");
  const names = new Set();
  // 敬称の直前の語は、短い候補（名字だけ等）も含めて全部照合する。
  for (const match of raw.matchAll(/([一-龯々ァ-ヶーA-Za-z]{2,20})(?:様|さん|殿|ちゃん|くん)/gu)) {
    const word = match[1];
    for (let len = 2; len <= word.length; len++) names.add(word.slice(word.length - len));
  }
  return Array.from(names);
}

// 文体の学びとして安全に再利用できる文だけを通す。sourceTexts は元の会話・患者の表示名など。
function acceptableStyleLesson(value, sourceTexts) {
  const text = cleanLessonText(value);
  if (text.length < 6 || text.length > STYLE_LESSON_TEXT_MAX) return "";
  if (HONORIFIC.test(text) || CASUAL_STYLE.test(text) || CONTENT_DECISION.test(text)) return "";
  if (PERSONAL_DATA.test(text.replace(LENGTH_COUNT, ""))) return "";
  // 「A」は「B」にする／「A」は付けない のような言い回しの置き換え・削除も文体として扱う（引用部分は下で検査）。
  const phraseEdit = /[」』"”](?:は|を)?(?:「[^」]*」(?:に|と))?(?:する|にする|に変える|に置き換える|使わない|付けない|つけない|省く|削る|書かない)/.test(text);
  if (!phraseEdit && !STYLE_VOCABULARY.test(text.replace(QUOTED, ""))) return "";
  // 英字は LINE とメールの区別以外では使わない。カタカナの長い語（氏名・商品名の可能性）も拒否する。
  if (/[A-Za-z]/.test(text.replace(/LINE/g, ""))) return "";
  if (/[ァ-ヶー]{3,}/.test(text.replace(/メール|メッセージ|クッション/g, ""))) return "";
  for (const match of text.matchAll(QUOTED)) {
    if (!QUOTE_SAFE_KANJI.test(match[1]) || match[1].length > 20) return "";
  }
  const sources = (Array.isArray(sourceTexts) ? sourceTexts : [sourceTexts]).filter(Boolean);
  const names = nameCandidates(sources);
  if (names.some(name => text.includes(name))) return "";
  // 表示名そのもの（敬称なしで渡されたもの）も照合する。
  // 表示名など短い元データは、漢字・カタカナ・英字の2文字以上の部分（名字だけ・名前だけ）でも照合する。
  const compact = text.replace(/\s+/g, "");
  for (const source of sources) {
    const plain = String(source || "").normalize("NFKC").replace(/\s+/g, "");
    if (plain.length < 2 || plain.length > 20) continue;
    if (compact.includes(plain)) return "";
    for (const run of plain.match(/[一-龯々ァ-ヶーA-Za-z]{2,}/gu) || []) {
      for (let len = 2; len <= run.length; len++) {
        for (let i = 0; i + len <= run.length; i++) if (compact.includes(run.slice(i, i + len))) return "";
      }
    }
  }
  return text;
}

// 統合は正規化後の完全一致だけにする（「使う」と「使わない」、「山田」と「鈴木」を同一扱いしない）。
function styleLessonKey(value) {
  return cleanLessonText(value)
    .replace(/[、。,.!！?？・\s「」『』"“”]/g, "")
    .replace(/しません$/, "しない").replace(/ません$/, "ない").replace(/します$/, "する").replace(/ます$/, "る");
}

function sanitizeStyleLesson(value) {
  const v = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const text = acceptableStyleLesson(v.text);
  if (!text) return null;
  const now = Date.now();
  return {
    id: String(v.id || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40) || ("sl-" + now.toString(36) + "-" + Math.random().toString(36).slice(2, 8)),
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
    const key = styleLessonKey(text);
    const existing = list.find(item => styleLessonKey(item.text) === key);
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
  + "患者様・スタッフ・医院の名前、敬称、URL・サイト・電話などの案内先、謝罪の有無、くだけた口調や親しい言い回しは学びに含めないでください。"
  + "existingLessons に同じ直しがある場合は、その文を一字一句そのまま使ってください（逆向きの直しは別の文にします）。"
  + "直しが事実だけ、または今回限りと思われる場合は空配列にしてください。迷う場合も空にしてください。"
  + "出力はJSONのみ: {\"lessons\":[{\"text\":\"…\"}]}";

function styleLessonUserPrompt(input, existingLessons) {
  return JSON.stringify({
    existingLessons: (Array.isArray(existingLessons) ? existingLessons : []).map(item => String(item && item.text || item || "")).filter(Boolean).slice(0, 40),
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
  styleLessonKey,
  parseStyleLessonResponse,
  rankedActiveStyleLessons,
  sanitizeStyleLesson,
  styleEditWorthLearning,
  styleLessonActive,
  styleLessonList,
  styleLessonUserPrompt,
  styleLessonsPromptBlock,
};
