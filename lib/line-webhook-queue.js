"use strict";

const crypto = require("crypto");

const SUPPORTED_MESSAGE_TYPES = new Set(["text", "image", "video", "audio", "file"]);

function lineWebhookEventId(destination, event) {
  const provided = String(event && event.webhookEventId || "").trim();
  if (provided) return provided.slice(0, 200);
  const stable = JSON.stringify({
    destination: String(destination || ""),
    type: event && event.type,
    timestamp: event && event.timestamp,
    source: event && event.source,
    messageId: event && event.message && event.message.id,
  });
  return "legacy:" + crypto.createHash("sha256").update(stable).digest("hex");
}

function lineWebhookRetryDelay(attempt) {
  const n = Math.max(1, Number(attempt) || 1);
  return Math.min(15 * 60 * 1000, 1000 * (2 ** Math.min(20, n - 1)));
}

function isProcessableLineEvent(event) {
  return !!(event && event.type === "message" && event.message && SUPPORTED_MESSAGE_TYPES.has(event.message.type)
    && event.source && event.source.userId);
}

module.exports = { lineWebhookEventId, lineWebhookRetryDelay, isProcessableLineEvent };
