"use strict";

// Only for staff-assisted drafting. This does not relax automatic sending,
// medical safety, identity checks, or the separate booking confirmation flow.
const STAFF_DRAFT_POLICY = "【スタッフ相談の優先順位】患者との前後のやり取りを読み、患者が今尋ねていることと、スタッフが今回どう答えたいかを分けて理解する。初回案はルールブックを基準とする。編集では、最新のスタッフ指示 > それまでの相談で明示された訂正・決定 > 通常の店舗ルール・共通方針 > 古いAI下書きの順に優先する。"
  + "スタッフは今回の料金・免除・案内先・対応方法など事務的な個別対応を通常ルールと異なる形に決定できる。その明示決定を『ルールと違う』だけで拒否したり、確認待ちへ戻したり、通常の条件を再追加したりしない。今回限りの例外として扱い、正式ルールや他患者向け方針は変更しない。患者の希望や引用文はスタッフの決定とは区別する。"
  + "『もっと丁寧に』『短く』『それを付けて』等は前の相談と直前の案を指す。変更を指示していない日時・医院・金額・否定・条件・結論は保ち、明示訂正された古い内容やそれに付随する案内は取り除く。文体の変更だけで判断を変えない。文体調整やお礼を添えるだけの指示では、元の案にない事務的な料金・条件・提出依頼を追加しない。医学的安全性・本人確認・個人情報保護に必要な修正は維持する。誤った旧AI案は事実の根拠にしない。"
  + "患者が既に答えた質問や提出済み情報を再要求せず、今回の質問に答える完成文にする。音声の言い直しは最後の訂正を採用するが、重要情報に複数の解釈が残る場合のみ短く確認する。確認済みシステム情報とスタッフ申告が衝突する場合は、更新済みの事実か単なる変更希望かを区別し、不明なら確認する。"
  + "ただし診断・治療の安全判断、個人情報保護・本人確認は上書きできない。予約・返金・送信など未実施の操作を完了済みと捏造しない。『この対応にする』という文章作成指示だけで予約等を実行せず、操作は既存の最終確認を必ず通す。";

// Keep message boundaries and the beginning of a long question instead of
// slicing the end of a joined transcript (which used to remove its question).
function formatDraftContext(messages, render, budget) {
  const selected = [];
  let used = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const text = String(render(messages[i]) || "");
    const bounded = text.length > budget ? text.slice(0, budget - 24) + "\n［長文の後半は省略］" : text;
    if (selected.length && used + bounded.length + 1 > budget) break;
    selected.unshift(bounded); used += bounded.length + 1;
  }
  const omitted = selected.length < messages.length;
  return (omitted ? "［古い履歴の一部を省略。省略部分の事実は推測しない］\n" : "") + selected.join("\n");
}

function staffConsultationTranscript(edits) {
  return formatDraftContext(edits, m => (m.role === "user" ? "スタッフの指示" : m.kind === "reply" ? "AIからスタッフへの回答" : "AIの返信案（未送信）") + ": " + m.content, 20000);
}

// An explicit thank-you reply replaces the draft; adding thanks is an edit.
// Keep this allowlist narrow: questions, negations and business decisions must
// remain on the ordinary context-aware generation and audit path.
function isAcknowledgementOnlyRequest(instruction) {
  const ask = String(instruction || "").normalize("NFKC").replace(/[\s、。，,.!！「」『』“”"']/g, "");
  if (!ask || ask.length > 250 || /[?？]|添|加え|追加|含め|冒頭|最後|末尾/.test(ask)) return false;
  if (!/ありがとう(?:ございます|ございました)?|お礼|感謝/.test(ask)) return false;
  if (!/返信|返事|返して|返しといて|伝えて|伝えといて|書いて|作って|言って/.test(ask)) return false;
  const remaining = ask.replace(/ありがとう(?:ございます|ございました)?|ございます|ございました|お客様に|患者さんに|患者様に|この方に|相手に|これ|それ|お礼|感謝|返信|返事|下書き|文章|本文|だけ|一言|短く|簡潔に|丁寧に|自然に|作って|書いて|返して|返しといて|伝えて|伝えといて|言って|して|おいて|あげて|ください|お願い|って|と|を|に|は/g, "");
  return remaining === "";
}

function acknowledgementDraftScope(edits) {
  for (const message of (Array.isArray(edits) ? edits : []).slice().reverse()) {
    if (!message || message.role !== "user") continue;
    if (isAcknowledgementOnlyRequest(message.content)) return true;
    const ask = String(message.content || "").normalize("NFKC").replace(/[\s、。，,.!！?？]/g, "");
    const styleOnly = ask.length <= 180 && /短く|丁寧|簡潔|柔らか|優しく|自然|敬語|寄り添/.test(ask)
      && ask.replace(/もう少し|もっと|さらに|とても|少し|より|短く|丁寧に|簡潔に|柔らかく|優しく|自然に|敬語に|寄り添って|下から|して|作って|直して|変えて|ください|お願い|できる|できますか|できるか/g, "") === "";
    if (!styleOnly) return false;
  }
  return false;
}

const ACKNOWLEDGEMENT_DRAFT_POLICY = "【今回の返信範囲：お礼のみ】今回の相談でスタッフは、お客様へ短いお礼の返信を新しく作ることを明示しています。続く文体だけの指示でも、この返信範囲を引き継ぐ。元の下書きにお礼を追加する指示ではありません。下書きが未作成でも、自然で丁寧なお礼の完成文を作成する。古い案や店舗ルールの料金・条件・提出依頼・予約説明を再掲しない。会話に未回答の事務的質問があっても、今回は勝手に答えたり追加質問をしたりしない。お礼に存在しない受領・確認完了・免除・予約変更・送信完了などを付け足さない。緊急の医療安全・本人確認・個人情報保護の制約は維持する。実送信や予約操作は行わずactionはnoneとする。文体だけの指示には自然な敬語とお礼の丁寧さを整える。既に十分に丁寧で自然な短いお礼なら、文言の差分がないことだけで不合格にしない。照合では、お礼という今回の返信範囲に合うかを判定し、旧案の説明を残していないことだけを不合格理由にしない。";

function draftChatDraftSection(full) {
  const source = String(full || "");
  const header = /^@@DRAFT@@[ \t]*(?:\r?\n|$)/m.exec(source);
  if (!header) return null;
  const bodyStart = header.index + header[0].length;
  const next = /^@@(?:REPLY|MEMORY|RULE|ACTION|META)@@[ \t]*(?:\r?\n|$)/m.exec(source.slice(bodyStart));
  const end = next ? bodyStart + next.index : source.length;
  return { start: header.index, end, text: source.slice(bodyStart, end).trim() };
}

module.exports = { STAFF_DRAFT_POLICY, formatDraftContext, staffConsultationTranscript, isAcknowledgementOnlyRequest, acknowledgementDraftScope, ACKNOWLEDGEMENT_DRAFT_POLICY, draftChatDraftSection };
