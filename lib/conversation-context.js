const TOPIC_GAP_MS = 8 * 60 * 60 * 1000;
const REFERENCE_RE = /(先ほど|さっき|先日|以前|前回|この前|その件|こちらの件|それについて|続き|改めて|ご説明|説明いただ|伺った|言われた|返信|回答|上記|下記)/;
// Generic editing words (返信/回答/上記) do not reference a past topic.
const EXPLICIT_HISTORY_RE = /(先ほどの|さっきの|先日の|以前の|前回の|この前の|前に(?:案内|説明|伝え)|過去の(?:説明|案内|やり取り)|その件|こちらの件|それについて|ご説明いただ|説明いただ|伺った|言われた|続き)/;
// Require a noun boundary: 案内/文書/文言/文面 are patient guidance, not 案/文.
const DRAFT_REFERENCE_RE = /(?:先ほど|さっき|以前|前回|この前)の(?:返信(?:案)?|返答|下書き|文章|案|文)(?=$|[\s、。！？!?「」『』（）()]|[をにはがもでとの])/g;
const ACK_RE = /^(?:はい|承知(?:しました|いたしました)|かしこまりました|了解(?:しました|です)|ありがとうございます)[。！!]*$/;
const CONTINUATION_RE = /^(?:はい[、,。]\s*)?(?:それ(?:なら|で|を|に)|そちら|その(?:件|案内|時間|医院)|では|じゃあ)/;

function messageAt(message) {
  const value = Number(message && (message.at || message.sentAt || message.receivedAt || message.createdAt || message.ts));
  return Number.isFinite(value) && value > 0 ? value : 0;
}

// Legacy replies did not record send times. Retain a conversation-activity
// approximation only for topic separation; messageAt/prompts never use it.
function preserveTopicBoundary(conversation) {
  const messages = conversation && conversation.msgs;
  const previous = Array.isArray(messages) && messages[messages.length - 1];
  const activityAt = Number(conversation && conversation.ts);
  if (previous && !messageAt(previous) && !previous.topicActivityAt && Number.isFinite(activityAt) && activityAt > 0) {
    previous.topicActivityAt = activityAt;
  }
}

function topicAt(message) {
  const value = messageAt(message) || Number(message && message.topicActivityAt);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function textOf(message) {
  return String(message && (message.text || (message.media ? "［" + message.media + "］" : "")) || "").trim();
}

function bigrams(value) {
  const s = String(value || "").replace(/[\s、。！？!?・「」『』（）()]/g, "");
  const out = new Set();
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
  return out;
}

function overlap(a, b) {
  const A = bigrams(a), B = bigrams(b);
  if (!A.size || !B.size) return 0;
  let hits = 0; A.forEach(token => { if (B.has(token)) hits++; });
  return hits / Math.max(1, Math.min(A.size, B.size));
}

function splitByGap(messages) {
  const segments = []; let current = [];
  for (const message of messages) {
    const prev = current[current.length - 1];
    const before = topicAt(prev), now = topicAt(message);
    if (current.length && before && now && now - before >= TOPIC_GAP_MS) { segments.push(current); current = []; }
    current.push(message);
  }
  if (current.length) segments.push(current);
  return segments;
}

function selectConversationContext(conversation, options) {
  const all = Array.isArray(conversation && conversation.msgs) ? conversation.msgs : [];
  const start = Math.min(all.length, Math.max(0, Number(conversation && conversation.handledThroughIndex) || 0));
  const active = all.slice(start);
  if (!active.length) {
    // Deliberately opening staff consultation on a handled conversation still
    // needs its last patient question. Automatic generation remains unchanged.
    if (all.length && options && options.includeHandledReference) return selectConversationContext({ msgs: all }, options);
    return { current: [], olderRelevant: [], separated: false };
  }
  const segments = splitByGap(active);
  const current = segments[segments.length - 1].slice(-(options && options.maxCurrent || 20));
  const latestPatient = current.slice().reverse().find(item => item && item.from === "them");
  const latestText = textOf(latestPatient);
  const staffText = String(options && options.referenceText || "");
  const staffMode = !!(options && options.includeHandledReference);
  let olderRelevant = [];
  if (segments.length > 1 || (start && options && options.includeHandledReference)) {
    const older = [
      ...(start && options && options.includeHandledReference ? splitByGap(all.slice(0, start)) : []),
      ...segments.slice(0, -1),
    ];
    const patientReferenced = (staffMode ? EXPLICIT_HISTORY_RE : REFERENCE_RE).test(latestText);
    // "The previous draft" refers to the editing chat, not old patient topics.
    // Strip just that phrase, so a separate concrete history request survives.
    const staffHistoryText = staffText.replace(DRAFT_REFERENCE_RE, "").split(/[。！？!?\n]/)
      .filter(clause => EXPLICIT_HISTORY_RE.test(clause)).join(" ");
    const staffReferenced = staffMode && EXPLICIT_HISTORY_RE.test(staffHistoryText);
    const followupText = latestText.replace(/^テスト[:：]\s*/, "").trim();
    const latestOlder = older[older.length - 1];
    const before = latestOlder && topicAt(latestOlder[latestOlder.length - 1]), now = topicAt(latestPatient);
    const adjacent = !!(before && now && now >= before && now - before < TOPIC_GAP_MS);
    const shortFollowup = staffMode && adjacent && followupText.length <= 80
      && (ACK_RE.test(followupText) || CONTINUATION_RE.test(followupText));
    let best = null;
    for (let i = older.length - 1; i >= 0; i--) {
      const segmentText = older[i].map(textOf).join(" ");
      const patientScore = overlap(latestText, segmentText);
      // A staff-only reference must also match the segment's actual subject.
      // Never select an unrelated handled segment just because it exists.
      const staffScore = staffReferenced ? overlap(staffHistoryText, segmentText) : 0;
      const score = Math.max(patientScore, staffScore);
      if (!best || score > best.score) best = { messages: older[i], score, patientScore, staffScore };
    }
    const selected = shortFollowup ? latestOlder : best && (patientReferenced || best.patientScore >= 0.28 || (staffReferenced && best.staffScore >= 0.28)) ? best.messages : null;
    if (selected) olderRelevant = selected.slice(-(options && options.maxOlder || 10));
  }
  return { current, olderRelevant, separated: segments.length > 1 };
}

module.exports = { TOPIC_GAP_MS, messageAt, preserveTopicBoundary, selectConversationContext };
