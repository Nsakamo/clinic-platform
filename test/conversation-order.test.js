"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { compareConversations, compareConversationsRecent, isUnanswered } = require("../lib/conversation-order");

test("未対応を対応済みより上に並べる", () => {
  const conversations = [
    { id: "done-new", status: "done", ts: 400 },
    { id: "todo-old", status: "todo", ts: 100 },
    { id: "done-old", status: "done", ts: 200 },
    { id: "todo-new", status: "todo", ts: 300 }
  ];

  assert.deepEqual(
    conversations.sort(compareConversations).map(item => item.id),
    ["todo-new", "todo-old", "done-new", "done-old"]
  );
});

test("未対応内では要対応を優先し、通常の未対応は新着順にする", () => {
  const conversations = [
    { id: "todo-new", status: "todo", flag: false, ts: 500 },
    { id: "flag-second", status: "todo", flag: true, order: 2, ts: 400 },
    { id: "flag-first", status: "todo", flag: true, order: 1, ts: 300 },
    { id: "todo-old", status: "todo", flag: false, ts: 100 }
  ];

  assert.deepEqual(
    conversations.sort(compareConversations).map(item => item.id),
    ["flag-first", "flag-second", "todo-new", "todo-old"]
  );
});

test("done以外と古いデータの未設定状態は未対応として扱う", () => {
  assert.equal(isUnanswered({ status: "done" }), false);
  assert.equal(isUnanswered({ status: "todo" }), true);
  assert.equal(isUnanswered({}), true);
});

test("従来の新着順では要対応を先頭に保ち、その他を受信日時順にする", () => {
  const conversations = [
    { id: "done-new", status: "done", flag: false, ts: 500 },
    { id: "todo-old", status: "todo", flag: false, ts: 100 },
    { id: "flag-second", status: "todo", flag: true, order: 2, ts: 300 },
    { id: "flag-first", status: "todo", flag: true, order: 1, ts: 200 }
  ];

  assert.deepEqual(
    conversations.sort(compareConversationsRecent).map(item => item.id),
    ["flag-first", "flag-second", "done-new", "todo-old"]
  );
});
