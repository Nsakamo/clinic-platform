const TOPIC_GAP_MS = 8 * 60 * 60 * 1000;
const REFERENCE_RE = /(先ほど|さっき|先日|以前|前回|この前|その件|こちらの件|それについて|続き|改めて|ご説明|説明いただ|伺った|言われた|返信|回答|上記|下記)/;

function messageAt(message) {
  const value = Number(message && (message.at || message.sentAt || message.receivedAt || message.createdAt || message.ts));
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
    const before = messageAt(prev), now = messageAt(message);
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
  if (!active.length) return { current: [], olderRelevant: [], separated: false };
  const segments = splitByGap(active);
  const current = segments[segments.length - 1].slice(-(options && options.maxCurrent || 20));
  const latestPatient = current.slice().reverse().find(item => item && item.from === "them");
  const latestText = textOf(latestPatient);
  let olderRelevant = [];
  if (segments.length > 1) {
    const older = segments.slice(0, -1);
    const referenced = REFERENCE_RE.test(latestText);
    let best = null;
    for (let i = older.length - 1; i >= 0; i--) {
      const segmentText = older[i].map(textOf).join(" ");
      const score = overlap(latestText, segmentText);
      if (!best || score > best.score) best = { messages: older[i], score };
    }
    if (best && (referenced || best.score >= 0.28)) olderRelevant = best.messages.slice(-(options && options.maxOlder || 10));
  }
  return { current, olderRelevant, separated: segments.length > 1 };
}

module.exports = { TOPIC_GAP_MS, messageAt, selectConversationContext };
