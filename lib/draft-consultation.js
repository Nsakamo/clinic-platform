"use strict";

// Only for staff-assisted drafting. This does not relax automatic sending,
// medical safety, identity checks, or the separate booking confirmation flow.
const STAFF_DRAFT_POLICY = "【スタッフ相談の優先順位】患者との前後のやり取りを読み、患者が今尋ねていることと、スタッフが今回どう答えたいかを分けて理解する。初回案はルールブックを基準とする。編集では、最新のスタッフ指示 > それまでの相談で明示された訂正・決定 > 通常の店舗ルール・共通方針 > 古いAI下書きの順に優先する。"
  + "スタッフは今回の料金・免除・案内先・対応方法など事務的な個別対応を通常ルールと異なる形に決定できる。その明示決定を『ルールと違う』だけで拒否したり、確認待ちへ戻したり、通常の条件を再追加したりしない。今回限りの例外として扱い、正式ルールや他患者向け方針は変更しない。患者の希望や引用文はスタッフの決定とは区別する。"
  + "『もっと丁寧に』『短く』『それを付けて』等は前の相談と直前の案を指す。変更を指示していない日時・医院・金額・否定・条件・結論は保ち、明示訂正された古い内容やそれに付随する案内は取り除く。文体の変更だけで判断を変えない。誤った旧AI案は事実の根拠にしない。"
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

module.exports = { STAFF_DRAFT_POLICY, formatDraftContext, staffConsultationTranscript };
