"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");
const source = fs.readFileSync(path.join(__dirname, "..", "migiude.js"), "utf8");
const sha = text => crypto.createHash("sha256").update(text).digest("hex");

function harness({ replyOk = true, pushOk = true, onRevise = () => {} } = {}) {
  const deliveries = [], saved = [];
  const context = {
    sha, dbSave: (_t, c) => saved.push(c.draft),
    staffLineReviseDraft: async (_t, c) => { onRevise(c); return "テスト：修正済みの案"; },
    staffLineReply: async (_t, token, messages) => { deliveries.push({ kind: "reply", token, messages }); return { ok: replyOk }; },
    staffLinePush: async (_t, group, messages) => { deliveries.push({ kind: "push", group, messages }); return { ok: pushOk }; },
    staffLineApprovalMessage: (_t, _c, a) => ({ draft: a.draft, hash: a.draftHash }),
  };
  const start = source.indexOf("function staffLineCardMatches(");
  const end = source.indexOf("async function staffLineReviseDraft(", start);
  vm.runInNewContext(source.slice(start, end), context);
  const approval = { id: "テスト承認", status: "pending", groupId: "テストグループ", assignedUserId: "テスト担当", draft: "テスト：旧案", draftHash: sha("テスト：旧案"), expiresAt: Date.now() + 100000 };
  const c = { draft: approval.draft, staffLineApproval: approval };
  return { ...context, c, approval, saved, deliveries };
}

test("修正後は旧カードとハッシュのない旧形式カードを拒否し、新カードだけ一致する", async () => {
  const h = harness(), oldHash = h.approval.draftHash;
  assert.equal(h.staffLineCardMatches(h.c, h.approval, oldHash), true);
  assert.equal(await h.staffLineApplyRevision({}, h.c, h.approval, "丁寧に", "テスト担当", "テストtoken"), true);
  assert.equal(h.staffLineCardMatches(h.c, h.approval, oldHash), false);
  assert.equal(h.staffLineCardMatches(h.c, h.approval, null), false);
  assert.equal(h.staffLineCardMatches(h.c, h.approval, h.approval.draftHash), true);
  h.c.draft = "画面から編集した案";
  assert.equal(h.staffLineCardMatches(h.c, h.approval, h.approval.draftHash), false);
});

test("修正に時間がかかりreplyTokenが失効したら法人グループへ新しいカードを送る", async () => {
  const h = harness({ replyOk: false });
  assert.equal(await h.staffLineApplyRevision({}, h.c, h.approval, "修正", "テスト担当", "期限切れtoken"), true);
  assert.deepEqual(h.deliveries.map(d => d.kind), ["reply", "push"]);
  assert.equal(h.deliveries[1].group, "テストグループ");
  assert.equal(h.deliveries[1].messages[0].hash, h.approval.draftHash);
});

test("確認カードが両経路で届かなくても旧カードから未知の修正案を送れない", async () => {
  const h = harness({ replyOk: false, pushOk: false }), oldHash = h.approval.draftHash;
  assert.equal(await h.staffLineApplyRevision({}, h.c, h.approval, "修正", "テスト担当", "期限切れtoken"), false);
  assert.equal(h.staffLineCardMatches(h.c, h.approval, oldHash), false);
});

test("生成中に承認済み・差し替え・別担当・期限切れになった案を復活させない", async () => {
  for (const change of [
    c => { c.staffLineApproval.status = "sent"; },
    c => { c.staffLineApproval = { ...c.staffLineApproval }; },
    c => { c.staffLineApproval.assignedUserId = "別担当"; },
    c => { c.staffLineApproval.expiresAt = 1; },
    c => { c.draft = "新着による新案"; },
  ]) {
    const h = harness({ onRevise: change });
    assert.equal(await h.staffLineApplyRevision({}, h.c, h.approval, "修正", "テスト担当", "token"), false);
    assert.equal(h.saved.length, 0);
    assert.equal(h.deliveries.length, 0);
  }
});

test("実承認カードに全文ハッシュを埋め込み、送信経路がカードハッシュを照合する", () => {
  const context = { staffLinePostback: (_label, data) => ({ data }) };
  const start = source.indexOf("function staffLineApprovalMessage(");
  const end = source.indexOf("function staffLineHistoryPageMessage(", start);
  vm.runInNewContext(source.slice(start, end), context);
  const hash = sha("テスト：案");
  const card = context.staffLineApprovalMessage({ name: "テスト" }, { name: "テスト患者" }, { id: "テスト", draftHash: hash });
  assert.ok(JSON.stringify(card).includes("migiude=send&id=テスト&h=" + hash));
  assert.match(source, /staffLineCardMatches\(found\.c, found\.approval, q\.get\("h"\)\)/);
});
