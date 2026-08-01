"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  MAX_ATTACHMENTS,
  normalizeFileIds,
  normalizeScheduledMessageInput,
  pruneScheduledMessages,
} = require("../lib/scheduled-message");

const F1 = "1".repeat(32);
const F2 = "2".repeat(32);

test("予約送信は本文だけ・添付だけ・本文と添付を受け付ける", () => {
  const now = 1_000_000;
  assert.equal(normalizeScheduledMessageInput({ text: " テスト ", sendAt: now + 60_000 }, now).text, "テスト");
  assert.deepEqual(normalizeScheduledMessageInput({ fileIds: [F1], sendAt: now + 60_000 }, now).fileIds, [F1]);
  assert.equal(normalizeScheduledMessageInput({ text: "", fileIds: [], sendAt: now + 60_000 }, now).error, "empty");
});

test("過去日時・遠すぎる日時・壊れた添付IDを安全に拒否する", () => {
  const now = 1_000_000;
  assert.equal(normalizeScheduledMessageInput({ text: "テスト", sendAt: now }, now).error, "invalid_time");
  assert.equal(normalizeScheduledMessageInput({ text: "テスト", sendAt: now + 367 * 86400000 }, now).error, "invalid_time");
  assert.deepEqual(normalizeFileIds(["bad", F1, F1, F2]), [F1, F2]);
});

test("添付数をLINEの一括送信上限に収まるよう制限する", () => {
  const ids = Array.from({ length: 8 }, (_, index) => String(index + 1).repeat(32));
  assert.equal(normalizeFileIds(ids).length, MAX_ATTACHMENTS);
  assert.equal(normalizeScheduledMessageInput({ text: "テスト", fileIds: ids, sendAt: Date.now() + 60000 }).error, "too_many_files");
});

test("予約履歴は実行待ちを残して古い完了分から整理する", () => {
  const rows = [
    { id: "waiting", status: "scheduled", createdAt: 1 },
    { id: "old", status: "sent", completedAt: 2 },
    { id: "new", status: "failed", completedAt: 3 },
  ];
  assert.deepEqual(pruneScheduledMessages(rows, 2).map((item) => item.id), ["waiting", "new"]);
});
