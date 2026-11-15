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
  assert.match(block, /https:\/\/app\.uketsuke-run\.online\/booking\/smilemedi だけを使う/);
  assert.match(block, /kalonade \/ カロネード/);
  assert.match(block, /過去の対応例・書き方の見本・会話履歴・ルールに出てきても/);
  assert.match(block, /上の予約ページに置き換えて案内する/);
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
  assert.match(route, /S\(t\)\.retiredTerms = normalizeRetiredTerms\(req\.body\.retiredTerms\)/);
  assert.match(source, /id="setBookingPageUrl" type="url"/);
  assert.match(source, /id="setRetiredTerms"/);
  assert.match(source, /level,tone,bookingPageUrl,retiredTerms,engine,aiRoutes,autoDelayMin/);
});
