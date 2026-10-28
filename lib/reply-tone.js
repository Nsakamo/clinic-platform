"use strict";

const PATIENT_COURTESY = "【患者様への文体（常に守る）】患者様には、受付側から一歩控えた姿勢で、礼儀正しく、やわらかく丁寧に対応する。結論や必要な案内を明確にしたうえで、確認をお願いするときは、必要に応じて『お手数をおかけしますが』と添え、『お知らせいただけますと幸いです』など状況に合う言葉で負担へ配慮する。お待たせする場合は、確認する内容と次にどう案内するかを落ち着いて伝える。断る場合も一方的に言い切らず、理由と可能な次の対応を根拠の範囲で丁寧に伝える。親しい友人への話し方や馴れ馴れしい相づちは使わない。気持ちを決めつける『気になりますよね』『ご心配ですよね』などの書き出しや、同意を求める『ですよね』は使わない。寄り添いは決まり文句で示さず、お問い合わせの内容を正確に受け止め、必要な説明と確認事項を心配りのある言葉で伝える。謝意やお詫びは状況に合う場合だけ簡潔に添え、過剰な敬語、不要な謝罪、長い前置き、同じ丁寧表現の繰り返しは避ける。";

function hasConversationalTone(value) {
  return /(?:よね|だね|かもね|気になります(?:よ)?ね|ご?(?:心配|不安)(?:です|になります)?(?:よ)?ね)(?=[、，,。．！？!?…〜～ー♪」』）)\s.]|\p{Extended_Pictographic}|$)/u.test(String(value || ""));
}

function applyCourtesyGate(draft, issues) {
  if (Array.isArray(issues) && issues.includes("conversational_tone")) draft.needs_human = true;
  return draft;
}

function normalizeReplyTone(value, maxLength = 1200) {
  return String(value || "").trim().slice(0, maxLength);
}

// includeCourtesy=false は、呼び出し側のプロンプトに PATIENT_COURTESY が既に入っている場合に使う（同じ指示の二重注入を避ける）。
function replyToneInstruction(value, maxLength = 1200, options) {
  const includeCourtesy = !(options && options.includeCourtesy === false);
  const tone = normalizeReplyTone(value, maxLength);
  if (!tone) return "";
  return "【回答全体のトーン・文体（返信全文で必ず守る）】\n"
    + "次の指定は参考例ではなく、最終回答の必須条件です。内容が正しくても、この指定が十分に伝わらない文章は完成扱いにせず、返信全文を書き直してください。\n"
    + tone
    + "\nこの指定は文体と表現だけに適用し、店舗ルール、確認済み情報、安全上の制約、出力形式を上書きしてはいけません。患者様への礼儀は個別のトーン設定より優先します。"
    + "カスタマーサービスとして、ぶっきらぼう・事務的・命令的な表現を避けてください。丁寧さは書き出しから締めまで一貫させ、確認や依頼には患者様の手間への配慮を自然に添えてください。過剰に格式張った敬語や長い定型文にはしないでください。"
    + (includeCourtesy ? "\n" + PATIENT_COURTESY : "");
}

function toneRewriteInstruction(value, channel, options) {
  const block = replyToneInstruction(value, 1200, options);
  if (!block) return "";
  return "\n\n" + block
    + "\n以下の原文にある事実・日時・料金・URL・可否・固有名詞・謝罪の要否を変えず、このトーンを返信全文へ明確に反映してください。"
    + (channel === "mail" ? "メールの署名は残してください。" : "LINEで読みやすい長さを保ってください。")
    + "返信本文だけを出力してください。";
}

// スタッフの1つの指示が、くだけた口調を求めるもの（casual）か、丁寧な文体へ戻すもの（formal）か。
// スタッフ自身の話し言葉（「これ違うよね」）や、患者の発言の引用（「痛いんだよね」って言ってる）は指示とみなさない。
// かぎ括弧の口語は、直後に「入れて・使って・にして」等の依頼がある場合だけ指示とみなす。
function staffToneDirection(instruction) {
  const text = String(instruction || "").normalize("NFKC");
  if (!text.trim()) return "";
  const casualWord = /(?:フランク|カジュアル|くだけ|砕け|親しみ(?:やすく|のある|を込め)|友達(?:みたい|のよう|っぽ)|タメ口|ため口|口語(?:で|っぽ|調)|(?:よね|ですよね)(?:を|も)?(?:入れ|付け|つけ|使)|(?:堅|固|硬)(?:苦しく|く)(?:ない|なく|しない|しすぎない))/;
  const quotedRequest = Array.from(text.matchAll(/[「『"“]([^」』"”]{1,120})[」』"”]\s*(?:って|と|を|も|に)?\s*(?:(?:文頭|冒頭|最初|最後|文末)に)?\s*(?:入れ|使|足し|加え|添え|追加|書い|書き|変え|直し|して|にして|言い換え)/g), match => match[1]);
  const casual = casualWord.test(text) || quotedRequest.some(phrase => hasConversationalTone(phrase));
  const formal = /(?:丁寧に|敬語(?:で|に)|かしこまっ|フォーマル|硬め|堅め|元の口調|口調を戻|くだけ(?:すぎ|ない)|フランクに?しない|カジュアルに?しない)/.test(text);
  if (formal && !casual) return "formal";
  if (casual && !formal) return "casual";
  if (casual && formal) return /(?:くだけ(?:すぎ|ない)|しない|戻)/.test(text) ? "formal" : "casual";
  return "";
}

function staffRequestsConversationalTone(instruction) {
  return staffToneDirection(instruction) === "casual";
}

// 相談の流れの中で、最新の口調指示が「くだけた口調」のまま撤回されていないか。
function staffAllowsConversationalTone(instructions) {
  const list = Array.isArray(instructions) ? instructions : [instructions];
  for (let index = list.length - 1; index >= 0; index--) {
    const direction = staffToneDirection(list[index]);
    if (direction) return direction === "casual";
  }
  return false;
}

module.exports = { PATIENT_COURTESY, applyCourtesyGate, hasConversationalTone, normalizeReplyTone, replyToneInstruction, staffAllowsConversationalTone, staffRequestsConversationalTone, staffToneDirection, toneRewriteInstruction };
