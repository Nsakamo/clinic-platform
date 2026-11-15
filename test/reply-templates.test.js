"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const T = require("../lib/reply-templates");

const source = fs.readFileSync(path.join(__dirname, "..", "migiude.js"), "utf8");

function servedPageScript() {
  const start = source.indexOf("const PAGE = `");
  const end = source.indexOf("</html>`;", start);
  const ctx = {};
  vm.runInNewContext("PAGE=" + source.slice(start + "const PAGE = ".length, end + "</html>`".length), ctx);
  return { html: ctx.PAGE, script: [...ctx.PAGE.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]).join("\n") };
}
function between(text, start, end) {
  const a = text.indexOf(start);
  const b = text.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, "section not found: " + start);
  return text.slice(a, b);
}

test("テンプレートを追加・更新・削除・並び替えできる", () => {
  let r = T.saveTemplate([], { title: " テスト 予約ページの案内 ", category: "予約", body: "{お名前}様\r\nテスト本文 {予約ページ}  " }, 1000);
  assert.equal(r.ok, true);
  assert.equal(r.template.title, "テスト 予約ページの案内");
  assert.equal(r.template.body, "{お名前}様\nテスト本文 {予約ページ}");
  const firstId = r.template.id;
  r = T.saveTemplate(r.templates, { title: "テスト 2件目", category: "キャンセル", body: "テスト" }, 2000);
  const secondId = r.template.id;
  assert.notEqual(firstId, secondId);
  r = T.saveTemplate(r.templates, { id: firstId, title: "テスト 更新", category: "予約", body: "テスト更新本文" }, 3000);
  assert.equal(r.templates[0].title, "テスト 更新");
  assert.equal(r.templates[0].updated, 3000);
  r = T.moveTemplate(r.templates, secondId, -1);
  assert.deepEqual(r.templates.map(t => t.id), [secondId, firstId]);
  assert.deepEqual(T.moveTemplate(r.templates, secondId, -1).templates.map(t => t.id), [secondId, firstId], "先頭より上には動かない");
  r = T.deleteTemplate(r.templates, secondId);
  assert.deepEqual(r.templates.map(t => t.id), [firstId]);
});

test("名前・本文が空、存在しないID、上限超えは断る", () => {
  assert.deepEqual(T.saveTemplate([], { title: "", body: "テスト" }), { ok: false, error: "required" });
  assert.deepEqual(T.saveTemplate([], { title: "テスト", body: "  \n " }), { ok: false, error: "required" });
  assert.deepEqual(T.saveTemplate([], { id: "tpl_none", title: "テスト", body: "テスト" }), { ok: false, error: "not_found" });
  assert.deepEqual(T.deleteTemplate([], "tpl_none"), { ok: false, error: "not_found" });
  assert.deepEqual(T.moveTemplate([], "tpl_none", 1), { ok: false, error: "not_found" });
  const full = Array.from({ length: T.TEMPLATE_MAX }, (_, i) => ({ id: "tpl_" + i, title: "テスト" + i, body: "テスト" }));
  assert.deepEqual(T.saveTemplate(full, { title: "テスト", body: "テスト" }), { ok: false, error: "too_many" });
});

test("保存済みデータの読み込みでは、壊れた行・重複ID・長すぎる値を整える", () => {
  const list = T.normalizeTemplates([
    { id: "tpl_a", title: "テスト\nA", category: "x".repeat(50), body: "b".repeat(3000) },
    { id: "tpl_a", title: "重複", body: "テスト" },
    { id: "../bad", title: "テスト", body: "テスト" },
    { id: "tpl_b", title: "", body: "テスト" },
    null,
  ]);
  assert.equal(list.length, 1);
  assert.equal(list[0].title, "テスト A");
  assert.equal(list[0].category.length, T.TEMPLATE_CATEGORY_MAX);
  assert.equal(list[0].body.length, T.TEMPLATE_BODY_MAX);
});

test("差し込みは名前・予約ページ・医院名を置き換え、分からない項目は目に見える形で残す", () => {
  assert.equal(T.fillTemplate("{お名前}様 {予約ページ} {医院名} {お名前}", { name: "テスト 花子", bookingPageUrl: "https://example.com/b", clinicName: "テスト医院" }),
    "テスト 花子様 https://example.com/b テスト医院 テスト 花子");
  assert.equal(T.fillTemplate("{お名前}様 {予約ページ} {医院名} {未知}", {}), "（お名前）様 （予約ページURL） （医院名） {未知}");
});

test("画面の差し込み（tplFill）はサーバーの fillTemplate と同じ結果になる", () => {
  const { script } = servedPageScript();
  const fn = between(script, "function tplPatientName(", "function tplCategories(");
  const cases = [
    { cache: { c1: { found: true, patient: { name: "テスト 花子" } } }, meta: { bookingPageUrl: "https://example.com/b", clinicName: "テスト医院" }, name: "テスト 花子" },
    { cache: { c1: { found: false } }, meta: { bookingPageUrl: "", clinicName: "" }, name: "" },
  ];
  for (const c of cases) {
    const ctx = { current: "c1", custCache: c.cache, tplMeta: c.meta };
    vm.createContext(ctx);
    vm.runInContext(fn, ctx);
    const body = "{お名前}様\n{予約ページ}\n{医院名}";
    assert.equal(ctx.tplFill(body), T.fillTemplate(body, { name: c.name, bookingPageUrl: c.meta.bookingPageUrl, clinicName: c.meta.clinicName }));
  }
});

test("返信欄に📋ボタンと選択画面、設定に管理画面がある", () => {
  const { html, script } = servedPageScript();
  assert.match(source, /<button id="tplBtn" type="button" onclick="toggleTplPicker\(\)"/);
  assert.match(source, /<div id="tplPop" role="dialog"/);
  assert.match(html, /<div id="tplManagePop" role="dialog" aria-modal="true"/);
  assert.match(html, /onclick="openTplManage\(\)">確認・編集<\/button>/);
  for (const name of ["toggleTplPicker", "insertTemplate", "openTplManage", "tplSave", "tplDelete", "tplMove", "tplSetCache"]) {
    assert.match(script, new RegExp("function " + name + "\\("), name);
  }
  // 差し込みはカーソル位置へ入れ、編集扱い（自動送信しない）にする
  const insert = between(script, "function insertTemplate(", "async function openTplManage(");
  assert.match(insert, /setSelectionRange\(pos,pos\)/);
  assert.match(insert, /draftEdited\(\)/);
  assert.match(insert, /（お名前）/);
  // 二重送信防止: 保存・削除・並び替えは処理中に押せない
  const request = between(script, "async function tplRequest(", "async function tplSave(");
  assert.match(request, /if\(tplBusy\)return null;tplBusy=true;/);
  // 検索欄の Enter は保存ではなく先頭のテンプレートを選ぶだけ
  assert.match(script, /e\.key==="Enter"\)\{e\.preventDefault\(\);var first=pop\.querySelector\("\.tplItem"\)/);
});

test("テンプレートのAPIはログイン必須で、変更は1件ずつ順番に保存する", () => {
  assert.match(source, /app\.get\("\/api\/templates", guard,/);
  for (const route of ["template-save", "template-delete", "template-move"]) {
    assert.match(source, new RegExp('app\\.post\\("/api/' + route + '", guard, oneMutationAtATime\\("templates"\\)'), route);
  }
  const apply = between(source, "async function applyTemplateChange(", 'app.get("/api/templates"');
  assert.match(apply, /catch \(e\) \{ S\(t\)\.templates = before;/, "保存に失敗したら元に戻す");
});
