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

test("生成した返信に過去の対応・学習例の参照情報を残す", () => {
  assert.match(source, /out\.learningRefs = exRel\.map/);
  assert.match(source, /過去の対応・学習例 "\+refs\.length\+"件を参照/);
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

test("スタッフLINEで送信しないを選ぶと次の問い合わせへ文脈を持ち越さない", () => {
  assert.match(source, /found\.c\.handledThroughIndex = Array\.isArray\(found\.c\.msgs\) \? found\.c\.msgs\.length : 0/);
  assert.match(source, /found\.c\.draft = ""; found\.c\.draft0 = ""; found\.c\.topics = \[\]; found\.c\.learningRefs = \[\]/);
  assert.match(source, /found\.c\.status = "done"; found\.c\.flag = false/);
  assert.match(source, /const activeMsgs = activeConversationMessages\(c\)/);
  assert.match(source, /activeMsgs\.slice\(-16\)\.forEach/);
});

test("AIのconfidenceだけでなく根拠監査を通過した返信だけ自動送信する", () => {
  assert.match(source, /evaluateResponseGrounding\(/);
  assert.match(source, /c\.grounding && c\.grounding\.autoSendAllowed && c\.validation && c\.validation\.pass/);
  assert.match(source, /cur\.grounding && cur\.grounding\.autoSendAllowed && cur\.validation && cur\.validation\.pass/);
});

test("スタッフ確定例を再利用しつつ最新ルールを優先する", () => {
  assert.match(source, /これが右腕くんの対応学習である/);
  assert.match(source, /最新の店舗ルール > 本人確認済みシステムデータ > 再利用できる確定例/);
  assert.match(source, /function trustedLearningPrecedent/);
});

test("独立した送信前監査は失敗時に送信不可へ倒す", () => {
  assert.match(source, /async function validateDraftAgainstEvidence/);
  assert.match(source, /送信前監査を実行できませんでした/);
  assert.match(source, /out\.grounding\.autoSendAllowed = false/);
});

test("監査後にスタッフが下書きを編集したら遅延自動送信を解除する", () => {
  assert.match(source, /app\.post\("\/api\/draft-edited", guard/);
  assert.match(source, /cancelAutoReply\(t, c\.id\)/);
  assert.match(source, /textarea id="draft" oninput="draftEdited\(\)"/);
});

test("料金や規定の変更は更新日時付き最新ルールを過去例より優先する", () => {
  assert.match(source, /SELECT id,title,content,updated FROM rules/);
  assert.match(source, /r\.updated = Date\.now\(\)/);
  assert.match(source, /同じ内容が食い違う場合は更新日が新しいルールを使う/);
});

test("矛盾した回答を永続的な学習確認待ちへ保存して解決できる", () => {
  assert.match(source, /config\.learningConflicts/);
  assert.match(source, /learningConflictAdd\(t,/);
  assert.match(source, /app\.post\("\/api\/learning-conflict-resolve", guard/);
  assert.match(source, /data-tab="conflicts"/);
  assert.match(source, /pendingIds\.has\(Number\(example\.id\)\)/);
  assert.match(source, /filter\(example => Number\(example\.id\) !== Number\(excludeId\)/);
  assert.match(source, /conflictP\.then\(conflict => conflict \? \[\] : distillRules/);
  assert.match(source, /if \(chosen\) await distillRules/);
});
