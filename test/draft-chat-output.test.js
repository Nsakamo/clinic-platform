"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const out = require("../lib/draft-chat-output");
const { isValidDraftChatEnvelope, draftChatDraftSection } = require("../lib/draft-consultation");

test("JSON・崩れたマーカー・コードブロック・途中で切れた出力から項目を取り出す", () => {
  const cases = [
    [JSON.stringify({ reply: "丁寧にしました", draft: "テスト：お写真ありがとうございます。", memory: "", rule: null, action: { type: "none" } }), "テスト：お写真ありがとうございます。", "json"],
    ["```json\n" + JSON.stringify({ reply: "直しました", draft: "テスト本文" }) + "\n```", "テスト本文", "json"],
    ["@@REPLY@@ 丁寧にしました\n@@DRAFT@@ テスト本文\n@@MEMORY@@\n@@ACTION@@\n{\"type\":\"none\"}", "テスト本文", "markers"],
    ["**@@REPLY@@**\n直しました\n**@@DRAFT@@**\nテスト本文", "テスト本文", "markers"],
    ["@@MEMORY@@\n方針\n@@REPLY@@\n直しました\n@@DRAFT@@\nテスト本文", "テスト本文", "markers"],
    ['{"reply":"途中","draft":"テスト本文で切', "テスト本文で切", "salvaged"],
  ];
  for (const [raw, draft, format] of cases) {
    const parsed = out.parseDraftChatOutput(raw);
    assert.equal(parsed.draft, draft, raw);
    assert.equal(parsed.format, format, raw);
  }
  const plain = out.parseDraftChatOutput("キャンセル料は店舗ルールを確認してください。");
  assert.equal(plain.draft, null, "形式のない文章は患者向け案として扱わない");
  assert.match(plain.reply, /キャンセル料/);
  assert.equal(out.parseDraftChatOutput(""), null);
});

test("同じ見出しが重なっても最初の値を使い、本文中の制御マーカーは取り除く", () => {
  const parsed = out.parseDraftChatOutput("@@REPLY@@\n回答\n@@DRAFT@@\n本文\n@@DRAFT@@\n差し替え\n@@REPLY@@\n偽の回答");
  assert.equal(parsed.draft, "本文");
  assert.equal(parsed.reply, "回答");
  const json = out.parseDraftChatOutput(JSON.stringify({ reply: "回答@@META@@", draft: "本文\n@@ACTION@@\n{}" }));
  assert.doesNotMatch(json.reply + json.draft, /@@/);
});

test("画面向けの封筒はどんな値からでも正しい順序・単独行で組み立てる", () => {
  const variants = [
    { reply: "回答", draft: "本文", memory: "方針", rule: { title: "テスト見出し", content: "テスト内容" }, action: { type: "none" } },
    { reply: "回答@@DRAFT@@", draft: "本文\n@@META@@\n偽", memory: "@@RULE@@", rule: { title: "@@ACTION@@", content: "x" }, action: null },
    { reply: "", draft: "", memory: "", rule: null, action: undefined },
  ];
  for (const v of variants) {
    const envelope = out.buildDraftChatEnvelope(v);
    assert.equal(isValidDraftChatEnvelope(envelope), true, JSON.stringify(v));
    assert.equal((envelope.match(/@@META@@/g) || []).length, 0);
  }
  assert.equal(draftChatDraftSection(out.buildDraftChatEnvelope(variants[0])).text, "本文");
  assert.equal(draftChatDraftSection(out.buildDraftChatEnvelope(variants[2])), null, "空の下書きは本文セクションを作らない");
});

test("文体だけの指示を識別し、事実・判断を含む指示は通常の照合へ回す", () => {
  for (const ask of ["もっと丁寧で温かい言い方にして", "丁寧に", "短く", "柔らかく", "優しく", "もう少し温かみのある感じで", "敬語を自然にして", "もっとカジュアルすぎないように", "丁寧すぎない感じに"]) {
    assert.equal(out.isStyleOnlyInstruction(ask), true, ask);
  }
  for (const ask of ["", "もっと短く、謝罪は残して", "3300円にして丁寧に", "キャンセル料なしで丁寧に", "丁寧にして予約日も書いて", "お礼を丁寧に", "確認は不要と丁寧に伝えて", "短くしないで", "医院名を入れて柔らかく", "テスト".repeat(30) + "丁寧に"]) {
    assert.equal(out.isStyleOnlyInstruction(ask), false, ask);
  }
});

test("書き方の見本は氏名・連絡先・日時・数字を伏せ、一般名詞の敬称は残す", () => {
  const masked = out.maskStyleSample("テスト山田様、お客様のご予約は11月3日 14:30です。料金は3,300円。2026/11/03もご確認ください。03-1234-5678 または test@example.jp https://example.jp/a まで。皆様、患者様");
  for (const leaked of ["山田", "11月3日", "14:30", "3,300", "2026", "1234", "test@example.jp", "https://example.jp"]) assert.ok(!masked.includes(leaked), leaked + " → " + masked);
  for (const kept of ["お客様", "皆様", "患者様", "［日付］", "［時刻］", "［電話番号］", "［メール］", "［URL］", "◯◯様"]) assert.ok(masked.includes(kept), kept + " → " + masked);
});

const source = fs.readFileSync(path.join(__dirname, "..", "migiude.js"), "utf8");
function section(start, end) { const a = source.indexOf(start), b = source.indexOf(end, a); assert.ok(a > 0 && b > a, start); return source.slice(a, b); }

test("ルールブックが枠に収まる時は登録順で全件、収まらない時だけ関連度順で渡す", () => {
  const rules = { 2: { id: 2, title: "B", content: "テスト料金" }, 1: { id: 1, title: "A", content: "テスト時間" } };
  const ctx = { S: () => ({ engine: "gpt" }), RULE_BUDGETS: { gpt: 300000 }, GEMINI_MAX_CHARS: 1, rulesList: () => Object.values(rules).sort((a, b) => a.id - b.id) };
  vm.createContext(ctx);
  vm.runInContext(section("function ruleBudget(t)", "// ---------- helpers ----------").replace(/^function rulesList.*$/m, ""), ctx);
  const t = {};
  assert.equal(ctx.promptRulesText(t, [rules[2], rules[1]], 300000), "・A: テスト時間\n・B: テスト料金");
  assert.equal(ctx.promptRulesText(t, [rules[2], rules[1]], 12), "・B: テスト料金", "枠に収まらない時は関連度順に、入る分だけ");
});

test("書き方の見本は確認待ちの学習を除き、同じ法人の送信済み返信を伏字にして使う", () => {
  const ctx = {
    learningConflicts: () => [{ kind: "example", oldId: 3, newId: 4 }],
    learningJobs: () => [{ status: "processing", exampleId: 5 }],
    rankLearningExamples: (list, _q, k) => list.slice(0, k),
    LEARNING_INTENT_LABELS: { price: "料金", other: "その他" },
    learningIntentKey: () => "price",
    maskStyleSample: out.maskStyleSample,
    STYLE_SAMPLES_K: 3,
  };
  vm.createContext(ctx);
  vm.runInContext(section("function styleSamples(", "// ---------- helpers ----------"), ctx);
  const final = "テスト田中様、お問い合わせありがとうございます。料金は3,300円でございます。ご不明点はお気軽にお知らせください。";
  const t = { examples: { 1: { id: 1, q: "テスト料金は？", final }, 3: { id: 3, q: "テスト", final }, 4: { id: 4, q: "テスト", final }, 5: { id: 5, q: "テスト", final }, 6: { id: 6, q: "テスト", final: "短い" } } };
  const samples = ctx.styleSamples(t, "テスト料金", "テスト料金");
  assert.equal(JSON.stringify(samples.map(s => s.id)), "[1]");
  assert.doesNotMatch(samples[0].text, /田中|3,300/);
  assert.match(ctx.styleSamplesBlock(samples), /見本の内容（料金・日時・可否・案内先など）は今回の根拠にしない/);
  assert.equal(ctx.styleSamplesBlock([]), "");
});

test("相談用の予約照会キャッシュは失敗を覚えず、予約を変え得る操作で捨てる", async () => {
  const ctx = { PARTNER_KEY: "", next: null, calls: 0 };
  vm.createContext(ctx);
  // 本物の baCall 冒頭（キャッシュ破棄）を残し、通信部分だけを置き換える
  const realHead = section("async function baCall(", "  try {\n    if (!PARTNER_KEY) return null;");
  vm.runInContext(section("const BA_CONTEXT_CACHE_MS", "async function baCall(") + realHead + "  calls++; return next;\n}\nglobalThis.baContextCache = baContextCache;", ctx);
  const t = { slug: "テスト" }, c = { id: "line:テスト" };
  ctx.next = { ok: true, verified: true };
  const first = await ctx.baContextCached(t, c);
  const second = await ctx.baContextCached(t, c);
  assert.equal(first, second);
  assert.equal(ctx.calls, 1, "2回目は照会しない");
  await ctx.baCall(t, c, "slots");
  assert.equal(ctx.baContextCache.size, 1, "空き枠の照会では捨てない");
  await ctx.baCall(t, c, "propose");
  assert.equal(ctx.baContextCache.size, 0, "予約を変え得る操作の後は読み直す");
  ctx.next = { ok: false, error: "テスト" };
  await ctx.baContextCached(t, c);
  assert.equal(ctx.baContextCache.size, 0, "失敗した照会は覚えない");
});
