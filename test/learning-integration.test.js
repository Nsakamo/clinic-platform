"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "..", "migiude.js"), "utf8");

test("Web画面とスタッフLINEが同じ学習保存経路を使う", () => {
  assert.match(source, /learnStaffOutcome\(t, found\.c,[\s\S]{0,300}source: "staff_line"/);
  assert.match(source, /learnStaffOutcome\(t, c,[\s\S]{0,300}source: "web"/);
});

test("スタッフLINEの修正指示を学習へ引き渡す", () => {
  assert.match(source, /found\.approval\.editInstruction = text\.slice/);
  assert.match(source, /instr: editInstruction, source: "staff_line"/);
});

test("生成した返信に過去対応例の参照情報を残す", () => {
  assert.match(source, /out\.learningRefs = exRel\.map/);
  assert.match(source, /過去の対応例 "\+refs\.length\+"件を参照/);
});

test("staging画面は本番との取り違え防止バナーを表示する", () => {
  assert.match(source, /host !== "clinic-platform-staging\.up\.railway\.app"/);
  assert.match(source, /id="test-environment-banner"[\s\S]{0,500}>テスト環境<\/div>/);
});

test("保留中のスタッフLINE承認依頼を画面から安全に再送できる", () => {
  assert.match(source, /app\.post\("\/api\/staff-line\/resend-approval", guard/);
  assert.match(source, /staffLineRequestApproval\(t, c, "右腕くん画面から承認依頼を再送しました", \{ force: true \}\)/);
  assert.match(source, /staffLineReviewAvailable/);
  assert.match(source, /id="staffReviewResend"[\s\S]{0,180}resendStaffApproval\(\)/);
  assert.match(source, /resend-approval",\{id:current,draft\}/);
});
