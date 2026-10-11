"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const source = fs.readFileSync(require.resolve("../migiude.js"), "utf8");
const start = source.indexOf("const PAGE = `");
const end = source.indexOf("</html>`;", start);
const page = {};
vm.runInNewContext("PAGE=" + source.slice(start + "const PAGE = ".length, end + "</html>`".length), page);
const script = [...page.PAGE.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]).join("\n");

function browser(now = "2026-10-11T00:00:00+09:00", element = null) {
  let clock = Date.parse(now);
  class TestDate extends Date { static now() { return clock; } }
  const context = { Date: TestDate, URL, location: { origin: "https://test.invalid" }, document: { getElementById: () => element } };
  vm.createContext(context);
  vm.runInContext(script.slice(script.indexOf("function safeMediaUrl("), script.indexOf("function av(")), context);
  vm.runInContext(script.slice(script.indexOf("function esc("), script.indexOf("function groundingText(")), context);
  vm.runInContext(script.slice(script.indexOf("function syncMsgs("), script.indexOf("function openChat(")), context);
  return { context, advance: value => { clock = Date.parse(value); } };
}

test("テスト：当日は日本時間の時刻のみ、前日・同年・前年は年月日と時刻", () => {
  const { context: c } = browser();
  assert.equal(c.messageTimeLabel({ sentAt: Date.parse("2026-10-10T15:00:00Z"), time: "15:00" }), "00:00");
  assert.equal(c.messageTimeLabel({ sentAt: Date.parse("2026-10-10T14:59:00Z") }), "2026年10月10日 23:59");
  assert.equal(c.messageTimeLabel({ at: Date.parse("2026-01-02T01:05:00+09:00") }), "2026年1月2日 01:05");
  assert.equal(c.messageTimeLabel({ receivedAt: Date.parse("2025-12-31T23:59:00+09:00") }), "2025年12月31日 23:59");
});

test("テスト：送信日時を優先し、無効な値は有効なメッセージ日時へフォールバック", () => {
  const { context: c } = browser();
  const past = Date.parse("2026-10-05T11:15:00+09:00");
  assert.equal(c.messageTimeLabel({ sentAt: String(past), receivedAt: Date.parse("2026-10-11T09:00:00+09:00") }), "2026年10月5日 11:15");
  for (const invalid of [null, true, {}, [], "", " ", "invalid", NaN, Infinity, -1, 0, 1e20]) {
    assert.equal(c.messageTimeLabel({ sentAt: invalid, at: past }), "2026年10月5日 11:15");
  }
  assert.equal(c.messageTimeLabel({ createdAt: past }), "2026年10月5日 11:15");
  assert.equal(c.messageTimeLabel({ ts: past }), "2026年10月5日 11:15");
});

test("テスト：旧履歴の日付を会話更新時刻や話題時刻から推測せず、表示値をエスケープ", () => {
  const { context: c } = browser();
  assert.equal(c.messageTimeLabel({ time: "11:15", topicActivityAt: Date.now() }), "11:15（日付不明）");
  assert.equal(c.messageTimeLabel({}), "日時不明");
  const html = c.bubblesHtml({ ts: Date.now(), msgs: [{ from: "them", text: "テスト", time: '<img src=x onerror="alert(1)">' }] });
  assert.ok(html.includes("&lt;img"));
  assert.ok(!html.includes("<img"));
  assert.ok(html.includes("（日付不明）"));
});

test("テスト：受信・送信・画像と自動返信・予約送信の既存表示を維持", () => {
  const { context: c } = browser();
  const sentAt = Date.parse("2026-10-11T00:05:00+09:00");
  const html = c.bubblesHtml({ msgs: [{ from: "them", text: "テスト", sentAt }, { from: "us", media: "image", mediaId: "test-image", sentAt, auto: true, scheduled: true }] });
  assert.ok(html.includes('class="b them"'));
  assert.ok(html.includes('class="b us media"'));
  assert.ok(html.includes("/api/line-media/test-image"));
  assert.equal((html.match(/00:05/g) || []).length, 2);
  assert.ok(html.includes("自動返信"));
  assert.ok(html.includes("予約送信"));
});

test("テスト：日本時間の年越しで開いた会話を更新し、スクロール位置を維持", () => {
  const attributes = { "data-count": "1", "data-day": "2026-12-31" };
  let renders = 0, html = "";
  const element = { scrollTop: 25, scrollHeight: 200, getAttribute: key => attributes[key], setAttribute: (key, value) => { attributes[key] = value; }, get innerHTML() { return html; }, set innerHTML(value) { renders++; html = value; } };
  const { context: c, advance } = browser("2026-12-31T23:59:00+09:00", element);
  const conversation = { msgs: [{ from: "them", text: "テスト", sentAt: Date.parse("2026-12-31T23:58:00+09:00") }] };
  c.syncMsgs(conversation);
  assert.equal(renders, 0);
  advance("2027-01-01T00:00:00+09:00");
  c.syncMsgs(conversation);
  assert.ok(html.includes("2026年12月31日 23:58"));
  assert.equal(attributes["data-day"], "2027-01-01");
  assert.equal(element.scrollTop, 25);
  c.syncMsgs(conversation);
  assert.equal(renders, 1);
  conversation.msgs.push({ from: "us", text: "テスト", sentAt: Date.parse("2027-01-01T00:00:00+09:00") });
  c.syncMsgs(conversation);
  assert.equal(element.scrollTop, 200);
  assert.equal(renders, 2);
});

test("テスト：会話を開く際に日本時間の日付を記録する", () => {
  const openChat = script.slice(script.indexOf("function openChat("), script.indexOf("function closeChat("));
  assert.match(openChat, /m\.setAttribute\("data-day",messageDayKey\(\)\)/);
});
