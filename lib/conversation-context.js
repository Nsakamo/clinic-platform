const TOPIC_GAP_MS = 8 * 60 * 60 * 1000;
const REFERENCE_RE = /(先ほど|さっき|先日|以前|前回|この前|その件|こちらの件|それについて|続き|改めて|ご説明|説明いただ|伺った|言われた|返信|回答|上記|下記)/;

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
  const referenceText = latestText + " " + String(options && options.referenceText || "");
  let olderRelevant = [];
  if (segments.length > 1 || (start && options && options.includeHandledReference)) {
    const older = [
      ...(start && options && options.includeHandledReference ? splitByGap(all.slice(0, start)) : []),
      ...segments.slice(0, -1),
    ];
    const referenced = REFERENCE_RE.test(referenceText);
    const shortFollowup = !!(options && options.includeHandledReference) && latestText.length <= 80
      && /^(?:テスト[:：]\s*)?(?:はい|いいえ|承知|了解|かしこまり|ありがとう|お願い|大丈夫|そちら|こちら|それ|その|では|じゃあ)/.test(latestText);
    let best = null;
    for (let i = older.length - 1; i >= 0; i--) {
      const segmentText = older[i].map(textOf).join(" ");
      const score = overlap(referenceText, segmentText);
      if (!best || score > best.score) best = { messages: older[i], score };
    }
    if (best && (referenced || shortFollowup || best.score >= 0.28)) olderRelevant = best.messages.slice(-(options && options.maxOlder || 10));
  }
  return { current, olderRelevant, separated: segments.length > 1 };
}

module.exports = { TOPIC_GAP_MS, messageAt, preserveTopicBoundary, selectConversationContext };
