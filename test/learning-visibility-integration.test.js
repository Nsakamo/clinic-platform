"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "..", "migiude.js"), "utf8");

test("学習内容の生成・送信利用を永続的に追跡する", () => {
  assert.match(source, /CREATE TABLE IF NOT EXISTS learning_usage_events/);
  assert.match(source, /async function startLearningUsageTrace/);
  assert.match(source, /async function finishLearningUsageTrace/);
  assert.match(source, /await startLearningUsageTrace\(t, c, g, "inbound"\)/);
  assert.match(source, /await startLearningUsageTrace\(t, c, g, "redraft"\)/);
  assert.match(source, /await finishLearningUsageTrace\(t, c, text, "staff"\)/);
  assert.match(source, /await finishLearningUsageTrace\(t, found\.c, outgoing, "staff_line"\)/);
  assert.match(source, /await finishLearningUsageTrace\(t, cur, draftText, "auto"\)/);
  assert.match(source, /await finishLearningUsageTrace\(t, c, String\(item\.text \|\| ""\), "scheduled", item\.learningTrace\)/);
});

test("テスト生成は追跡せず患者向けに保存した下書きだけを数える", () => {
  const preview = source.slice(source.indexOf('app.post("/api/quality-preview"'), source.indexOf('function staffLineStatus'));
  assert.doesNotMatch(preview, /startLearningUsageTrace/);
  assert.match(source, /delete c\.learningTrace; \/\/ 前の未送信下書きは新着で失効する/);
});

test("学習データ画面で覚えた件数と生成・送信件数を表示する", () => {
  assert.match(source, /id="learnRemembered"/);
  assert.match(source, /id="learnGenerated"/);
  assert.match(source, /id="learnSent"/);
  assert.match(source, /から集計（テスト生成は除外）/);
  assert.match(source, /利用回数はこの機能の反映後から集計/);
  assert.match(source, /回答生成に .*回使用・送信/);
  assert.match(source, /usage: usage\.examples\[e\.id\]/);
  assert.match(source, /usage: usage\.rules\[r\.id\]/);
});
