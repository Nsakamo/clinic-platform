"use strict";

function isUnanswered(conversation) {
  return !conversation || conversation.status !== "done";
}

function compareConversations(a, b) {
  const aUnanswered = isUnanswered(a);
  const bUnanswered = isUnanswered(b);

  if (aUnanswered !== bUnanswered) return aUnanswered ? -1 : 1;

  // 未対応内では、明示的な「要対応」を従来どおり優先する。
  if (aUnanswered) {
    if (!!a.flag !== !!b.flag) return a.flag ? -1 : 1;
    if (a.flag && b.flag) {
      const orderDiff = Number(a.order || 0) - Number(b.order || 0);
      if (orderDiff) return orderDiff;
    }
  }

  return Number(b && b.ts || 0) - Number(a && a.ts || 0);
}

module.exports = { compareConversations, isUnanswered };
