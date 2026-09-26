"use strict";

// Staff decisions must not be turned back into tentative patient-facing language.
function explicitEditMismatch(instruction, draft) {
  const ask = String(instruction || "").replace(/\s+/g, "");
  const answer = String(draft || "").replace(/\s+/g, "");
  if (!ask || !answer) return "";
  const noConfirmation = /(?:確認(?:しない(?!と)|は不要|不要|せず|を要さず|を行わず|ではなく|じゃなく|するんじゃなく|しなくて)|確認する必要(?:は)?ない)/.test(ask);
  const pendingConfirmation = ask.replace(/確認(?:済み|済|した(?:ので|ため|結果)|しました(?:ので|ため|結果))/g, "");
  const confirmationRequested = !noConfirmation && /(?:確認|確かめ|照会)/.test(pendingConfirmation);
  if (noConfirmation
      && /(?:確認(?:いたします|します|でき次第|が済むまで|したうえで)|確認後)/.test(answer)) return "確認を不要とする指示が、確認する案内に戻っています";
  if (confirmationRequested
      && /(?:充て|当て|あて|充当|適用)(?:ます|いたします|します|させていただきます)/.test(answer)) return "可否を確認する指示が、適用を確約する案内に変わっています";
  if (/(?:充てる|当てる|あてる|充当する|適用する|キャンセルに使う)/.test(ask)
      && !confirmationRequested
      && /(?:充てられるか|充当できるか|適用できるか|使えるか).{0,30}確認/.test(answer)) return "適用する指示が、適用できるか確認する案内に戻っています";
  return "";
}

function normalizeDraftEditHistory(requestedEdits) {
  const edits = requestedEdits.slice();
  while (edits.length && edits[0].role === "assistant") {
    if (edits[0].kind === "reply") { edits.shift(); continue; }
    edits[0] = { role: "user", content: "【現在の下書き（あなたが既に作成済み）】\n" + edits[0].content };
    if (edits[1] && edits[1].role === "user") { edits[0].content += "\n\n" + edits[1].content; edits.splice(1, 1); }
    break;
  }
  return edits;
}

function isDraftChatConsultation(instruction) {
  const ask = String(instruction || "").trim();
  return /(?:だっけ|どう思う|いくら|教えて|違いは|どっち|どちら|失礼はない|これでいい|これで大丈夫|どうしたら)/.test(ask)
    && !/(?:直して|変えて|書いて|作って|追加して|削って|伝えて|案内して|入れて|修正して|整えて|確認して|短く|丁寧に|優しく|柔らかく|簡潔に|文章に|返信に|文にして)/.test(ask);
}

module.exports = { explicitEditMismatch, normalizeDraftEditHistory, isDraftChatConsultation };
