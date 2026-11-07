"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const source = fs.readFileSync(require.resolve("../migiude.js"), "utf8");
const pageStart = source.indexOf("const PAGE = `");
const pageEnd = source.indexOf("</html>`;", pageStart);
const page = {};
vm.runInNewContext("PAGE=" + source.slice(pageStart + "const PAGE = ".length, pageEnd + "</html>`".length), page);
const script = [...page.PAGE.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]).join("\n");
const slice = (from, to, src = script) => { const a = src.indexOf(from); const b = src.indexOf(to, a); assert.ok(a >= 0 && b > a, from); return src.slice(a, b); };

function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch])); }

test("テスト：連携済み患者の情報は最初に最小表示（次回予約・前回来院）で出し、全情報は折りたたみの中に残す", () => {
  const ctx = { esc };
  vm.createContext(ctx);
  vm.runInContext(slice("function cpJpDate(", "function cpBadgeHtml("), ctx);
  vm.runInContext(slice("function cpBadgeHtml(", "function karteLoadingCard("), ctx);
  vm.runInContext(slice("function cpGripHtml(", "function renderCustomer("), ctx);
  const html = ctx.custFoundHtml({
    patient: { name: "テスト 花子", visitCount: 3 },
    bookings: {
      upcoming: [{ date: "2026-11-12 14:00", menu: "テスト照射", status: "予約済", statusKey: "booked", apptId: "a1" }],
      past: [{ date: "2026-10-01 10:00", statusKey: "cancelled" }, { date: "2026-09-20 11:00", statusKey: "done", status: "完了" }],
    },
  });
  const compact = html.slice(0, html.indexOf('<div class="cpFullWrap"'));
  assert.match(compact, /class="cpCompact"/);
  assert.match(compact, /テスト 花子/);
  assert.match(compact, /次回<\/span><b>11月12日\(木\) 14:00<\/b>/);
  assert.match(compact, /前回来院<\/span><b>9月20日\(日\)<\/b>/); // キャンセルは前回来院に数えない
  assert.match(compact, /<button type="button" class="cpCToggle" data-cp="expand"/);
  const full = html.slice(html.indexOf('<div class="cpFullWrap"'));
  for (const part of ["次回のご予約", "最終来院", "cpKarteArea", "カルテクイック", "▲ 小さく戻す"]) assert.ok(full.includes(part), part);
  const none = ctx.custFoundHtml({ patient: { name: "テスト" }, bookings: { upcoming: [], past: [] } });
  assert.match(none.slice(0, none.indexOf("cpFullWrap")), /次回<\/span><span class="cpMuted">なし/);
});

function panelDom() {
  const classes = new Set();
  const wrap = { style: {}, scrollTop: 30, scrollHeight: 400, clientHeight: 200, offsetHeight: 260 };
  const toggle = { attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } };
  const panel = {
    style: {},
    classList: { add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c) },
    querySelector: sel => (sel === ".cpCToggle" ? toggle : null),
  };
  const tab = { style: {} };
  const els = { custPanel: panel, custTab: tab, cpFullWrap: wrap };
  return { classes, wrap, toggle, panel, tab, document: { getElementById: id => els[id] || null } };
}

test("テスト：▼で全情報へ、▲・上スワイプで最小表示へ戻す（同じ会話の再描画では開いたまま）", () => {
  const dom = panelDom();
  const ctx = { document: dom.document, window: { innerHeight: 800 }, current: "conv1", Math };
  vm.createContext(ctx);
  vm.runInContext(slice("var cpExpandedFor=null;", "function cpBindTouch("), ctx);
  vm.runInContext(slice("function cpApplyState(", "function cpGripHtml("), ctx);
  ctx.cpApplyState(dom.panel, "conv1");
  assert.ok(dom.classes.has("cpIsCompact"));
  assert.equal(dom.wrap.style.maxHeight, "0px");
  ctx.cpExpand();
  assert.ok(!dom.classes.has("cpIsCompact"));
  assert.equal(dom.wrap.style.maxHeight, "480px"); // 画面の6割まで。超える分は中でスクロール
  assert.equal(dom.wrap.scrollTop, 0);
  assert.equal(dom.toggle.attrs["aria-expanded"], "true");
  ctx.cpApplyState(dom.panel, "conv1"); // 読み込み完了による再描画
  assert.ok(!dom.classes.has("cpIsCompact"));
  ctx.cpApplyState(dom.panel, "conv2"); // 別の会話は最小表示から
  assert.ok(dom.classes.has("cpIsCompact"));
  ctx.cpExpand();
  ctx.cpCollapse();
  assert.ok(dom.classes.has("cpIsCompact"));
  assert.equal(dom.wrap.style.maxHeight, "0px");
  assert.equal(dom.toggle.attrs["aria-expanded"], "false");
  assert.equal(dom.tab.style.display, "none"); // 連携済みでは完全には隠さない
});

test("テスト：受信時の予約操作は、本人確認済み・本人の予約・変更可・未来日時のときだけスタッフ確認の提案にする", () => {
  const ctx = { Date, Array, String, Object, JSON };
  vm.createContext(ctx);
  vm.runInContext(slice("function normalizeStaffBookingAction(", "const DRAFTCHAT_MEMORY_RULE", source), ctx);
  const baCtx = { ok: true, verified: true, appointments: [
    { id: "a1", label: "11月12日(木) 14:00", menu: "テスト照射", location: "テスト院", changeable: true, feeNote: "前日は1,100円" },
    { id: "a2", label: "11月13日(金) 10:00", menu: "テスト", changeable: false },
  ] };
  const cancel = ctx.bookingSuggestionFromDraft({ baCtx, action: { type: "cancel", appointmentId: "a1" } });
  assert.equal(cancel.type, "cancel");
  assert.equal(cancel.appointmentId, "a1");
  assert.equal(cancel.appointmentLabel, "11月12日(木) 14:00");
  assert.equal(cancel.feeNote, "前日は1,100円");
  assert.equal(cancel.status, "proposed");
  const future = new Date(Date.now() + 7 * 864e5);
  const ymd = future.toLocaleString("sv-SE", { timeZone: "Asia/Tokyo" }).slice(0, 10);
  const re = ctx.bookingSuggestionFromDraft({ baCtx, action: { type: "reschedule", appointmentId: "a1", newDateTime: ymd + "T15:00" } });
  assert.equal(re.type, "reschedule");
  assert.match(re.targetLabel, /15:00/);
  assert.equal(ctx.bookingSuggestionFromDraft({ baCtx, action: { type: "cancel", appointmentId: "a2" } }), null); // 受付期限外
  assert.equal(ctx.bookingSuggestionFromDraft({ baCtx, action: { type: "cancel", appointmentId: "別人の予約" } }), null);
  assert.equal(ctx.bookingSuggestionFromDraft({ baCtx: { ...baCtx, verified: false }, action: { type: "cancel", appointmentId: "a1" } }), null);
  assert.equal(ctx.bookingSuggestionFromDraft({ baCtx, action: { type: "reschedule", appointmentId: "a1", newDateTime: "2020-01-01T10:00" } }), null);
  assert.equal(ctx.bookingSuggestionFromDraft({ baCtx, action: { type: "slots", appointmentId: "a1", date: ymd } }), null);
});

test("テスト：自動受付が動かない時は予約操作を実行せず、提案カードと実行後の案内文を下書きにして自動送信しない", async () => {
  const start = source.indexOf("async function handleInboundCore("), end = source.indexOf("// ===== 複数アカウント対応", start);
  const helpers = {};
  vm.runInNewContext(slice("function normalizeStaffBookingAction(", "const DRAFTCHAT_MEMORY_RULE", source), helpers);
  const decision = require("../lib/reply-decision.js");
  const { preserveTopicBoundary } = require("../lib/conversation-context.js");
  for (const mode of ["off", "staffReview", "autoNeedsStaff"]) {
    let executed = 0, delivered = 0, approvals = 0;
    const context = {
      ...decision, preserveTopicBoundary, cancelAutoReply: () => {}, colorFor: () => "", nowt: () => "テスト", statBump: () => {}, lastText: () => "テスト", dbSave: () => {},
      normalizeStaffBookingAction: helpers.normalizeStaffBookingAction, bookingSuggestionFromDraft: helpers.bookingSuggestionFromDraft,
      baEnabled: () => mode !== "off", staffLineReviewAll: () => mode === "staffReview", staffBookingSuggestEnabled: () => true,
      PARTNER_KEY: "テスト", baHandlePending: async () => false, enrichStaffLineBookingPreview: async (_t, _c, g) => g,
      genDraft: async () => ({ draft: "テスト：キャンセルを確認いたします。", after_action_draft: "テスト：キャンセルを承りました。", confidence: "high", needs_human: mode === "autoNeedsStaff", replyRequiresStaff: mode === "autoNeedsStaff",
        grounding: { autoSendAllowed: true, reasons: [] }, validation: { pass: true },
        action: { type: "cancel", appointmentId: "a1" },
        baCtx: { ok: true, verified: true, appointments: [{ id: "a1", label: "11月12日(木) 14:00", menu: "テスト", changeable: true }] } }),
      startLearningUsageTrace: async () => {}, baAction: async () => { executed++; return true; }, S: () => ({ autoReply: true, staffLineEnabled: true, staffLineReplyMode: "exceptions" }),
      deliverText: async () => { delivered++; return { sent: true }; }, notifyAll: () => {}, staffLineEscalate: async () => {}, staffLineRequestApproval: async () => { if (mode !== "staffReview") approvals++; }, staffLineReady: () => true, scheduleAutoReply: () => { delivered++; },
      aiUsageContext: { getStore: () => ({ entries: [] }) }, forwardToPartner: async () => {},
    };
    vm.runInNewContext(source.slice(start, end), context);
    const t = { slug: "テスト", store: {} };
    await context.handleInboundCore(t, { channel: "line", uid: "テスト", text: "テスト：11/12の予約をキャンセルしたいです" });
    const c = t.store["line:テスト"];
    assert.equal(executed, 0, mode);
    assert.equal(delivered, 0, mode);
    assert.equal(c.bookingSuggestion.type, "cancel");
    assert.equal(c.bookingSuggestion.appointmentId, "a1");
    // スタッフLINEの毎回承認では完了の案内文を下書きにしない（LINEの承認だけで送れてしまうため）。OFFの医院では draft 自体が実行後の案内文
    assert.equal(c.draft, mode === "autoNeedsStaff" ? "テスト：キャンセルを承りました。" : "テスト：キャンセルを確認いたします。", mode);
    assert.equal(approvals, 0, mode + " スタッフLINEの承認だけで完了文を送らない");
  }
});

test("テスト：提案カードは未実行のまま送ろうとすると確認し、実行は既存のスタッフ確認つき予約操作を通す", () => {
  const fn = slice("async function runBookingSuggestion(", "async function dismissBookingSuggestion(");
  assert.match(fn, /api\("\/api\/staff-booking-action"/);
  assert.match(fn, /await uiConfirm\(/);
  assert.match(fn, /api\("\/api\/staff-booking-confirm",\{[^}]*approve:!!ok/);
  const send = slice("async function sendMsg(", "if(window.__sendBusy");
  assert.match(send, /まだ実行していません/);
  assert.match(source, /if \(approve && out\.ok && c\.bookingSuggestion && String\(c\.bookingSuggestion\.appointmentId\) === String\(pending\.appointmentId\)/);
  assert.match(source, /delete c\.draftChatSession; c\.bookingSuggestion = null;/);
});
