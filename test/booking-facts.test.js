"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const {
  ANSWER_FIRST_POLICY, bookingFactsBlock, learningUsesRetiredTerms, normalizeBookingPageUrl, normalizeRetiredTerms, textMentionsRetiredTerm,
} = require("../lib/booking-facts");

const source = fs.readFileSync(path.join(__dirname, "..", "migiude.js"), "utf8");
function section(start, end) {
  const a = source.indexOf(start);
  const b = source.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, "section not found: " + start);
  return source.slice(a, b);
}

test("予約ページURLは https の正しいURLだけを受け付け、空欄は解除として扱う", () => {
  assert.equal(normalizeBookingPageUrl("https://app.uketsuke-run.online/booking/smilemedi"), "https://app.uketsuke-run.online/booking/smilemedi");
  assert.equal(normalizeBookingPageUrl("  "), "");
  assert.equal(normalizeBookingPageUrl("http://example.com"), null);
  assert.equal(normalizeBookingPageUrl("javascript:alert(1)"), null);
  assert.equal(normalizeBookingPageUrl("https://user:pass@example.com/"), null);
  assert.equal(normalizeBookingPageUrl("テスト"), null);
  assert.equal(normalizeBookingPageUrl("https://example.com/" + "a".repeat(400)), null);
});

test("使わなくなった語句は行・読点区切りで重複を除き、短すぎる語と上限を超えた分は捨てる", () => {
  assert.deepEqual(normalizeRetiredTerms("kalonade\nカロネード、KALONADE\n a \n"), ["kalonade", "カロネード"]);
  assert.equal(normalizeRetiredTerms(Array.from({ length: 30 }, (_, i) => "テスト語" + i)).length, 20);
  assert.deepEqual(normalizeRetiredTerms(null), []);
  assert.equal(textMentionsRetiredTerm("https://hb-clinic.KALONADE.com/x", ["kalonade"]), true);
  assert.equal(textMentionsRetiredTerm("https://app.uketsuke-run.online/booking/x", ["kalonade"]), false);
  assert.equal(textMentionsRetiredTerm("何でも", []), false);
});

test("旧サイトを案内した学習例を見分ける（AIの初回案だけに残っている場合は除外しない）", () => {
  const terms = ["kalonade"];
  assert.equal(learningUsesRetiredTerms({ q: "テスト予約したい", final: "テスト https://hb-clinic.kalonade.com/x からどうぞ" }, terms), true);
  assert.equal(learningUsesRetiredTerms({ q: "テスト", final: "テスト", instr: "kalonadeのURLを貼って" }, terms), true);
  assert.equal(learningUsesRetiredTerms({ q: "テスト", final: "テスト", learningMeta: { answer: "kalonade から予約" } }, terms), true);
  assert.equal(learningUsesRetiredTerms({ q: "テスト", final: "予約ページからどうぞ", draft0: "kalonade から" }, terms), false);
  assert.equal(learningUsesRetiredTerms({ q: "テスト", final: "テスト kalonade" }, []), false);
});

test("予約ページの案内文は、設定が無ければ何も足さず、あれば案内先と旧サイトの禁止を書く", () => {
  assert.equal(bookingFactsBlock({}), "");
  const block = bookingFactsBlock({ bookingPageUrl: "https://app.uketsuke-run.online/booking/smilemedi", retiredTerms: ["kalonade", "カロネード"] });
  assert.match(block, /空き枠の確認を案内するときの予約ページのURLは https:\/\/app\.uketsuke-run\.online\/booking\/smilemedi /);
  assert.match(block, /予約の確認・変更・キャンセルの受付方法（予約ページ・電話・LINEなど）は店舗ルールに従う/);
  assert.match(block, /kalonade \/ カロネード/);
  assert.match(block, /過去の対応例・書き方の見本・会話履歴・ルールに出てきても/);
  assert.match(block, /上の予約ページのURLに置き換える/);
  // 予約ページのURLに含まれる語は旧語句として扱わない
  assert.doesNotMatch(bookingFactsBlock({ bookingPageUrl: "https://app.uketsuke-run.online/booking/smilemedi", retiredTerms: ["uketsuke", "kalonade"] }), /uketsuke \//);
  assert.doesNotMatch(bookingFactsBlock({ bookingPageUrl: "http://bad" }), /http:\/\/bad/);
});

test("保留にしない答え方: 答えられる部分は答え、足りない情報は患者に尋ね、医院側の確認だけ保留にする", () => {
  assert.match(ANSWER_FIRST_POLICY, /答えられる部分は、その場で具体的に答える/);
  assert.match(ANSWER_FIRST_POLICY, /必要な情報を患者に具体的に尋ねる/);
  assert.match(ANSWER_FIRST_POLICY, /医院側で確認しないと答えられない部分だけに使い、何を確認するのかを一言で書く/);
});

test("自動下書き・相談・作り直しの3経路に、保留にしない答え方と予約ページの案内を入れる", () => {
  const gen = section("async function genDraft(", "async function enrichStaffLineBookingPreview(");
  assert.match(gen, /\+ "\\n\\n" \+ ANSWER_FIRST_POLICY/);
  assert.match(gen, /bookingFactsOf\(t\)/);
  assert.doesNotMatch(gen, /根拠が無い場合は推測せず『確認してご案内します』と伝え/);
  const consult = section("async function draftChatPrep(", "async function runDraftChat(");
  assert.match(consult, /ANSWER_FIRST_POLICY/);
  assert.match(consult, /bookingFactsOf\(t\)/);
  const regen = section("会話の最後に入るスタッフの内部指示メモに沿って", "出力はそのままお客様に送信される");
  assert.match(regen, /ANSWER_FIRST_POLICY/);
  assert.match(regen, /bookingFactsOf\(t\)/);
});

test("旧サイトを含む学習例は、下書きの根拠・書き方の見本・矛盾判定のどれにも使わない", () => {
  assert.match(section("function examplesRanked(", "function trustedLearningPrecedent("), /!learningUsesRetiredTerms\(example, retired\)/);
  assert.match(section("async function checkConflict(", "function learningConflicts("), /!learningUsesRetiredTerms\(example, retired\)/);
  const ctx = {
    learningConflicts: () => [],
    learningJobs: () => [],
    rankLearningExamples: (list, _q, k) => list.slice(0, k),
    LEARNING_INTENT_LABELS: { other: "その他" },
    learningIntentKey: () => "other",
    maskStyleSample: s => s,
    STYLE_SAMPLE_PERSONAL: /痛/,
    STYLE_SAMPLE_SETTLE_MS: 0,
    reusableLearningSummary: () => "判断手順",
    STYLE_SAMPLES_K: 3,
    retiredTermsOf: () => ["kalonade"],
    learningUsesRetiredTerms,
  };
  vm.createContext(ctx);
  vm.runInContext(section("function styleSamples(", "// ---------- helpers ----------"), ctx);
  const old = { id: 1, ts: 1, q: "テスト予約", final: "テストのご案内です。こちらからご予約ください https://hb-clinic.kalonade.com/x" };
  const fresh = { id: 2, ts: 1, q: "テスト予約", final: "テストのご案内です。こちらからご予約ください https://app.uketsuke-run.online/booking/x" };
  const samples = ctx.styleSamples({ examples: { 1: old, 2: fresh } }, "テスト予約", "テスト予約");
  assert.equal(JSON.stringify(samples.map(s => s.id)), "[2]");
});

test("設定画面で予約ページURLと使わなくなった語句を保存でき、不正なURLは何も変えずに断る", () => {
  const route = section('app.post("/api/settings"', 'app.post("/api/done"');
  const validateAt = route.indexOf("booking_page_url_invalid");
  const firstMutation = route.indexOf("S(t).autoReply =");
  assert.ok(validateAt > 0 && validateAt < firstMutation, "URLの検証は設定を書き換える前に行う");
  assert.match(route, /S\(t\)\.retiredTerms = kept;/);
  assert.ok(route.indexOf("retired_terms_invalid") < firstMutation, "語句の形式チェックも書き換え前");
  assert.match(source, /id="setBookingPageUrl" type="url"/);
  assert.match(source, /id="setRetiredTerms"/);
  assert.match(source, /level,tone,bookingPageUrl,retiredTerms,engine,aiRoutes,autoDelayMin/);
});

test("下書きに旧予約サイト・語句が残ったら、自動送信を止めてスタッフ確認へ回す", () => {
  const ctx = { textMentionsRetiredTerm, retiredTermsOf: () => ["kalonade"] };
  vm.createContext(ctx);
  vm.runInContext(section("function applyRetiredTermGate(", "// 設定画面の注意表示"), ctx);
  const out = { draft: "テスト https://hb-clinic.kalonade.com/x からご予約ください", needs_human: false, confidence: "high", qualityIssues: [], grounding: { autoSendAllowed: true, reasons: [] }, validation: { pass: true } };
  assert.equal(ctx.applyRetiredTermGate({}, out), true);
  assert.equal(out.needs_human, true);
  assert.equal(out.grounding.autoSendAllowed, false);
  assert.equal(out.validation.pass, false);
  assert.ok(out.qualityIssues.includes("retired_booking_site"));
  const ok = { draft: "テスト https://app.uketsuke-run.online/booking/x", grounding: { autoSendAllowed: true, reasons: [] } };
  assert.equal(ctx.applyRetiredTermGate({}, ok), false);
  assert.equal(ok.grounding.autoSendAllowed, true);
  // 監査の書き直しの後（最終の下書き）で判定し、送信前監査にも設定の予約ページを根拠として渡す
  const gen = section("async function genDraft(", "async function enrichStaffLineBookingPreview(");
  assert.ok(gen.indexOf("applyRetiredTermGate(t, out)") > gen.indexOf("validateDraftAgainstEvidence(t, {"));
  assert.match(gen, /bookingPage: bookingFactsOf\(t\)/);
  assert.match(section("async function validateDraftAgainstEvidence(", "\n}\n"), /【設定の予約ページのURL（自院の予約ページを案内する場合の正しいURL。キャンセル・変更の受付方法や他の媒体の案内は店舗ルールに従う）】/);
  assert.match(out.grounding.reasons[0], /使わなくなった予約サイト/, "スタッフLINEは先頭の理由だけ出すので先頭に入れる");
});

test("キャンセル・変更の依頼では、尋ねられていなくてもキャンセル料・変更料の規定は省かない", () => {
  assert.match(ANSWER_FIRST_POLICY, /キャンセル・日時変更の依頼に対するキャンセル料・変更料、免除条件など）は、尋ねられていなくても店舗ルールどおり案内する/);
  assert.doesNotMatch(ANSWER_FIRST_POLICY, /尋ねていない用件（キャンセル料/);
  // 現役の他媒体（トリビュー等）の案内は置き換えない。置き換えるのは使わなくなったサイトだけ
  assert.match(bookingFactsBlock({ bookingPageUrl: "https://example.com/b" }), /今も使っている他の媒体・サービスの案内やURLは店舗ルールどおりに案内し、このURLに置き換えない/);
  assert.doesNotMatch(bookingFactsBlock({ bookingPageUrl: "https://example.com/b" }), /別の予約サイトのURLが書かれていても/);
  assert.match(bookingFactsBlock({ bookingPageUrl: "https://example.com/b", retiredTerms: ["kalonade"] }), /使わなくなった予約サイトの案内が.*その部分だけ上の予約ページのURLに置き換える/);
  assert.doesNotMatch(bookingFactsBlock({ bookingPageUrl: "https://example.com/b" }), /より優先する/);
});

test("設定画面に、旧語句がルールブック・共通指示に残っている件数と学習例の除外件数を出す", () => {
  assert.match(source, /retiredTermHits: retiredTermHits\(t\),/);
  assert.match(source, /function renderRetiredTermWarn\(h\)/);
  assert.match(source, /学習例の半数以上/);
});

test("使わなくなった語句・テンプレートの入力は文字列以外を受け付けず、並び替えの向きは上下だけ", () => {
  const T = require("../lib/reply-templates");
  assert.deepEqual(normalizeRetiredTerms([{ toString: 1 }, "kalonade", 5]), ["kalonade"]);
  assert.deepEqual(T.saveTemplate([], { title: { a: 1 }, body: "テスト" }), { ok: false, error: "required" });
  const r = T.saveTemplate([], { title: "テスト", body: "テスト" }, 1);
  assert.deepEqual(T.moveTemplate(r.templates, r.template.id, "abc"), { ok: false, error: "invalid_direction" });
});

test("スタッフLINEの承認でも、旧予約サイト・語句が残る返信案は送らない", () => {
  const route = section('const action = q.get("migiude"), found = staffLineApprovalById(t, q.get("id"));', "sendLocks.add(lockKey)");
  assert.match(route, /action === "send" && textMentionsRetiredTerm\(/);
  assert.ok(route.indexOf("textMentionsRetiredTerm(") < route.indexOf("const lockKey"), "送信ロックの前に断る");
});

test("設定の取得ではテンプレート本文を返さず件数だけ返す", () => {
  assert.match(source, /templates: undefined,\n    templateCount: normalizeTemplates\(S\(t\)\.templates\)\.length,/);
  assert.match(source, /tplSetCount\(s\.templateCount\)/);
});
