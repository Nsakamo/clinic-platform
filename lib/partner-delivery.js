"use strict";

const crypto = require("crypto");

const RETRYABLE_STATUS = new Set([408, 425, 429]);

function partnerEventKey(payload) {
  const stable = [payload && payload.slug, payload && payload.convId, payload && payload.ts]
    .map(v => String(v == null ? "" : v))
    .join("\n");
  return crypto.createHash("sha256").update(stable).digest("hex");
}

function retryableStatus(status) {
  return RETRYABLE_STATUS.has(Number(status)) || Number(status) >= 500;
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function deliverPartnerEvent(options) {
  const url = String(options && options.url || "");
  const payload = options && options.payload || {};
  const fetchImpl = options && options.fetchImpl || globalThis.fetch;
  const attempts = Math.max(1, Math.min(5, Number(options && options.attempts || 3)));
  const timeoutMs = Math.max(250, Number(options && options.timeoutMs || 4000));
  const retryDelays = options && Array.isArray(options.retryDelays) ? options.retryDelays : [200, 600];
  const idempotencyKey = partnerEventKey(payload);
  const headers = Object.assign({}, options && options.headers, { "x-idempotency-key": idempotencyKey });
  let last = { ok: false, status: 0, error: "delivery_failed", idempotencyKey, attempts: 0 };

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      });
      if (response.ok) return { ok: true, status: response.status, idempotencyKey, attempts: attempt };
      last = { ok: false, status: response.status, error: "http_" + response.status, idempotencyKey, attempts: attempt };
      if (!retryableStatus(response.status)) return last;
    } catch (error) {
      last = { ok: false, status: 0, error: error && error.name === "AbortError" ? "timeout" : "network_error", idempotencyKey, attempts: attempt };
    } finally {
      clearTimeout(timer);
    }
    if (attempt < attempts) await wait(Number(retryDelays[attempt - 1] || retryDelays[retryDelays.length - 1] || 0));
  }
  return last;
}

module.exports = { deliverPartnerEvent, partnerEventKey, retryableStatus };
