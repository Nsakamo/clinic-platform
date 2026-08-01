"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "..", "migiude.js"), "utf8");

test("予約送信を保存・取消・失敗後再送できる", () => {
  assert.match(source, /app\.post\("\/api\/scheduled-message", guard/);
  assert.match(source, /app\.post\("\/api\/scheduled-message-cancel", guard/);
  assert.match(source, /app\.post\("\/api\/scheduled-message-retry", guard/);
  assert.match(source, /processAllScheduledMessages/);
  assert.match(source, /item\.status = "sending"/);
  assert.match(source, /item\.status = "sent"/);
  assert.match(source, /item\.status = "failed"/);
});

test("予約確認は長い本文を再表示せず操作ボタンを隠さない", () => {
  assert.doesNotMatch(source, /id="scheduledMessagePreview"/);
  assert.doesNotMatch(source, /scheduledMessagePreview"\)\.textContent/);
  assert.match(source, /id="scheduledMessageMeta"/);
  assert.match(source, /入力中の本文/);
});

test("予約送信は再起動時に不明な送信を自動再送せず二重送信を防ぐ", () => {
  assert.match(source, /item\.status === "sending"/);
  assert.match(source, /item\.lastError = "delivery_status_unknown"/);
  assert.match(source, /患者側の履歴を確認してから再送してください/);
});

test("本文欄への画像・ファイル貼り付けを送信前添付として扱う", () => {
  assert.match(source, /onpaste="handleDraftPaste\(event\)"/);
  assert.match(source, /clipboardData/);
  assert.match(source, /item\.kind==="file"/);
  assert.match(source, /pendingAttachmentsByConversation/);
  assert.match(source, /fileIds:files\.map\(file=>file\.id\)/);
});

test("添付は選択直後に送らず本文と同時送信または予約送信する", () => {
  assert.match(source, /function attach\(\)[\s\S]{0,500}uploadComposerFiles/);
  assert.doesNotMatch(source, /function attach\(\)[\s\S]{0,1200}\/api\/send-file/);
  assert.match(source, /deliverMessageBundle/);
  assert.match(source, /attachments: files\.map/);
});
