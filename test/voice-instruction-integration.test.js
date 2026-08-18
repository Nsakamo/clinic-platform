"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "..", "migiude.js"), "utf8");

test("右腕くんの修正指示欄から音声を録音して文字起こしできる", () => {
  assert.match(source, /id="dVoiceBtn" onclick="toggleDraftVoice\(\)"/);
  assert.match(source, /navigator\.mediaDevices\.getUserMedia/);
  assert.match(source, /new MediaRecorder/);
  assert.match(source, /app\.post\("\/api\/transcribe-voice", guard/);
  assert.match(source, /https:\/\/api\.openai\.com\/v1\/audio\/transcriptions/);
  assert.match(source, /OPENAI_TRANSCRIBE_MODEL \|\| "gpt-transcribe"/);
});

test("音声は保存せず対応形式と容量を制限する", () => {
  assert.match(source, /const VOICE_MIME_EXT/);
  assert.match(source, /data\.length > 10 \* 1024 \* 1024/);
  assert.match(source, /音声はOpenAIへ直接転送し、このサーバーやDBには保存しない/);
  assert.doesNotMatch(source, /INSERT INTO .*voice/i);
});

test("音声変換の誤りは文脈から復元し、重要情報だけ確認する", () => {
  assert.match(source, /inputMode:fromVoice\?"voice":"text"/);
  assert.match(source, /最新のスタッフ指示は音声認識から変換された文章/);
  assert.match(source, /誤字、同音異義語、助詞抜け、途中の言い直し/);
  assert.match(source, /患者名、医院、予約日時、金額、回数/);
  assert.match(source, /actionはnone、下書きは変更しない/);
});

test("医院・媒体の固有名詞を文字起こしヒントへ渡す", () => {
  assert.match(source, /form\.append\("languages\[\]", "ja"\)/);
  assert.match(source, /form\.append\("keywords\[\]", word\)/);
  assert.match(source, /キレイパス/);
  assert.match(source, /カンナムオンニ/);
  assert.match(source, /トリビュー/);
});
