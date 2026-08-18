const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "..", "migiude.js"), "utf8");

test("患者への送信後は学習をバックグラウンドで続け、元の会話だけへ確認を返す", () => {
  assert.match(source, /queueStaffLearning\(t, c/);
  assert.match(source, /app\.get\("\/api\/learning-jobs"/);
  assert.match(source, /学習案はバックグラウンドで整理中です/);
  assert.match(source, /current!==id\)return;shownLearningJobs\.add/);
  assert.doesNotMatch(source, /window\.__sendBusy=true;showLearningProgress\(\)/);
});

test("右腕くんへの未送信入力を会話IDごとに保持する", () => {
  assert.match(source, /dComposerDrafts=\{\},dComposerOwner=""/);
  assert.match(source, /dComposerDrafts\[dComposerOwner\]=x\.value/);
  assert.match(source, /composer\.value=dComposerDrafts\[openId\]\|\|""/);
  assert.match(source, /current!==id\)hideDraftChatForConversationSwitch\(\)/);
  assert.match(source, /oninput="rememberDraftChatInput\(\)"/);
});

test("右腕くんが回答中は別会話へ切り替えない", () => {
  assert.match(source, /\(window\.__dBusy\|\|window\.__voiceBusy\)&&current&&current!==id/);
  assert.match(source, /完了してから別の会話を開いてください/);
  assert.match(source, /音声を処理中です。完了してから別の会話を開いてください/);
});
