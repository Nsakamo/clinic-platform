"use strict";

const PATIENT_COURTESY = "【患者様への文体（常に守る）】患者様には、親しい友人への話し方や馴れ馴れしい相づちを使わず、落ち着いた丁寧語で礼儀正しく対応する。気持ちを決めつける『気になりますよね』『ご心配ですよね』などの書き出しや、同意を求める『ですよね』は使わない。寄り添いは決まり文句で示さず、お問い合わせの内容を正確に受け止め、必要な説明と確認事項を心配りのある言葉で伝える。謝意やお詫びは状況に合う場合だけ簡潔に添え、過剰な敬語や長い前置きは避ける。";

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

function replyToneInstruction(value, maxLength = 1200) {
  const tone = normalizeReplyTone(value, maxLength);
  if (!tone) return "";
  return "【回答全体のトーン・文体（返信全文で必ず守る）】\n"
    + "次の指定は参考例ではなく、最終回答の必須条件です。内容が正しくても、この指定が十分に伝わらない文章は完成扱いにせず、返信全文を書き直してください。\n"
    + tone
    + "\nこの指定は文体と表現だけに適用し、店舗ルール、確認済み情報、安全上の制約、出力形式を上書きしてはいけません。患者様への礼儀は個別のトーン設定より優先します。"
    + "カスタマーサービスとして、ぶっきらぼう・事務的・命令的な表現を避けてください。丁寧さは書き出しから締めまで一貫させ、過剰に格式張った敬語や長い定型文にはしないでください。\n"
    + PATIENT_COURTESY;
}

function toneRewriteInstruction(value, channel) {
  const block = replyToneInstruction(value);
  if (!block) return "";
  return "\n\n" + block
    + "\n以下の原文にある事実・日時・料金・URL・可否・固有名詞・謝罪の要否を変えず、このトーンを返信全文へ明確に反映してください。"
    + (channel === "mail" ? "メールの署名は残してください。" : "LINEで読みやすい長さを保ってください。")
    + "返信本文だけを出力してください。";
}

module.exports = { PATIENT_COURTESY, applyCourtesyGate, hasConversationalTone, normalizeReplyTone, replyToneInstruction, toneRewriteInstruction };
