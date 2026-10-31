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
  for (const ask of ["もっと丁寧で温かい言い方にして", "丁寧に", "柔らかく", "優しく", "もう少し温かみのある感じで", "敬語を自然にして", "もっとカジュアルすぎないように", "丁寧すぎない感じに"]) {
    assert.equal(out.isStyleOnlyInstruction(ask), true, ask);
  }
  for (const ask of ["", "短く", "もっと簡潔に", "端的に", "もっと詳しく", "長くして", "もっと短く、謝罪は残して", "3300円にして丁寧に", "キャンセル料なしで丁寧に", "丁寧にして予約日も書いて", "お礼を丁寧に", "確認は不要と丁寧に伝えて", "短くしないで", "医院名を入れて柔らかく", "テスト".repeat(30) + "丁寧に"]) {
    assert.equal(out.isStyleOnlyInstruction(ask), false, ask);
  }
});

test("入れ子のマーカーや見出しに紛れた記号でも、封筒の見出しは増えない", () => {
  const nested = "@@D@@DR@@REPLY@@AFT@@RAFT@@\n今回は無料です";
  const parsed = out.parseDraftChatOutput(JSON.stringify({ reply: nested, draft: null, rule: { title: "@@DR@@REPLY@@AFT@@", content: "@@@@DRAFT@@@@" }, action: { type: "none", note: "@@DRAFT@@" } }));
  const envelope = out.buildDraftChatEnvelope(parsed);
  assert.equal(isValidDraftChatEnvelope(envelope), true);
  assert.equal(draftChatDraftSection(envelope), null, "照合していない文を下書きにしない");
  assert.deepEqual(envelope.match(/@@[A-Z]+@@/g), ["@@REPLY@@", "@@MEMORY@@", "@@RULE@@", "@@ACTION@@"]);
  assert.equal(out.parseDraftChatOutput(JSON.stringify({ reply: "x", draft: { text: "オブジェクト" } })).draft, null, "文字列以外の下書きは無視");
});

test("文体だけの編集で照合を省けるのは、判断に関わる語が増減しない時だけ", () => {
  assert.equal(out.decisionTermsPreserved("テスト：お写真ありがとうございます。ご使用に問題はございません。", "テスト：お写真をお送りいただき、誠にありがとうございます。ご使用に問題はございませんので、どうぞそのままお使いください。"), true);
  assert.equal(out.decisionTermsPreserved("証明書をご提出いただければ3,300円は免除となる場合があります。", "3,300円は免除となります。"), false, "条件の節を落とした");
  assert.equal(out.decisionTermsPreserved("テスト：白い部分は成形時のものです。", "テスト：白い部分は成形時のもので、痛みもなく大丈夫です。"), false, "根拠のない安心・医療の主張を足した");
  assert.equal(out.decisionTermsPreserved("キャンセルは可能です。", "キャンセルはできかねます。"), false);
  assert.equal(out.decisionTermsPreserved("お写真ありがとうございます。担当医が確認のうえ、改めてご連絡いたします。", "お写真ありがとうございます。施術後によく見られるものですので、どうぞご安心ください。担当医が確認のうえ、改めてご連絡いたします。"), false, "根拠のない安心づけを足した");
});

test("書き方の見本は氏名・連絡先・日時・数字を伏せ、一般名詞の敬称は残す", () => {
  const masked = out.maskStyleSample("テスト山田様、お客様のご予約は11月3日 14:30です。料金は3,300円。2026/11/03もご確認ください。03-1234-5678 または test@example.jp https://example.jp/a まで。皆様、患者様");
  for (const leaked of ["山田", "11月3日", "14:30", "3,300", "2026", "1234", "test@example.jp", "https://example.jp"]) assert.ok(!masked.includes(leaked), leaked + " → " + masked);
  const names = out.maskStyleSample("さくら様、山田 花子様、髙﨑様、テスト・太郎さん、お子様、ご家族様、スタッフさん");
  for (const leaked of ["さくら", "山田", "花子", "髙﨑", "太郎"]) assert.ok(!names.includes(leaked), leaked + " → " + names);
  for (const kept of ["お子様", "ご家族様", "スタッフさん"]) assert.ok(names.includes(kept), kept + " → " + names);
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

test("書き方の見本は再利用可と確認済みの学習だけを使い、今回限り・確認待ちの例は使わない", () => {
  const ctx = {
    learningConflicts: () => [{ kind: "example", oldId: 3, newId: 4 }],
    learningJobs: () => [{ status: "processing", exampleId: 5 }],
    rankLearningExamples: (list, _q, k) => list.slice(0, k),
    LEARNING_INTENT_LABELS: { price: "料金", other: "その他" },
    learningIntentKey: () => "price",
    maskStyleSample: out.maskStyleSample,
    STYLE_SAMPLE_PERSONAL: /痛|腫れ|症状|妊娠/,
    reusableLearningSummary: e => (e.learningMeta && e.learningMeta.scope === "reusable" ? "判断手順" : ""),
    STYLE_SAMPLES_K: 3,
  };
  vm.createContext(ctx);
  vm.runInContext(section("function styleSamples(", "// ---------- helpers ----------"), ctx);
  const final = "テスト田中様、お問い合わせありがとうございます。料金は3,300円でございます。ご不明点はお気軽にお知らせください。";
  const reusable = { scope: "reusable" }, oneOff = { scope: "one_off" };
  const personal = "テスト：妊娠中とのことですので、施術は控えさせていただきます。ご理解のほどお願いいたします。";
  const t = { examples: { 1: { id: 1, q: "テスト料金は？", final, learningMeta: reusable }, 2: { id: 2, q: "テスト特例", final, learningMeta: oneOff }, 7: { id: 7, q: "テスト未学習", final }, 3: { id: 3, q: "テスト", final, learningMeta: reusable }, 4: { id: 4, q: "テスト", final, learningMeta: reusable }, 5: { id: 5, q: "テスト", final, learningMeta: reusable }, 6: { id: 6, q: "テスト", final: "短い", learningMeta: reusable }, 8: { id: 8, q: "テスト", final: personal, learningMeta: reusable } } };
  const samples = ctx.styleSamples(t, "テスト料金", "テスト料金");
  assert.equal(JSON.stringify(samples.map(s => s.id)), "[1]");
  assert.doesNotMatch(samples[0].text, /田中|3,300/);
  assert.match(ctx.styleSamplesBlock(samples), /見本の内容（料金・日時・可否・案内先など）は今回の根拠にしない/);
  assert.equal(ctx.styleSamplesBlock([]), "");
});

test("相談用の予約照会キャッシュは失敗を覚えず、予約を変え得る操作で捨てる", async () => {
  const ctx = { PARTNER_KEY: "", next: null, calls: 0, setInterval: () => ({}), sha: v => require("node:crypto").createHash("sha256").update(v).digest("hex") };
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
  ctx.next = { ok: true, verified: true, who: "A" };
  await ctx.baContextCached(t, c);
  c.ba = { phone: "090-0000-0000" };
  ctx.next = { ok: true, verified: true, who: "B" };
  assert.equal((await ctx.baContextCached(t, c)).who, "B", "本人確認の電話番号が変わったら別の照会として扱う");
  assert.equal(ctx.baContextCache.size, 2);
  assert.ok(![...ctx.baContextCache.keys()].some(k => k.includes("0900000000")), "電話番号をそのまま鍵にしない");
  await ctx.baCall(t, c, "confirm");
  assert.equal(ctx.baContextCache.size, 0, "同じ会話の全キャッシュを捨てる");
  // 会話IDに区切り文字のような文字が含まれても、別の会話のキャッシュを捨てたり取り違えたりしない
  const a = { id: "line:x" }, b = { id: "line:x::y" };
  ctx.next = { ok: true, who: "a" }; await ctx.baContextCached(t, a);
  ctx.next = { ok: true, who: "b" }; await ctx.baContextCached(t, b);
  await ctx.baCall(t, a, "cancel");
  assert.equal(ctx.baContextCache.size, 1, "別の会話（b）のキャッシュは残る");
});

test("初回下書きの自動送信の根拠に数える学習例は、プロンプトの件数を増やしても上位4件のまま", () => {
  const draft = section("async function genDraft(t, c, opts) {", "// 毎回承認モード");
  assert.match(draft, /const exGate = exRel\.slice\(0, LEARNED_EXAMPLES_GATE_K\);/);
  assert.match(draft, /const trustedPrecedents = exGate\.filter\(trustedLearningPrecedent\);/);
  assert.equal((draft.match(/learningExampleCount: exGate\.length/g) || []).length, 2);
  assert.doesNotMatch(draft, /learningExampleCount: exRel\.length/);
  assert.match(source, /const LEARNED_EXAMPLES_GATE_K = 4;/);
});

test("相談の生成指示は根拠のない安心づけを足してよいと書かない", () => {
  const m = source.match(/const STAFF_TONE_PRIORITY = "([^"]*)";/);
  assert.ok(m);
  assert.doesNotMatch(m[1], /安心していただける一言/);
  assert.match(m[1], /根拠のない安心づけ/);
});

test("空の指示は相談の生成に進まない", () => {
  assert.match(source, /edits\[edits\.length - 1\]\.role !== "user" \|\| !String\(latestInstruction \|\| ""\)\.trim\(\)\) return \{ error: "empty" \}/);
});

test("文体だけの編集で照合を省けるのは、否定の数・編集前の語が保たれ、増えた語があいさつの定型だけの時", () => {
  const ok = (a, b) => assert.equal(out.styleEditPreservesContent(a, b), true, b);
  const ng = (a, b) => assert.equal(out.styleEditPreservesContent(a, b), false, b);
  ok("テスト：お写真ありがとうございます。担当医が確認のうえ、改めてご連絡いたします。", "テスト：お写真をお送りいただき、誠にありがとうございます。担当医が確認のうえ、改めてご連絡いたしますので、少々お待ちくださいませ。");
  ng("診断書をご提出いただいた場合、キャンセル料は免除となります。", "診断書をご提出いただいた場合、キャンセル料は免除とはなりません。");
  ng("適用されます。", "適用されません。");
  ng("対象となります。", "対象外となります。");
  ng("銀座院へお越しください。", "新宿院へお越しくださいませ。");
  ng("施術前はお控えください。", "施術後はお控えください。");
  ng("保険証と診察券をお持ちください。", "保険証をお持ちください。");
  ng("テスト：担当医が確認いたします。", "テスト：担当医が確認いたします。お手数ですが、改めてお電話にてご連絡ください。");
  ng("テスト：担当医が確認いたします。", "テスト：担当医が確認いたします。ご来院時は受付にお声がけください。");
  ng("お写真ありがとうございます。担当医が確認のうえ、こちらから改めてご連絡いたします。", "お写真をお送りいただき、誠にありがとうございます。担当医が確認いたしますので、お手数ですが改めてご連絡くださいませ。");
  ng("ご予約のキャンセルのお手続きをいたします。", "ご予約のキャンセルのお手続きをいたしました。ご連絡いただき誠にありがとうございます。");
  ng("お写真ありがとうございます。担当医が確認のうえ、こちらから改めてご連絡いたします。", "お写真をお送りいただき、誠にありがとうございます。担当医が確認のうえ、こちらから改めてご連絡いたします。お手数ですが、改めてお写真をお送りください。");
  ng("お写真ありがとうございます。担当医が確認のうえ、こちらから改めてご連絡いたします。", "お写真をお送りいただき、誠にありがとうございます。担当医が確認のうえ、こちらから改めてご連絡いたします。お手数ですが、改めてご連絡ください。");
  ng("お写真ありがとうございます。担当医が確認いたします。", "改めてお写真をお送りいただけますと幸いです、ありがとうございます。担当医が確認いたします。");
  ng("キャンセルの際は前日までにご連絡ください。", "キャンセルの際は、できれば前日までにご連絡くださいませ。");
  ng("ご来院の際は保険証をお持ちください。", "ご来院の際は、よろしければ保険証をお持ちくださいませ。");
  ng("施術後24時間は飲酒をお控えください。", "施術後24時間は、なるべく飲酒をお控えくださいませ。");
  ng("ご来院の際は保険証をお持ちください。", "よろしければ、ご来院の際は保険証をお持ちくださいませ。");
  ng("キャンセルの際は前日までにご連絡ください。", "できれば、キャンセルの際は前日までにご連絡くださいませ。");
  ng("施術後24時間は飲酒をお控えください。", "なるべく、施術後24時間は飲酒をお控えくださいませ。");
  ng("キャンセルの際は前日までにご連絡ください。", "キャンセルの際は前日までにご連絡ください、できれば。");
  ok("キャンセルの際は前日までにご連絡ください。", "恐れ入りますが、キャンセルの際は前日までにご連絡くださいませ。");
  ok("お写真ありがとうございます。担当医が確認いたします。", "お写真をお送りいただき、誠にありがとうございます。担当医が確認いたします。何かご不明な点がございましたら、お気軽にお問い合わせください。");
});

test("途中で切れた出力から救出した案は、文体だけの指示でも照合を省かない", () => {
  const run = section("async function runDraftChat(", "function staffAppointmentById(");
  assert.match(run, /if \(out\.format === "salvaged" \|\| out\.format === "plain"\) p\.styleFastPath = false;/);
});
