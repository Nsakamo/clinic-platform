"use strict";

// Staff decisions must not be turned back into tentative patient-facing language.
function explicitEditMismatch(instruction, draft) {
  const ask = String(instruction || "").replace(/\s+/g, "");
  const answer = String(draft || "").replace(/\s+/g, "");
  if (!ask || !answer) return "";
  if (/(?:確認(?:しない|は不要|不要|せず|ではなく|じゃなく|するんじゃなく|しなくて)|確認する必要(?:は)?ない)/.test(ask)
      && /(?:確認(?:いたします|します|でき次第|が済むまで|したうえで)|確認後)/.test(answer)) return "確認を不要とする指示が、確認する案内に戻っています";
  if (/(?:充てる|当てる|あてる|充当する|適用する|キャンセルに使う)/.test(ask)
      && /(?:充てられるか|充当できるか|適用できるか|使えるか).{0,30}確認/.test(answer)) return "適用する指示が、適用できるか確認する案内に戻っています";
  return "";
}

module.exports = { explicitEditMismatch };
