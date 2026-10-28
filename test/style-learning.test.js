"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const style = require("../lib/style-learning");
const { textSimilarity } = require("../lib/learning-retrieval");
const { PATIENT_COURTESY, hasConversationalTone, normalizeReplyTone, replyToneInstruction, staffRequestsConversationalTone, toneRewriteInstruction } = require("../lib/reply-tone");

test("文体の学びは書き方だけを受け付け、患者情報・事実・医療の内容は捨てる", () => {
  for (const ok of [
    "締めの「ご不明点がございましたら」は付けない",
    "「させていただきます」は「いたします」にする",
    "LINEは3文以内にまとめる",
    "結論を最初の一文に書く",
  ]) assert.equal(style.acceptableStyleLesson(ok), ok.normalize("NFKC"), ok);
  for (const ng of [
    "10月3日の予約は確認済みと書く",
    "キャンセル料は無料と案内する",
    "料金は先に伝える",
    "03-1234-5678へ電話するよう書く",
    "test@example.com を案内する",
    "痛みは大丈夫ですと伝える",
    "金曜日は休みと書く",
    "短い",
    "あ".repeat(81),
  ]) assert.equal(style.acceptableStyleLesson(ng), "", ng);
  // 会話に出た氏名を含む学びは使わない。
  assert.equal(style.acceptableStyleLesson("冒頭で山田に呼びかけない", ["山田様、ご連絡ありがとうございます。"]), "");
});

test("同じ直しは1件にまとめて回数を数え、2回目から下書きへ反映する", () => {
  const config = {};
  let seq = 0; const id = () => "sl-test-" + (++seq);
  const first = style.mergeStyleLessons(config, ["締めのあいさつは一文だけにする"], 1000, id);
  assert.equal(first.added.length, 1);
  assert.equal(style.styleLessonsPromptBlock(config), "", "1回だけの直しは候補に留める");
  // 同じ送信から言い換えで2件出ても、回数は1回分だけ足す。
  const second = style.mergeStyleLessons(config, ["締めのあいさつは一文だけにする", "締めのあいさつは一文だけにします"], 2000, id);
  assert.equal(second.reinforced.length, 1);
  const list = style.styleLessonList(config);
  assert.equal(list.length, 1);
  assert.equal(list[0].count, 2);
  assert.equal(list[0].lastSeen, 2000);
  assert.ok(style.styleLessonActive(list[0]));
  const block = style.styleLessonsPromptBlock(config);
  assert.match(block, /スタッフの直し方から学んだ文体/);
  assert.match(block, /・締めのあいさつは一文だけにする/);
  assert.match(block, /店舗ルール・確認済み情報・料金・可否・安全上の制約・患者様への礼儀は変えない/);
  // 停止したものは使わない。スタッフが確認したものは1回でも使う。
  list[0].disabled = true;
  assert.equal(style.styleLessonsPromptBlock(config), "");
  style.mergeStyleLessons(config, ["箇条書きは使わず文章でまとめる"], 3000, id);
  const confirmed = style.styleLessonList(config).find(item => item.text.startsWith("箇条書き"));
  confirmed.edited = true;
  assert.match(style.styleLessonsPromptBlock(config), /箇条書きは使わず/);
  assert.doesNotMatch(style.styleLessonsPromptBlock(config), /締めのあいさつ/);
});

test("上限を超えたら、反映中のものは残して古い候補から外す", () => {
  const config = { styleLessons: [] };
  const words = ["あいさつ", "結論", "改行", "謝意", "締め", "敬語", "箇条書き", "語尾", "前置き", "繰り返し"];
  const active = { id: "keep", text: "冒頭の定型あいさつを省く", count: 5, firstSeen: 1, lastSeen: 1, disabled: false, edited: false };
  config.styleLessons.push(active);
  let n = 0;
  for (let i = 0; i < style.STYLE_LESSON_MAX + 5; i++) {
    const text = "候補" + "あいうえおかきくけこさしすせそたちつてと".charAt(i % 20) + "の" + words[i % 10] + "を" + "なにぬねのはひふへほまみむめもやゆよらり".charAt(Math.floor(i / 20) % 20) + "整える";
    style.mergeStyleLessons(config, [text], 100 + i, () => "sl-" + (++n));
  }
  const list = style.styleLessonList(config);
  assert.ok(list.length <= style.STYLE_LESSON_MAX);
  assert.ok(list.some(item => item.id === "keep"), "反映中の学びは件数整理で消さない");
});

test("AI応答の形が崩れていれば何も学ばない", () => {
  assert.deepEqual(style.parseStyleLessonResponse(null), []);
  assert.deepEqual(style.parseStyleLessonResponse("学びはありません"), []);
  assert.deepEqual(style.parseStyleLessonResponse("{\"lessons\":\"x\"}"), []);
  assert.deepEqual(style.parseStyleLessonResponse("{\"lessons\":[{\"text\":\"結論を先に書く\"},\"改行を減らす\",{},1,2,3]}"), ["結論を先に書く", "改行を減らす"]);
});

test("AI案のない手書き返信や、ほぼ同じ文は文体学習の対象にしない", () => {
  assert.equal(style.styleEditWorthLearning("", "ご連絡ありがとうございます。確認してご案内いたします。"), false);
  assert.equal(style.styleEditWorthLearning("同じ文です。よろしくお願いいたします。", "同じ文です。よろしくお願いいたします。"), false);
  assert.equal(style.styleEditWorthLearning("ご連絡いただきまして誠にありがとうございます。ご予約の件、確認させていただきます。", "ご連絡ありがとうございます。ご予約を確認いたします。"), true);
  assert.ok(textSimilarity("a", "a") === 1);
});

test("文体学習の指示は事実・患者情報を学ばないよう明示する", () => {
  assert.match(style.STYLE_LESSON_SYSTEM, /料金・可否・予約・日時・医療の内容/);
  assert.match(style.STYLE_LESSON_SYSTEM, /空配列/);
  const prompt = JSON.parse(style.styleLessonUserPrompt({ draft0: "a".repeat(3000), final: "b", instr: "短く", channel: "line" }));
  assert.equal(prompt.before.length, 1800);
  assert.equal(prompt.staffInstruction, "短く");
});

test("スタッフが口調を明示した時だけ、くだけた表現を許す", () => {
  for (const yes of ["もっとフランクに", "堅苦しくなくして", "「気になりますよね」って入れて", "よねを付けて", "親しみやすく書いて", "カジュアルにお願い"]) assert.equal(staffRequestsConversationalTone(yes), true, yes);
  for (const no of ["これ違うよね？直して", "短くして", "丁寧に", "", "料金も入れてね"]) assert.equal(staffRequestsConversationalTone(no), false, no);
});

test("患者向け文体の指示は1回だけ入れられる", () => {
  const withCourtesy = replyToneInstruction("落ち着いた文体で");
  const without = replyToneInstruction("落ち着いた文体で", 1200, { includeCourtesy: false });
  assert.ok(withCourtesy.includes(PATIENT_COURTESY));
  assert.equal(without.includes(PATIENT_COURTESY), false);
  assert.match(without, /落ち着いた文体で/);
  assert.equal(toneRewriteInstruction("落ち着いた文体で", "line", { includeCourtesy: false }).includes(PATIENT_COURTESY), false);
  const source = fs.readFileSync(path.join(__dirname, "..", "migiude.js"), "utf8");
  const start = source.indexOf("async function genDraft(t, c, opts)");
  const body = source.slice(start, source.indexOf("// 毎回承認モード", start));
  assert.match(body, /JP_QUALITY/);
  assert.doesNotMatch(body, /replyToneInstruction\(S\(t\)\.tone\)(?!,)/, "JP_QUALITYと二重に入れない");
});

function qualityFunctions(aiReply, options) {
  const source = fs.readFileSync(path.join(__dirname, "..", "migiude.js"), "utf8");
  const start = source.indexOf("function cleanDraftText(raw){");
  const end = source.indexOf("// 出力が途中で切れる", start);
  const calls = [];
  const fns = vm.runInNewContext(source.slice(start, end) + "\n({finalizeGeneratedDraft,validateDraftAgainstEvidence})", {
    S: () => ({ tone: (options && options.tone) || "" }), aiChat: async (_t, sys, msgs) => { calls.push({ sys, msgs }); return typeof aiReply === "function" ? aiReply(sys) : aiReply; },
    PATIENT_COURTESY, hasConversationalTone, normalizeReplyTone, replyToneInstruction, toneRewriteInstruction,
    styleLessonsBlock: () => (options && options.lessons) || "",
  });
  return { ...fns, calls };
}

test("スタッフが口調を指定した編集では、校正で親しみのある表現を消さない", async () => {
  const casual = "ホワイトニング、気になりますよね。当日の状態を見てご案内いたします。";
  const kept = await qualityFunctions("ホワイトニングについて、当日の状態を見てご案内いたします。").finalizeGeneratedDraft({}, casual, "line", { allowConversational: true });
  assert.equal(kept.text, casual, "口語だけが理由なら校正しない");
  assert.equal(kept.issues.includes("conversational_tone"), false);
  const withTone = qualityFunctions("ホワイトニング、気になりますよね。当日の状態を拝見してご案内いたします。", { tone: "やわらかく" });
  const toned = await withTone.finalizeGeneratedDraft({}, casual, "line", { allowConversational: true });
  assert.match(toned.text, /気になりますよね/);
  assert.match(withTone.calls[0].sys, /スタッフが求めた親しみのある表現は残す/);
  // 既定（自動生成）では従来どおり口語を残さない。
  const normal = await qualityFunctions("ホワイトニングについて、当日の状態を見てご案内いたします。").finalizeGeneratedDraft({}, casual, "line");
  assert.doesNotMatch(normal.text, /よね/);
});

test("学んだ文体は校正と送信前監査にも渡り、捨てた監査修正文は理由を残す", async () => {
  const lessons = "【スタッフの直し方から学んだ文体（スタッフが実際に繰り返し直した点）】\n・結論を先に書く";
  const q = qualityFunctions(sys => /送信前監査/.test(sys)
    ? JSON.stringify({ pass: true, answered: true, natural: false, revised_draft: "ご予約、確認しておきますね。気になりますよね。", unsupported_claims: [], contradictions: [], reason: "" })
    : "ご予約を確認いたします。", { tone: "丁寧に", lessons });
  await q.finalizeGeneratedDraft({}, "ご予約を確認させていただきます。", "line");
  assert.match(q.calls[0].sys, /結論を先に書く/);
  assert.match(q.calls[0].sys, /校正でもこの文体を崩さない/);
  const result = await q.validateDraftAgainstEvidence({}, { query: "予約の確認", draft: "ご予約を確認いたします。" });
  assert.match(q.calls[1].sys, /監査で文章を修正する場合も、この文体を崩さない/);
  assert.equal(result.discardedRewrite, "conversational_tone");
  assert.equal(result.revisedDraft, "");
  const factQ = qualityFunctions(JSON.stringify({ pass: true, answered: true, revised_draft: "10月4日のご予約を確認いたします。", unsupported_claims: [], contradictions: [] }));
  const factResult = await factQ.validateDraftAgainstEvidence({}, { query: "予約", draft: "10月3日のご予約を確認いたします。" });
  assert.equal(factResult.discardedRewrite, "fact_changed");
  const cleanQ = qualityFunctions(JSON.stringify({ pass: true, answered: true, revised_draft: "", unsupported_claims: [], contradictions: [] }));
  assert.equal((await cleanQ.validateDraftAgainstEvidence({}, { query: "予約", draft: "ご予約を確認いたします。" })).discardedRewrite, "");
});

test("送信後の学習でスタッフの直し方を抜き出し、患者情報を含む学びは保存しない", async () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "migiude.js"), "utf8");
  const start = source.indexOf("async function learnStyleFromStaffEdit(t, input)");
  const end = source.indexOf("const runningLearningJobs", start);
  assert.ok(start > 0 && end > start);
  let reply = "", aiCalls = 0;
  const ctx = {
    ...style, crypto: require("crypto"),
    aiChat: async (_t, sys, msgs, max, route) => { aiCalls++; assert.equal(route, "learning"); assert.equal(sys, style.STYLE_LESSON_SYSTEM); JSON.parse(msgs[0].content); return reply; },
  };
  const { learnStyleFromStaffEdit } = vm.runInNewContext(source.slice(start, end) + "\n({learnStyleFromStaffEdit})", ctx);
  const t = { config: {} };
  const input = { q: "佐藤様の予約について", draft0: "佐藤様、ご連絡いただきまして誠にありがとうございます。ご予約の件、確認させていただきます。", final: "ご連絡ありがとうございます。ご予約を確認いたします。", instr: "", channel: "line" };
  reply = JSON.stringify({ lessons: [{ text: "冒頭で佐藤に呼びかけない" }, { text: "「させていただきます」は「いたします」にする" }, { text: "料金は最初に書く" }] });
  const first = await learnStyleFromStaffEdit(t, input);
  assert.deepEqual(first.added.map(item => item.text), ["「させていただきます」は「いたします」にする"]);
  const second = await learnStyleFromStaffEdit(t, input);
  assert.equal(second.reinforced.length, 1);
  assert.ok(style.styleLessonActive(second.reinforced[0]));
  // 直していない送信やAI案のない返信ではAIを呼ばない。
  const before = aiCalls;
  await learnStyleFromStaffEdit(t, { ...input, final: input.draft0 });
  await learnStyleFromStaffEdit(t, { ...input, draft0: "" });
  assert.equal(aiCalls, before);
  reply = "壊れた応答";
  assert.equal(JSON.stringify(await learnStyleFromStaffEdit({ config: {} }, input)), JSON.stringify({ added: [], reinforced: [] }));
});

test("学習処理は文体学習の失敗で判断メモリの学習結果を変えない", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "migiude.js"), "utf8");
  const start = source.indexOf("async function processLearningJob(t, jobId)");
  const body = source.slice(start, source.indexOf("async function queueStaffLearning", start));
  assert.match(body, /try \{ styleResult = await learnStyleFromStaffEdit/);
  assert.match(body, /catch \(e\) \{ console\.error\("style learning:"/);
  assert.match(body, /if \(p\.changed\)/);
});
