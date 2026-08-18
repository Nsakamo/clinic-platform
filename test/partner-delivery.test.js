"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { deliverPartnerEvent, partnerEventKey, retryableStatus } = require("../lib/partner-delivery");

const payload = { slug: "clinic-a", convId: "line:user-1", ts: 1234567890, text: "非公開本文" };

test("同じ受信イベントは本文に依存しない同一の冪等キーになる", () => {
  assert.equal(partnerEventKey(payload), partnerEventKey(Object.assign({}, payload, { text: "更新後本文" })));
  assert.notEqual(partnerEventKey(payload), partnerEventKey(Object.assign({}, payload, { ts: payload.ts + 1 })));
  assert.match(partnerEventKey(payload), /^[0-9a-f]{64}$/);
});

test("一時的なHTTPエラーを再送し冪等キーを毎回付ける", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return calls.length < 3 ? { ok: false, status: 503 } : { ok: true, status: 200 };
  };
  const result = await deliverPartnerEvent({
    url: "https://example.test/hook",
    payload,
    headers: { "x-partner-key": "test-key", "Content-Type": "application/json" },
    fetchImpl,
    retryDelays: [0, 0],
    timeoutMs: 1000,
  });
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 3);
  assert.equal(calls.length, 3);
  assert.ok(calls.every(call => call.options.headers["x-idempotency-key"] === result.idempotencyKey));
  assert.ok(calls.every(call => call.options.headers["x-partner-key"] === "test-key"));
});

test("通信失敗は再送し、恒久的な4xxは再送しない", async () => {
  let networkCalls = 0;
  const recovered = await deliverPartnerEvent({
    url: "https://example.test/hook",
    payload,
    fetchImpl: async () => {
      networkCalls += 1;
      if (networkCalls === 1) throw new Error("temporary network failure");
      return { ok: true, status: 204 };
    },
    retryDelays: [0],
  });
  assert.equal(recovered.ok, true);
  assert.equal(networkCalls, 2);

  let badRequestCalls = 0;
  const rejected = await deliverPartnerEvent({
    url: "https://example.test/hook",
    payload,
    fetchImpl: async () => { badRequestCalls += 1; return { ok: false, status: 400 }; },
    retryDelays: [0, 0],
  });
  assert.equal(rejected.ok, false);
  assert.equal(badRequestCalls, 1);
  assert.equal(retryableStatus(400), false);
  assert.equal(retryableStatus(429), true);
  assert.equal(retryableStatus(500), true);
});
