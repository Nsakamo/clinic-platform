"use strict";

const tentativeApplication = /(?:充て|当て|あて|充当|適用|ご利用|お使い|利用|使)[^。、]{0,14}(?:られる|できる|可能|いただける|ことができる|える)か(?:どうか)?.{0,30}(?:確認|確かめ|調べ|照会|検討)|(?:充当可否|適用可否|利用可否|使用可否).{0,30}(?:確認|確かめ|調べ|照会|検討)/;
const decidedApplication = /(?:充て|当て|あて|充当|適用)[^。、]{0,14}(?:いたします|します|ます|させていただきます)/;

// Staff decisions must not be turned back into tentative patient-facing language.
function explicitEditMismatch(instruction, draft, previousDraft = "") {
  const ask = String(instruction || "").replace(/\s+/g, "");
  const answer = String(draft || "").replace(/\s+/g, "");
  if (!ask || !answer) return "";
  const noConfirmation = /(?:確認(?:は?(?:不要|いらない|要らない|しないで|しない(?!と))|不要|なし|せず|を要さず|を行わず|を取らず|ではなく|じゃなく|するんじゃなく|しなくて)|確認する必要(?:は)?ない)/.test(ask);
  const remaining = ask.replace(/確認(?:済み|済|した(?:ので|ため|結果)|しました(?:ので|ため|結果)|(?:が)?(?:取れ|とれ|でき)(?:た|ました)(?:ので|ため|から)?)/g, "");
  const applying = /(?:充て(?:る|て)|当て(?:る|て)|あて(?:る|て)|充当(?:する|して)|適用(?:する|して)|キャンセルに使(?:う|って))/.test(ask);
  // Only an explicit check of ticket eligibility can reverse a decided application.
  // A later request to ask the patient to check the reply must not do so.
  const checksApplication = /(?:充て(?:る|られる)|当て(?:る|られる)|あて(?:る|られる)|充当(?:する|できる)|適用(?:する|できる)|使(?:う|える))か(?:どうか)?.{0,25}(?:要確認|確認|確かめ|照会)|(?:充当可否|適用可否|チケット.{0,12}可否).{0,20}(?:確認|確かめ|照会)/.test(remaining);
  const confirmationRequested = !noConfirmation && checksApplication;
  const decisionRequested = noConfirmation || !/(?:確認|確かめ|照会)/.test(remaining);
  if (noConfirmation
      && /(?:確認(?:いたします|します|でき次第|が済むまで|したうえで)|確認後)/.test(answer)) return "確認を不要とする指示が、確認する案内に戻っています";
  if (confirmationRequested && decidedApplication.test(answer) && !tentativeApplication.test(answer)) return "可否を確認する指示が、適用を確約する案内に変わっています";
  if (applying && decisionRequested && !confirmationRequested
      && tentativeApplication.test(answer)) return "適用する指示が、適用できるか確認する案内に戻っています";
  const prior = String(previousDraft || "").replace(/\s+/g, "");
  const priorDecision = decidedApplication.test(prior) && !tentativeApplication.test(prior);
  const nonPatientAsk = ask.replace(/(?:ご確認(?:を)?(?:お願い(?:します|いたします)?|ください|いただけますか)|確認してもら(?:って|う)|確認いただ(?:き|いて|けますか)|確認してください)/g, "");
  const explicitReversal = checksApplication || /(?:確認|確かめ|照会|調べ|聞|保留|やめ|戻|決ま.{0,4}ない|未確定|未決定|可否)/.test(nonPatientAsk);
  if (priorDecision && !explicitReversal
      && tentativeApplication.test(answer)) return "前の下書きで確定した適用が、最新指示なしに可否確認へ戻っています";
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
  const question = /(?:[?？]|でしょうか|ですか|だっけ|どう思う)$/.test(ask);
  const clearConsultation = /(?:だっけ|どう思う|いくら|失礼はない|これでいい|これで大丈夫|違い|どっち.{0,20}(?:いい|よい)|どちら.{0,20}(?:いい|よい)|どうしたら)/.test(ask);
  const editRequest = /(?:と(?:返|添|伝|書|記載|案内|言|教え)|返して|添えて|載せて|記載して|書き足して|加えて|付けて|消して|省いて|言って|変更して|直して|変えて|書いて|作って|追加して|削って|伝えて|案内して|入れて|修正して|整えて|確認して|短く|丁寧に|優しく|柔らかく|簡潔に|文章に|返信に|文にして)/.test(ask);
  return question && clearConsultation && !editRequest;
}

module.exports = { explicitEditMismatch, normalizeDraftEditHistory, isDraftChatConsultation };
