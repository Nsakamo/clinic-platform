"use strict";

// 「右腕くんに相談」のAI出力を読み取り、画面へ返す形を組み立てる。
// AIの出力形式が多少崩れても（```で囲む、マーカーが行の途中、太字、順序違い等）
// 失敗にせず各項目を取り出す。画面へはAIの生テキストを渡さず、ここで取り出した値から
// 常に正しい形の封筒をサーバー側で組み立て直すため、照合していない本文が画面に出ることはない。

const MARKERS = ["REPLY", "DRAFT", "MEMORY", "RULE", "ACTION", "META"];

function stripFence(raw) {
  return String(raw || "").trim().replace(/^```[a-zA-Z]*\s*\n?/, "").replace(/\n?```\s*$/, "").trim();
}

// 本文中に紛れた制御マーカーを取り除く（封筒の組み立てで二重解釈されないように）
function stripMarkers(text) {
  return String(text || "").replace(/\*{0,2}@@\s*(?:REPLY|DRAFT|MEMORY|RULE|ACTION|META)\s*@@\*{0,2}/g, "").trim();
}

function firstJsonObject(text) {
  const s = String(text || "");
  const start = s.indexOf("{");
  if (start < 0) return null;
  // 最も外側の { ... } を、文字列内の括弧を無視して探す
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === "\"") inStr = false;
      continue;
    }
    if (ch === "\"") inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) { try { return JSON.parse(s.slice(start, i + 1)); } catch (e) { return null; } } }
  }
  return null;
}

function salvageJsonString(raw, key) {
  const m = String(raw || "").match(new RegExp('"' + key + '"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)'));
  if (!m) return null;
  try { return JSON.parse('"' + m[1] + '"'); } catch (e) { return m[1].replace(/\\n/g, "\n").replace(/\\"/g, '"'); }
}

function parseJsonField(value) {
  if (value && typeof value === "object") return value;
  const text = String(value || "").trim();
  if (!text) return null;
  return firstJsonObject(text);
}

// マーカー形式（旧形式）の寛容な読み取り。マーカーが行頭でなくても、太字でも区切りとして扱う。
function parseMarkerOutput(source) {
  const found = [];
  for (const m of source.matchAll(/\*{0,2}@@\s*(REPLY|DRAFT|MEMORY|RULE|ACTION|META)\s*@@\*{0,2}/g)) found.push({ name: m[1], start: m.index, end: m.index + m[0].length });
  if (!found.length) return null;
  const sections = {};
  found.forEach((m, i) => {
    const body = source.slice(m.end, i + 1 < found.length ? found[i + 1].start : source.length).replace(/^[ \t]*:?[ \t]*\r?\n?/, "").trim();
    // 同じ見出しが2回出た場合は、最初の値を正とする（後から差し込まれた本文で上書きさせない）
    if (!(m.name in sections)) sections[m.name] = body;
  });
  const lead = source.slice(0, found[0].start).trim();
  return {
    reply: sections.REPLY != null ? sections.REPLY : lead,
    draft: sections.DRAFT != null ? sections.DRAFT : null,
    memory: sections.MEMORY || "",
    rule: parseJsonField(sections.RULE),
    action: parseJsonField(sections.ACTION),
  };
}

// 戻り値: { reply, draft (null=下書きの指定なし), memory, rule, action, format }
function parseDraftChatOutput(raw) {
  const source = stripFence(raw);
  if (!source) return null;
  const json = /^\s*\{/.test(source) || !/@@\s*(?:REPLY|DRAFT)\s*@@/.test(source) ? firstJsonObject(source) : null;
  if (json && typeof json === "object" && ("reply" in json || "draft" in json)) {
    return {
      reply: stripMarkers(json.reply),
      draft: json.draft == null ? null : stripMarkers(json.draft),
      memory: stripMarkers(json.memory),
      rule: json.rule && typeof json.rule === "object" ? json.rule : parseJsonField(json.rule),
      action: json.action && typeof json.action === "object" ? json.action : parseJsonField(json.action),
      format: "json",
    };
  }
  const markers = parseMarkerOutput(source);
  if (markers) {
    return {
      reply: stripMarkers(markers.reply), draft: markers.draft == null ? null : stripMarkers(markers.draft),
      memory: stripMarkers(markers.memory), rule: markers.rule, action: markers.action, format: "markers",
    };
  }
  // JSONが途中で切れた等: 取り出せる項目だけ救出する
  const reply = salvageJsonString(source, "reply"), draft = salvageJsonString(source, "draft");
  if (reply != null || draft != null) return { reply: stripMarkers(reply || ""), draft: draft == null ? null : stripMarkers(draft), memory: "", rule: null, action: null, format: "salvaged" };
  // 形式なしの文章: 下書きではなくスタッフへの返事として扱う（照合を経ない文を患者向け案にしない）
  return { reply: stripMarkers(source).slice(0, 1200), draft: null, memory: "", rule: null, action: null, format: "plain" };
}

// 画面（互換クライアント）向けの封筒を、取り出した値から常に正しい順序・単独行で組み立てる。
function buildDraftChatEnvelope(parts) {
  const p = parts || {};
  const lines = ["@@REPLY@@", stripMarkers(p.reply) || "確認しました。"];
  const draft = stripMarkers(p.draft);
  if (draft) lines.push("@@DRAFT@@", draft);
  lines.push("@@MEMORY@@", stripMarkers(p.memory));
  lines.push("@@RULE@@", p.rule && typeof p.rule === "object" ? JSON.stringify({ title: stripMarkers(p.rule.title), content: stripMarkers(p.rule.content) }) : "");
  lines.push("@@ACTION@@", JSON.stringify(p.action && typeof p.action === "object" ? p.action : { type: "none" }));
  return lines.join("\n");
}

// 「丁寧に」「短く」「温かく」など、文体だけを変える指示か。
// 事実（数字・日時・金額・可否・案内先など）を含む指示は対象外にし、通常の照合を通す。
const STYLE_WORDS = /(丁寧|ていねい|温か|あたたか|暖か|柔らか|やわらか|優し|やさし|短く|みじかく|簡潔|端的|自然|敬語|寄り添|親身|硬く|かたく|固く|堅く|カジュアル|フォーマル|フレンドリー|上品|読みやす|分かりやす|わかりやす|すっきり|落ち着|控えめ|謙虚|へりくだ|言い方|言い回し|表現|トーン|口調|文体|語尾|長く|詳しく|くどく|まわりくど|回りくど|冷た|事務的|ぶっきらぼう)/;
const STYLE_FILLER_WORDS = ["まわりくどく", "分かりやすく", "温かみのある", "ぶっきらぼう", "わかりやすく", "フレンドリー", "へりくだった", "もうちょっと", "できますか", "書き直して", "作り直して", "寄り添った", "いたします", "ちょうだい", "読みやすく", "回りくどく", "やわらかく", "しすぎない", "あたたかく", "読みやすい", "落ち着いた", "カジュアル", "フォーマル", "あたたかい", "もうちょい", "寄り添って", "下書きを", "ていねい", "柔らかく", "もう少し", "変更して", "言い回し", "全体的に", "寄り添う", "みじかく", "ちょっと", "柔らかい", "やさしく", "ください", "この文を", "すっきり", "文章を", "言い方", "これを", "詳しく", "とても", "くどく", "します", "全体を", "温かみ", "下さい", "欲しい", "しない", "かなり", "優しい", "冷たく", "下書き", "返信を", "冷たい", "感じに", "ほしい", "にして", "すごく", "それを", "トーン", "雰囲気", "にする", "できる", "暖かい", "もっと", "ように", "全文を", "この文", "温かい", "くどい", "暖かく", "かたく", "優しく", "直して", "さらに", "しすぎ", "変えて", "事務的", "控えめ", "お願い", "温かく", "整えて", "全文", "たい", "敬語", "謙虚", "長く", "過ぎ", "それ", "かな", "して", "堅い", "表現", "語尾", "すぎ", "ない", "簡潔", "上品", "より", "少し", "って", "堅く", "返信", "短く", "端的", "感じ", "全体", "する", "これ", "硬い", "口調", "文体", "印象", "固い", "頂戴", "案を", "硬く", "親身", "固く", "自然", "丁寧", "文章", "と", "で", "な", "が", "ね", "案", "を", "よ", "の", "は", "に"];
const STYLE_FILLER = new RegExp("(" + STYLE_FILLER_WORDS.join("|") + ")", "g"); // 長い語から先に照合する
function isStyleOnlyInstruction(instruction) {
  const ask = String(instruction || "").normalize("NFKC").replace(/[\s、。，,.!！?？「」『』“”"'()（）・…〜～ー-]/g, "");
  if (!ask || ask.length > 80 || !STYLE_WORDS.test(ask)) return false;
  // 事実・判断に触れる語があれば文体だけの指示とはみなさない
  if (/[0-9０-９]|円|料金|金額|無料|有料|返金|免除|キャンセル|変更|予約|日時|日程|時間|曜日|明日|今日|本日|来週|医院|院|住所|URL|リンク|電話|メール|追加|加え|添え|削除|消して|省い|入れて|載せ|書いて|伝え|謝罪|お詫び|お礼|ありがとう|確認|案内|不要|できない|しない(?!すぎ)|やめ|戻/.test(ask.replace(/(?:しすぎない|すぎない|ないように)/g, ""))) return false;
  return ask.replace(STYLE_FILLER, "") === "";
}

// 過去にスタッフが送った返信を「書き方の見本」にするため、個人・日時・数値を伏せる。
// 見本の事実（金額・日時など）を他の患者への返信で使わせないよう、数字はすべて伏字にする。
const NOT_A_NAME = /(?:客|患者|皆|各位|利用者|会員|家族|子|奥|先生|担当|スタッフ|受付|医師|院長|方々|皆々)$/;
function maskStyleSample(text) {
  return String(text || "")
    .replace(/https?:\/\/[^\s　）)」』]+/g, "［URL］")
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "［メール］")
    .replace(/(?:\+?81[-\s]?)?0\d{1,4}[-\s(（]?\d{1,4}[-\s)）]?\d{3,4}/g, "［電話番号］")
    .replace(/[0-9０-９]{1,4}\s*[年\/／.-]\s*[0-9０-９]{1,2}\s*[月\/／.-]\s*[0-9０-９]{1,2}\s*日?/g, "［日付］")
    .replace(/[0-9０-９]{1,2}\s*月\s*[0-9０-９]{1,2}\s*日/g, "［日付］")
    .replace(/[0-9０-９]{1,2}\s*[:：時]\s*[0-9０-９]{0,2}\s*分?/g, "［時刻］")
    .replace(/[一-龯々ァ-ヶーA-Za-zＡ-Ｚａ-ｚ]{1,10}(?=\s*(?:様|さま|さん|ちゃん|くん|殿))/gu, (word) => (NOT_A_NAME.test(word) ? word : "◯◯"))
    .replace(/[0-9０-９][0-9０-９,，.．]*/g, "◯")
    .trim();
}

module.exports = { MARKERS, parseDraftChatOutput, buildDraftChatEnvelope, isStyleOnlyInstruction, maskStyleSample, stripMarkers, firstJsonObject };
