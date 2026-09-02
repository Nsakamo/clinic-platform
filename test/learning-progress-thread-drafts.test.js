const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "..", "migiude.js"), "utf8");

test("患者への送信直後に自動学習を開始し、AI整理はバックグラウンドで続ける", () => {
  assert.match(source, /queueStaffLearning\(t, c/);
  assert.match(source, /app\.get\("\/api\/learning-jobs"/);
  assert.match(source, /json\.learningJob\.status==="awaiting_decision"/);
  assert.match(source, /else if\(json\.learningJob\)showLearningOutcome\(\{type:"processing",title:"送信しました・自動学習中"/);
  assert.match(source, /if \(job\.status !== "processing"\) return/);
  assert.match(source, /duplicate:"重複統合"/);
  assert.match(source, /type:"conflict",title:"現在のルールと内容が異なります"/);
  assert.doesNotMatch(source, /学習案はバックグラウンドで整理中です/);
  assert.doesNotMatch(source, /window\.__sendBusy=true;showLearningProgress\(\)/);
});

test("送信済み回答だけを先に保存し、安全確認中と矛盾中は回答へ利用しない", () => {
  const queue = source.slice(source.indexOf("async function queueStaffLearning"), source.indexOf("// 2つのテキストがほぼ同内容か"));
  assert.match(queue, /await exampleAdd\(/);
  assert.match(queue, /status: "processing"/);
  assert.match(queue, /setImmediate\(\(\) => processLearningJob\(t, job\.id\)\)/);
  assert.match(source, /安全確認が終わるまでは新規候補を患者回答へ使わない/);
  assert.match(source, /exampleLearningMetaUpdate\(t, Number\(job\.exampleId\), \{ scope: "one_off" \}\)/);
  assert.doesNotMatch(source.slice(source.indexOf("async function processLearningJob"), source.indexOf("async function queueStaffLearning")), /exampleDelete\(/);
});

test("学習結果の通知は操作を塞がず3秒で自動的に閉じる", () => {
  const result = source.slice(source.indexOf("let learningResultTimer"), source.indexOf("const pendingAttachmentsByConversation"));
  assert.match(result, /learningResultTimer=setTimeout\(closeLearningResult,3000\)/);
  assert.match(result, /clearTimeout\(learningResultTimer\)/);
  assert.match(source, /showLearnResult[\s\S]{0,300}setTimeout\(\(\)=>\{b\.style\.display="none";\},3000\)/);
  assert.match(source, /function showLearnToast[\s\S]{0,500}setTimeout\(\(\)=>\{b\.style\.display="none";\},3000\)/);
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
