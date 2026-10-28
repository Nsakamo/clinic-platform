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
// 学びの文は、下の決まった語だけでできている場合に限り受け付ける（閉じた語彙の許可リスト）。
// 名前・案内先・内容・優先順位・言語の変更など、ここに無い語が1つでも残れば保存しない。
const STYLE_TOKENS = [
  // 文体の対象
  "冒頭部分", "冒頭", "書き出し", "文頭", "文末", "末尾", "締めくくり", "締め", "結び", "最後", "最初", "先頭", "あいさつ", "挨拶",
  "結論", "要点", "前置き", "箇条書き", "改行", "空行", "段落分け", "段落", "句読点", "読点", "句点", "一文", "一行", "文章", "文字数", "文字", "文",
  "二重敬語", "丁寧語", "謙譲語", "敬語", "定型句", "定型文", "定型", "繰り返し", "重複", "長さ", "お礼の言葉", "お礼", "感謝", "クッション言葉",
  "言い回し", "表現", "語尾", "本文", "署名", "宣言", "保険表現", "格式張った", "格式", "丁寧すぎる", "回りくどい", "過剰な", "過剰",
  "長い", "長く", "長め", "短く", "短め", "簡潔に", "簡潔", "硬い", "硬く", "堅い", "堅く", "同じ", "全体", "一つ", "一度", "以内", "程度",
  "LINE", "メール", "返信", "後", "言葉",
  // 動詞・語尾
  "にまとめる", "まとめない", "まとめる", "にしない", "にする", "しない", "する", "書かない", "書く", "書き", "付けない", "付ける", "つけない", "つける",
  "省く", "削る", "入れない", "入れる", "使わない", "使う", "分けない", "分ける", "減らす", "重ねない", "重ねて", "繰り返さない", "そろえる", "揃える",
  "置かない", "置く", "始めない", "始める", "控える", "避ける", "増やさない", "続けない", "使わず", "書かず", "付けず", "入れず", "重ねず",
  // 助詞・つなぎ
  "ではなく", "では", "には", "とは", "から", "まで", "だけ", "ずつ", "より", "せず", "なく", "ない",
  "は", "を", "に", "で", "の", "と", "も", "が", "へ", "や", "ず", "し", "、", "・", " ",
].sort((a, b) => b.length - a.length);
// 「」で引用してよいのは、受付の定型的な丁寧表現だけ（置き換え先も丁寧語に限られる）。
const POLITE_PHRASES = new Set([
  "させていただきます", "させて頂きます", "させていただく", "いたします", "致します", "いたしました", "します", "しました", "です", "ます", "です・ます",
  "でございます", "ございます", "ください", "下さい", "くださいませ", "いただけますと幸いです", "いただけますでしょうか", "幸いです", "存じます", "申し上げます",
  "お願いいたします", "お願い致します", "お願いします", "よろしくお願いいたします", "よろしくお願いします", "何卒よろしくお願い申し上げます",
  "今後ともよろしくお願いいたします", "引き続きよろしくお願いいたします", "お手数ですが", "お手数をおかけしますが", "恐れ入りますが", "恐縮ですが",
  "ご不明点がございましたら", "ご不明な点がございましたら", "お気軽にご連絡ください", "ご確認ください", "ご確認いただけますと幸いです",
  "ご連絡ありがとうございます", "お問い合わせありがとうございます", "ありがとうございます", "ありがとうございました", "いつもありがとうございます",
  "お世話になっております", "承知いたしました", "かしこまりました", "承りました", "失礼いたします", "お待ちしております", "拝見いたします",
]);
const QUOTED = /[「『"“]([^」』"”]*)[」』"”]/g;

function politeQuote(phrase) {
  return POLITE_PHRASES.has(String(phrase || "").replace(/^[〜~…\s]+|[。、！？!?…\s]+$/g, ""));
}

// 許可語の組み合わせでも、丁寧さを外す・返信の中身を削る・送信経路を変える学びは保存しない。
const CORE_POLITE = new Set(["です", "ます", "です・ます", "ください", "下さい", "いたします", "致します", "ございます", "でございます"]);
function weakensReply(text) {
  const negation = /(?:使わ|付けない|つけない|付けず|しない|せず|省く|削る|入れない|入れず|控え|避け|減らす|書かない|書かず)/;
  // 二重敬語・過剰な敬語を控えるのは文体の改善として許す。それ以外の敬語・丁寧語の否定は拒否。
  const plainKeigo = text.replace(/(?:二重|過剰な|過剰|格式張った)(?:敬語|丁寧語)/g, "");
  if (/(?:敬語|丁寧語)/.test(plainKeigo) && negation.test(plainKeigo)) return true;
  for (const match of text.matchAll(QUOTED)) {
    const phrase = String(match[1] || "").replace(/^[〜~…\s]+|[。、！？!?…\s]+$/g, "");
    const after = text.slice(match.index + match[0].length, match.index + match[0].length + 8);
    if (CORE_POLITE.has(phrase) && negation.test(after) && !/^\s*(?:は|を)?\s*「/.test(after)) return true;
  }
  if (/(?:返信|本文|結論|要点|署名)[^、。]*?(?:しない|せず|入れない|入れず|控え|避け|書かない|書かず|だけ)/.test(text)) return true;
  if (/(?:返信|本文|結論|要点|署名)[^、。]*?「/.test(text)) return true;
  if (/(?:LINE|メール)\s*ではなく/.test(text)) return true;
  return false;
}

// 引用を除いた残りが、許可した語と長さの数だけで組み立てられているか。
function onlyStyleTokens(text) {
  const rest = text.replace(LENGTH_COUNT, "\u0000");
  let index = 0;
  while (index < rest.length) {
    if (rest[index] === "\u0000") { index++; continue; }
    const token = STYLE_TOKENS.find(word => rest.startsWith(word, index));
    if (!token) return false;
    index += token.length;
  }
  return true;
}

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
  // 多重防御: 敬称・口調・内容の拒否語に当たるものは、許可リストの判定より前に捨てる。
  if (HONORIFIC.test(text) || CASUAL_STYLE.test(text) || CONTENT_DECISION.test(text)) return "";
  if (PERSONAL_DATA.test(text.replace(LENGTH_COUNT, ""))) return "";
  for (const match of text.matchAll(QUOTED)) if (!politeQuote(match[1])) return "";
  if (!onlyStyleTokens(text.replace(QUOTED, "\u0000"))) return "";
  if (weakensReply(text)) return "";
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
  + "学びの文は、冒頭・書き出し・締め・結び・あいさつ・結論・前置き・箇条書き・改行・段落・一文・文章・敬語・二重敬語・定型句・繰り返し・お礼の言葉・言い回し・表現・語尾・長さ などの語と、する／しない／付けない／省く／まとめる／使わない／短くする 等の動詞だけで書いてください。"
  + "「」で引用してよいのは『させていただきます』『いたします』『ございます』『ください』『お手数ですが』『恐れ入りますが』『ご不明点がございましたら』『よろしくお願いいたします』のような受付の定型的な丁寧表現だけで、置き換え先も丁寧語にしてください。"
  + "existingLessons に同じ直しがある場合は、その文を一字一句そのまま使ってください（逆向きの直しは別の文にします）。"
  + "直しが事実だけ、または今回限りと思われる場合は空配列にしてください。迷う場合も空にしてください。"
  + "出力はJSONのみ: {\"lessons\":[{\"text\":\"…\"}]}";

// 文体学習の対象外にする「丁寧語でない」文末の判定（自動送信の礼儀ゲートより厳しい、学習専用の判定）。
// 「確認するね」「しとく」「またね」「ありがとね」などを含む送信からは学ばない。
function casualSentenceEnding(value) {
  return String(value || "").normalize("NFKC").split(/[。！？!?\n]+/).map(part => part.replace(/[\s、…〜~ー♪)）」』]+$/u, "")).filter(part => part.length >= 2)
    .some(part => /(?:了解|りょ|よろしく|よろ|ok|OK|おけ|おk)$/u.test(part) || /(?:(?<!です|ます|ません|ました|でした|ください|ませ|でしょう)(?:ね|よ|な|わ|ぞ|ぜ|さ)|とく|とくね|じゃん|じゃない|っす|だ|だよ|だね|だった|する|した|しよう|しない|ない|ある|いる|ちゃう|ちゃった|じゃ|けど|から|って)$/u.test(part)
      && !/(?:です|ます|ません|ました|でした|ください|くださいませ|ございます|いたします|存じます|幸いです|申し上げます|でしょうか|ませんか|サポート)$/u.test(part));
}

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
  casualSentenceEnding,
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
