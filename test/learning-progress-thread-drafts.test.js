const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "..", "migiude.js"), "utf8");

test("患者への送信直後に元の会話で学習確認を出し、AI整理はバックグラウンドで続ける", () => {
  assert.match(source, /queueStaffLearning\(t, c/);
  assert.match(source, /app\.get\("\/api\/learning-jobs"/);
  assert.match(source, /immediateLearning=Object\.assign/);
  assert.match(source, /if\(immediateLearning&&current===id\)showLearningScope\(immediateLearning\)/);
  assert.match(source, /shownLearningDecisions\.add\(json\.learningJob\.id\)/);
  assert.match(source, /job\.status==="awaiting_decision"/);
  assert.match(source, /if \(job\.status !== "processing"\) return/);
  assert.match(source, /showLearningOutcome\(\{type:"processing"/);
  assert.match(source, /duplicate:"重複統合"/);
  assert.match(source, /type:"conflict",title:"現在のルールと内容が異なります"/);
  assert.doesNotMatch(source, /学習案はバックグラウンドで整理中です/);
  assert.doesNotMatch(source, /window\.__sendBusy=true;showLearningProgress\(\)/);
});

test("学習を選ぶ前は対応例へ保存せず、選択後だけ安全確認を開始する", () => {
  const queue = source.slice(source.indexOf("async function queueStaffLearning"), source.indexOf("// 2つのテキストがほぼ同内容か"));
  assert.doesNotMatch(queue, /await exampleAdd\(/);
  assert.match(queue, /status: "awaiting_decision"/);
  const scope = source.slice(source.indexOf('app.post("/api/learning-scope"'), source.indexOf('app.post("/api/learning-conflict-consult"'));
  assert.match(scope, /if \(scope === "none"\)/);
  assert.match(scope, /if \(scope === "learn"\)/);
  assert.match(scope, /ex = await exampleAdd\(/);
  assert.match(scope, /job\.status = "processing"/);
  assert.match(source, /安全確認が終わるまでは新規候補を患者回答へ使わない/);
  assert.match(source, /if \(job\.exampleId && !job\.reused\)/);
  assert.match(source, /await exampleDelete\(t, Number\(job\.exampleId\)\)/);
});

test("学習結果を新規・更新・重複・矛盾で色分けし、矛盾は会話形式で確認する", () => {
  assert.match(source, /#learningResultBanner\.new,#learningResultBanner\.updated/);
  assert.match(source, /#learningResultBanner\.duplicate/);
  assert.match(source, /#learningResultBanner\.conflict/);
  assert.match(source, /class="learningConflictThread"/);
  assert.match(source, /条件で使い分け/);
  assert.match(source, /async function consultLearningConflict/);
  assert.match(source, /app\.post\("\/api\/learning-conflict-consult"/);
  assert.match(source, /この内容で確定/);
  assert.match(source, /height:100dvh/);
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
