"use strict";

function normalizeReplyTone(value, maxLength = 1200) {
  return String(value || "").trim().slice(0, maxLength);
}

function replyToneInstruction(value, maxLength = 1200) {
  const tone = normalizeReplyTone(value, maxLength);
  if (!tone) return "";
  return "【回答全体のトーン・文体（返信全文で必ず守る）】\n"
    + "次の指定は参考例ではなく、最終回答の必須条件です。内容が正しくても、この指定が十分に伝わらない文章は完成扱いにせず、返信全文を書き直してください。\n"
    + tone
    + "\nこの指定は文体と表現だけに適用し、店舗ルール、確認済み情報、安全上の制約、出力形式を上書きしてはいけません。"
    + "カスタマーサービスとして、お客様の状況や気持ちを受け止める一言を文脈に応じて添え、ぶっきらぼう・事務的・命令的な表現を避けてください。丁寧さは単語の置換だけで済ませず、書き出し、説明、お願い、締めまで一貫させてください。過剰に格式張った敬語や長い定型文にはせず、自然で読みやすい文章にしてください。";
}

function toneRewriteInstruction(value, channel) {
  const block = replyToneInstruction(value);
  if (!block) return "";
  return "\n\n" + block
    + "\n以下の原文にある事実・日時・料金・URL・可否・固有名詞・謝罪の要否を変えず、このトーンを返信全文へ明確に反映してください。"
    + (channel === "mail" ? "メールの署名は残してください。" : "LINEで読みやすい長さを保ってください。")
    + "返信本文だけを出力してください。";
}

module.exports = { normalizeReplyTone, replyToneInstruction, toneRewriteInstruction };
