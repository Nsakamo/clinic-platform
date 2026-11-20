"use strict";

// カルテクイック（2026-11-20 ユーザー依頼）
// - 定型文の {{date}} などを、うけつけるんが返した値で置き換える。連携できない値・知らない変数は空欄。
// - 顧客備考と施術記録を選んで追加できる（既定は顧客備考＝従来どおり）。
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

function karteContext(extra = {}) {
  const ctx = { esc, window: {}, karteKind: "note", karteEntries: {}, encodeURIComponent, String, Array, ...extra };
  vm.createContext(ctx);
  vm.runInContext("var karteKind=\"note\";", ctx);
  vm.runInContext(slice("function snipRowHtml(", "function karteEditStart("), ctx);
  vm.runInContext(slice("function snipInsert(", "function karteExpand("), ctx);
  return ctx;
}

test("テスト：定型文の変数は値で置き換え、スタッフ名など連携できない値・知らない変数は空欄にする", () => {
  const ctx = karteContext();
  ctx.window.karteVars = { date: "2026年11月20日", menu_names: "", staff_name: "", patient_name: "テスト 花子" };
  const tpl = "{{date}}：{{menu_names}}\n👩‍⚕️：{{staff_name}}\n✏️：{{ patient_name }} {{unknown}}";
  assert.equal(ctx.karteRenderVars(tpl), "2026年11月20日：\n👩‍⚕️：\n✏️：テスト 花子 ");
  ctx.window.karteVars = {}; // 旧版のうけつけるん（vars なし）でも {{…}} は残さない
  assert.equal(ctx.karteRenderVars("{{date}}：メモ"), "：メモ");
  assert.equal(ctx.karteRenderVars("{date} と $1 はそのまま"), "{date} と $1 はそのまま");
  assert.equal(ctx.karteRenderVars("{{constructor}}{{toString}}{{__proto__}}"), ""); // 組み込みの名前も空欄
});

test("テスト：定型文を押すと、変数を置き換えた本文が入力欄に入る（追加・編集どちらも）", () => {
  const add = { value: "既存", focus() {} };
  const edit = { value: "", focus() {} };
  const ctx = karteContext({ document: { getElementById: id => (id === "karteAddText" ? add : null) } });
  ctx.window.karteVars = { date: "2026年11月20日", menu_names: "ホワイトニング60分", staff_name: "" };
  ctx.snipInsert("{{date}}：{{menu_names}}\n担当：{{staff_name}}", "add", null);
  assert.equal(add.value, "既存\n2026年11月20日：ホワイトニング60分\n担当：");
  const host = { querySelector: () => edit };
  ctx.snipInsert("{{date}}", "edit_1", { closest: () => host });
  assert.equal(edit.value, "2026年11月20日");
});

test("テスト：カルテクイックに「顧客備考／施術記録」の選択があり、既定は顧客備考", () => {
  const ctx = karteContext();
  const html = ctx.karteHtml({ found: true, patient: { name: "テスト 花子" }, entries: [], snippets: [{ title: "施術記録用", body: "{{date}}" }], vars: { date: "2026年11月20日" } }, true);
  assert.match(html, /追加する記録：<button type="button" class="kKind kKindNote" data-cp="kartekind" data-val="note" aria-pressed="true">顧客備考<\/button>/);
  assert.match(html, /data-val="treatment" aria-pressed="false">施術記録<\/button>/);
  assert.match(html, /placeholder="顧客備考を追加/);
  assert.match(html, />顧客備考として保存<\/button>/);
  assert.deepEqual(ctx.window.karteVars, { date: "2026年11月20日" });
});

test("テスト：施術記録を選ぶと、ボタン・案内文・保存先が切り替わる", () => {
  const buttons = ["note", "treatment"].map(v => ({ v, attrs: {}, getAttribute(k) { return k === "data-val" ? this.v : null; }, setAttribute(k, val) { this.attrs[k] = val; } }));
  const save = { textContent: "顧客備考として保存" };
  const ta = { attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } };
  const foot = { querySelectorAll: () => buttons, querySelector: () => save };
  const ctx = karteContext({ document: { getElementById: () => ta } });
  ctx.karteSetKind("treatment", { closest: () => foot });
  assert.equal(vm.runInContext("karteKind", ctx), "treatment");
  assert.deepEqual(buttons.map(b => b.attrs["aria-pressed"]), ["false", "true"]);
  assert.equal(save.textContent, "施術記録として保存");
  assert.match(ta.attrs.placeholder, /^施術記録を追加/);
  ctx.karteSetKind("bogus", { closest: () => foot });
  assert.equal(vm.runInContext("karteKind", ctx), "note"); // 不明な値は顧客備考
  // 次に開いたときも選んだ種類のまま描画する
  ctx.karteSetKind("treatment", { closest: () => foot });
  assert.match(ctx.karteHtml({ found: true, patient: {}, entries: [] }, true), /data-val="treatment" aria-pressed="true"/);
});

test("テスト：保存は選んだ種類で送り、ボタンのクリックで種類を切り替えられる", () => {
  const add = slice("async function karteAdd(", "async function karteEdit(");
  assert.match(add, /var kind=karteKind;/);
  assert.match(add, /action:"add",patientId:custPid,body:body,kind:kind/);
  assert.match(add, /j&&j\.kind_unsupported/);
  assert.match(slice("function karteClick(", "function closeKarte("), /else if\(act==="kartekind"\) karteSetKind\(val,b\);/);
});

function karteRoute(partnerResult) {
  const start = source.indexOf('app.post("/api/customer-karte"');
  const end = source.indexOf('app.post("/api/customer-appt-cancel"', start);
  const handlers = new Map();
  const calls = [];
  const ctx = {
    app: { post: (route, ...h) => handlers.set(route, h.at(-1)) }, guard() {}, oneMutationAtATime: () => (_q, _s, n) => n(),
    partnerPost: async (path, body) => { calls.push({ path, body }); return partnerResult; },
    partnerReq: async () => ({ json: { ok: true } }), String,
  };
  vm.runInNewContext(source.slice(start, end), ctx);
  const run = async body => {
    let status = 200; let out;
    const res = { status(s) { status = s; return this; }, json(v) { out = v; return this; } };
    await handlers.get("/api/customer-karte")({ tenant: { slug: "test", store: { c1: { id: "c1" } } }, body: { id: "c1", action: "add", patientId: "p1", body: "テスト", ...body } }, res);
    return JSON.parse(JSON.stringify({ status, out }));
  };
  return { run, calls };
}

test("テスト：サーバーは種類をうけつけるんへ渡し、省略時は顧客備考・不明な値は送らない", async () => {
  const ok = karteRoute({ json: { ok: true, id: "r1", kind: "treatment" } });
  assert.deepEqual((await ok.run({ kind: "treatment" })).out, { ok: true, id: "r1", kind: "treatment" });
  assert.deepEqual(JSON.parse(JSON.stringify(ok.calls[0])), { path: "/karte", body: { slug: "test", patientId: "p1", body: "テスト", kind: "treatment" } });
  const note = karteRoute({ json: { ok: true, id: "r2", kind: "note" } });
  await note.run({});
  assert.equal(note.calls[0].body.kind, "note");
  const bad = karteRoute({ json: { ok: true } });
  assert.deepEqual(await bad.run({ kind: "soap" }), { status: 400, out: { ok: false, error: "bad_kind" } });
  assert.equal(bad.calls.length, 0);
});

test("テスト：施術記録のつもりで旧版のうけつけるんが顧客備考で保存したら、そのことを知らせる", async () => {
  const old = karteRoute({ json: { ok: true, id: "r9" } }); // 旧版は kind を返さない
  const { out } = await old.run({ kind: "treatment" });
  assert.deepEqual(out, { ok: false, error: "kind_unsupported", kind_unsupported: true, savedAs: "note", id: "r9" });
  const noteOld = karteRoute({ json: { ok: true, id: "r10" } });
  assert.deepEqual((await noteOld.run({ kind: "note" })).out, { ok: true, id: "r10" }); // 顧客備考なら従来どおり成功
});

test("テスト：別の会話（患者）でカルテクイックを開くと、追加する記録の種類は顧客備考に戻る", () => {
  const ov = { style: {}, innerHTML: "" };
  const ctx = karteContext({ document: { getElementById: id => (id === "chat" ? {} : id === "karteOv" ? ov : null) }, karteCache: {}, kIsPC: () => true, karteLoad() {}, karteLoadingCard: () => "" });
  vm.runInContext("var karteKindConv=null; var current='c1'; var karteCache={};", ctx);
  vm.runInContext(slice("function openKarte(", "function reloadKarte("), ctx);
  ctx.openKarte();
  vm.runInContext("karteKind='treatment';", ctx);
  ctx.openKarte(); // 同じ会話では選んだまま
  assert.equal(vm.runInContext("karteKind", ctx), "treatment");
  vm.runInContext("current='c2';", ctx);
  ctx.openKarte();
  assert.equal(vm.runInContext("karteKind", ctx), "note");
});
