"use strict";

const MAX_ATTACHMENTS = 4;
const MAX_TEXT_LENGTH = 5000;
const MAX_FUTURE_MS = 366 * 24 * 60 * 60 * 1000;
const MIN_LEAD_MS = 5000;

function normalizeFileIds(value) {
  const ids = [];
  for (const raw of Array.isArray(value) ? value : []) {
    const id = String(raw || "").toLowerCase();
    if (!/^[0-9a-f]{32}$/.test(id) || ids.includes(id)) continue;
    ids.push(id);
    if (ids.length >= MAX_ATTACHMENTS) break;
  }
  return ids;
}

function normalizeScheduledMessageInput(value, now = Date.now()) {
  const body = value && typeof value === "object" ? value : {};
  const text = String(body.text || "").trim().slice(0, MAX_TEXT_LENGTH);
  const rawFileIds = Array.isArray(body.fileIds) ? body.fileIds : [];
  if (rawFileIds.length > MAX_ATTACHMENTS) return { ok: false, error: "too_many_files" };
  const fileIds = normalizeFileIds(rawFileIds);
  if (rawFileIds.some(id => !/^[0-9a-f]{32}$/i.test(String(id || "")))) return { ok: false, error: "no_file" };
  const sendAt = Number(body.sendAt);
  if (!text && !fileIds.length) return { ok: false, error: "empty" };
  if (!Number.isFinite(sendAt) || sendAt < now + MIN_LEAD_MS || sendAt > now + MAX_FUTURE_MS) {
    return { ok: false, error: "invalid_time" };
  }
  return { ok: true, text, fileIds, sendAt: Math.round(sendAt) };
}

function pruneScheduledMessages(value, limit = 200) {
  const rows = Array.isArray(value) ? value.filter(Boolean) : [];
  if (rows.length <= limit) return rows;
  const active = rows.filter((item) => ["scheduled", "sending"].includes(String(item.status || "")));
  const terminal = rows
    .filter((item) => !["scheduled", "sending"].includes(String(item.status || "")))
    .sort((a, b) => Number(b.completedAt || b.updatedAt || b.createdAt || 0) - Number(a.completedAt || a.updatedAt || a.createdAt || 0));
  return active.concat(terminal.slice(0, Math.max(0, limit - active.length)));
}

module.exports = {
  MAX_ATTACHMENTS,
  MAX_TEXT_LENGTH,
  normalizeFileIds,
  normalizeScheduledMessageInput,
  pruneScheduledMessages,
};
