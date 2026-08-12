const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "..", "migiude.js"), "utf8");

test("学習案の検証中は全画面の進行表示で別会話への誤操作を防ぐ", () => {
  assert.match(source, /id="learningProgress"[\s\S]{0,500}回答と学習内容を検証中/);
  assert.match(source, /window\.__sendBusy=true;showLearningProgress\(\)/);
  assert.match(source, /hideLearningProgress\(\);if\(json\.sent\)/);
  assert.match(source, /#learningProgress\{[^}]*position:fixed[^}]*z-index:95[^}]*pointer-events:auto/);
});

test("右腕くんへの未送信入力を会話IDごとに保持する", () => {
  assert.match(source, /dComposerDrafts=\{\},dComposerOwner=""/);
  assert.match(source, /dComposerDrafts\[dComposerOwner\]=x\.value/);
  assert.match(source, /composer\.value=dComposerDrafts\[openId\]\|\|""/);
  assert.match(source, /current!==id\)hideDraftChatForConversationSwitch\(\)/);
  assert.match(source, /oninput="rememberDraftChatInput\(\)"/);
});

test("右腕くんが回答中は別会話へ切り替えない", () => {
  assert.match(source, /window\.__dBusy&&current&&current!==id/);
  assert.match(source, /完了してから別の会話を開いてください/);
});
