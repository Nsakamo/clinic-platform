"use strict";

// 患者様への既定の文体。スタッフが毎回「丁寧に」と言い直さなくてよいよう、最初の下書きから
// 受付側が一歩へりくだった、とても丁寧な敬語で書く（運用方針・2026-11-02）。
const PATIENT_COURTESY = "【患者様への文体（常に守る・既定）】患者様には、受付側が一歩へりくだった姿勢で、とても丁寧な敬語で返信する。尊敬語・謙譲語を正しく使い（例:『ご連絡いただき』『確認いたします』『ご案内いたします』『承知いたしました』『恐れ入りますが』『お手数をおかけいたしますが』『〜いただけますと幸いです』『〜くださいませ』）、『ございます』『いたします』『くださいませ』を使うことをためらわない。書き出しには、お問い合わせやご連絡へのお礼（例:『お問い合わせいただき、誠にありがとうございます。』）を状況に合わせて一言添え、ご不便やお待たせがある場合はお詫びを添える。お願いや確認をする時は、クッション言葉で負担への配慮を伝える。断る場合も一方的に言い切らず、理由と可能な次の対応を根拠の範囲で丁寧に伝える。締めには『ご不明な点がございましたら、お気軽にお問い合わせくださいませ。』『何卒よろしくお願いいたします。』など、状況に合う丁寧な結びを添える。友人への話し方、馴れ馴れしい相づち、命令口調、事務的で素っ気ない言い切りは使わない。気持ちを決めつける『気になりますよね』『ご心配ですよね』や、同意を求める『ですよね』は使わない。誤った二重敬語（拝見させていただく、ご確認していただく、お伺いさせていただく）は使わない。寄り添いや丁寧さは決まり文句を並べて示さず、お問い合わせの内容を正確に受け止めて、それに即した言葉で伝える。お待たせする場合は、確認する内容と院側が次にどうご案内するかを伝える。同じお詫びや前置きを重ねて長くしない。丁寧にしても、結論・必要な案内・次にしていただくことは、はっきり分かるように書く。";

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
    + "カスタマーサービスとして、ぶっきらぼう・事務的・命令的な表現を避けてください。丁寧さは書き出しから締めまで一貫させ、確認や依頼には患者様の手間への配慮を自然に添えてください。誤った二重敬語は避けてください。\n"
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
