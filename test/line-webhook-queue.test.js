"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  lineWebhookEventId,
  lineWebhookRetryDelay,
  isProcessableLineEvent,
} = require("../lib/line-webhook-queue");

test("LINE supplied webhookEventId is used as the durable idempotency key", () => {
  assert.equal(lineWebhookEventId("bot", { webhookEventId: "evt-123" }), "evt-123");
});

test("legacy LINE events receive a stable fallback id", () => {
  const event = { type: "message", timestamp: 10, source: { userId: "u1" }, message: { id: "m1", type: "text" } };
  assert.equal(lineWebhookEventId("bot", event), lineWebhookEventId("bot", structuredClone(event)));
  assert.match(lineWebhookEventId("bot", event), /^legacy:[0-9a-f]{64}$/);
});

test("retry delay backs off and is capped", () => {
  assert.equal(lineWebhookRetryDelay(1), 1000);
  assert.equal(lineWebhookRetryDelay(4), 8000);
  assert.equal(lineWebhookRetryDelay(99), 15 * 60 * 1000);
});

test("only supported LINE user messages enter processing", () => {
  assert.equal(isProcessableLineEvent({ type: "message", source: { userId: "u1" }, message: { type: "text" } }), true);
  assert.equal(isProcessableLineEvent({ type: "follow", source: { userId: "u1" } }), false);
  assert.equal(isProcessableLineEvent({ type: "message", source: {}, message: { type: "text" } }), false);
  assert.equal(isProcessableLineEvent({ type: "message", source: { userId: "u1" }, message: { type: "sticker" } }), false);
});
