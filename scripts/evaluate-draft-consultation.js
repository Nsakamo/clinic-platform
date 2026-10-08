"use strict";
// Opt-in real-model evaluation of the actual JSON and compatibility handlers.
// Synthetic patients/rules only. No DB, delivery, booking or learning transport.
const fs = require("node:fs");
const vm = require("node:vm");
const assert = require("node:assert/strict");
const tone = require("../lib/reply-tone");
const decision = require("../lib/reply-decision");
const edits = require("../lib/draft-edit");
const consultation = require("../lib/draft-consultation");
const { selectConversationContext } = require("../lib/conversation-context");
const { resolveAiRoute } = require("../lib/ai-model-router");
const source = fs.readFileSync(require.resolve("../migiude.js"), "utf8");
// Reject positive submission requests, not a correct sentence such as
// 「書類をご提出いただく必要はございません」.
const DOCUMENT_REQUEST = /(?:書類|診断書|証明書)[^。\n]{0,40}(?:提出してください|ご提出ください|提出をお願い|お送りください|送ってください|提出いただけます|提出いただく必要がございます|提出が必要です)/;
function section(start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  assert.ok(a > 0 && b > a); return source.slice(a, b);
}
function createHarness() {
  const routes = {}, calls = [];
  const rules = [
    { id: 1, title: "テスト：キャンセル規定", content: "当日キャンセル料は3,300円。感染症の場合、予約当日の受診日・氏名・病院名が確認できる証明書を、この案内から12時間以内に提出した場合は免除対象。書類はスタッフが確認する。" },
    { id: 2, title: "テスト：キレイパス", content: "当日キャンセル時はチケット消化、または3,300円の支払いでチケットを残す、どちらか一方です。" },
    { id: 3, title: "テスト：医院所在地", content: "銀座本院：東京都中央区銀座1-5-1 Holon Ginza2 703号室。THE DENTE：東京都中央区銀座2-2-19 藤間ビル9階。" },
  ];
  const ctx = {
    ...tone, ...decision, ...edits, ...consultation, selectConversationContext, process, fetch,
    S: t => t.config.settings,
    rulesRankedWithScores: () => rules.map(r => ({ r, n: 1 })),
    rulesBlock: list => list.map(r => r.title + ": " + r.content).join("\n"),
    notesBlock: () => "", prefsBlock: () => "", staffBookingPrompt: () => "",
    PARTNER_KEY: "", ANTHROPIC_KEY: "", baEnabled: () => false,
    dbSave: async () => true, guard: () => {}, oneMutationAtATime: () => () => {},
    app: { get: () => {}, post: (path, ...handlers) => { routes[path] = handlers.at(-1); } },
  };
  vm.createContext(ctx);
  vm.runInContext(section("async function aiChatOne(", "async function aiChat("), ctx);
  ctx.aiChat = async (t, sys, messages, limit, task) => {
    const route = resolveAiRoute(t.config.settings, task);
    const out = await ctx.aiChatOne("gpt", sys, messages, limit, route);
    if (!out.text) throw new Error("empty model output");
    calls.push({ task, model: route.model, output: out.text }); return out.text;
  };
  vm.runInContext(section("const JP_QUALITY = ", "// 出力が途中で切れる"), ctx);
  vm.runInContext(section("function salvageDraft(", "// ===== 受付くん連携: 受信イベント転送"), ctx);
  vm.runInContext(section("async function draftChatPrep(", "function staffAppointmentById("), ctx);
  return {
    calls,
    async run(t, c, messages, stream = false) {
      t.store[c.id] = c;
      let json, full = "";
      const res = { json: out => { json = out; }, setHeader: () => {}, write: text => { full += text; }, status: () => res, end: () => {} };
      await routes[stream ? "/api/draft-chat-stream" : "/api/draft-chat"]({ tenant: t, body: { id: c.id, messages } }, res);
      if (stream) {
        const meta = full.match(/@@META@@(.*)$/s);
        assert.ok(meta, "stream must include meta");
        const result = JSON.parse(meta[1]);
        if (!result.ok) console.error(JSON.stringify({ syntheticAudit: calls.filter(c => c.task === "audit").slice(-3).map(c => c.output) }));
        assert.equal(result.ok, true, result.error);
        const match = full.match(/@@DRAFT@@\s*([\s\S]*?)(?=\n@@(?:MEMORY|RULE|ACTION|META)@@|$)/);
        return { draft: match ? match[1].trim() : "", raw: full };
      }
      if (!json.ok) console.error(JSON.stringify({ syntheticAudit: calls.filter(c => c.task === "audit").slice(-3).map(c => c.output) }));
      assert.equal(json.ok, true, json.error); return json;
    },
  };
}

async function main() {
  if (!process.env.OPENAI_KEY) throw new Error("OpenAI not configured");
  const h = createHarness();
  const t = { name: "テストクリニック", store: {}, config: { settings: { engine: "gpt", tone: "丁寧に寄り添い、不要な説明は追加しない" } } };
  const now = Date.now();
  const patient = (id, text) => ({ id: "テスト：" + id, channel: "line", ts: now, msgs: [{ from: "them", text: "テスト：" + text, sentAt: now, at: now }] });
  let count = 0;
  async function run(name, c, history, check, stream = false) {
    const out = await h.run(t, c, history, stream);
    try { check(out); } catch (error) { console.error(JSON.stringify({ case: name, output: out, pass: false })); throw error; }
    count++;
    console.log(JSON.stringify({ case: name, draft: out.draft, pass: true })); return out;
  }
  const fee = patient("特例", "予約確定の連絡を待っていたのですが、キャンセル料を払わないといけませんか？");
  const history = [{ role: "assistant", kind: "draft", content: "当日キャンセル料3,300円をお支払いください。" }, { role: "user", content: "ごめん、こちらの確認不足だから今回は請求しない。先ほどの請求は放念してもらって。病院の書類も求めない。" }];
  const waived = await run("staff-exception-over-rule", fee, history, out => {
    assert.match(out.draft, /(?:お支払い|支払う|キャンセル料).{0,25}(?:不要|必要.{0,5}(?:ない|ございません|ありません)|発生.{0,5}(?:しません|いたしません)|かかりません|いただきません|いただく必要はございません)|請求.{0,10}(?:いたしません|しません)/);
    assert.doesNotMatch(out.draft, DOCUMENT_REQUEST);
    assert.doesNotMatch(out.draft, /3,300円.{0,10}お支払いください/);
  });
  history.push({ role: "assistant", content: waived.draft, kind: "draft" }, { role: "user", content: "もっと短く、でも謝罪は残して" });
  await run("preserve-exception-after-style-edit", fee, history, out => {
    assert.match(out.draft, /申し訳|お詫び/);
    assert.doesNotMatch(out.draft, DOCUMENT_REQUEST);
    assert.doesNotMatch(out.draft, /お支払いください/);
  }, true);
  const booking = patient("訂正", "銀座歯科で10月24日の10時半から予約したいです。");
  const bookingHistory = [{ role: "assistant", kind: "draft", content: "THE DENTEで10月24日10:30に予約いたします。" }, { role: "user", content: "違う、銀座本院。denteじゃない。2026年10月24日10時15分から予約取った。30分は空いてない。住所も書いて。" }];
  const corrected = await run("clinic-and-time-correction", booking, bookingHistory, out => {
    assert.match(out.draft, /銀座本院/); assert.match(out.draft, /10[:：]15|10時15分/);
    assert.match(out.draft, /Holon Ginza2/); assert.doesNotMatch(out.draft, /藤間ビル/);
    assert.doesNotMatch(out.draft, /10[:：]30(?:から|にて|で).{0,15}(?:確定|承り|予約)/);
  });
  bookingHistory.push({ role: "assistant", kind: "draft", content: corrected.draft }, { role: "user", content: "もっと丁寧に" });
  await run("preserve-correction-after-style-edit", booking, bookingHistory, out => {
    assert.match(out.draft, /銀座本院/); assert.match(out.draft, /10[:：]15|10時15分/); assert.doesNotMatch(out.draft, /藤間ビル/);
  }, true);
  const choice = patient("二択", "支払済みの3,800円とは別に3,300円を払う必要があるのでしょうか？チケットはどうなりますか？");
  choice.msgs.unshift({ from: "us", text: "当日キャンセルはチケット消化か3,300円で維持です。", at: now - 1000, sentAt: now - 1000 }); choice.handledThroughIndex = 1;
  await run("answer-patient-both-questions", choice, [{ role: "user", content: "どちらかだよ。チケット消化か、3300円を払えばチケットは残ると丁寧に伝えて" }], out => {
    assert.match(out.draft, /どちら|いずれか|一方|選択|お選び/); assert.match(out.draft, /3[,，]?300/);
    assert.match(out.draft, /チケット.{0,35}(?:残|消化せず|消化されず|利用いただけ|保持|有効|未消化)/);
  });
  const revoke = history.concat([{ role: "assistant", kind: "draft", content: "今回はキャンセル料は不要です。" }, { role: "user", content: "やっぱり今回は特例なしに変更して、通常の3300円がかかると伝えて。謝罪は残して。" }]);
  await run("latest-reversal-wins", fee, revoke, out => { assert.match(out.draft, /3[,，]?300/); assert.doesNotMatch(out.draft, /お支払い.{0,8}不要|キャンセル料.{0,8}不要/); });
  await run("consultation-does-not-rewrite", fee, [{ role: "assistant", kind: "draft", content: waived.draft }, { role: "user", content: "通常のキャンセル料はいくらだっけ？" }], out => { assert.equal(out.draft, ""); assert.match(out.reply, /3[,，]?300/); });
  const long = [{ role: "user", content: "今回は無料。書類は不要にして" }];
  for (let i = 0; i < 8; i++) long.push({ role: "assistant", kind: "draft", content: "今回はキャンセル料は不要です。" }, { role: "user", content: "より丁寧に" });
  long.push({ role: "user", content: "前の判断を維持。" + "患者さんに丁寧に。".repeat(180) + "最後に当院側の不備への謝罪も書いて。" });
  await run("long-consultation-preserves-earlier-decision", fee, long, out => { assert.match(out.draft, /申し訳|お詫び/); assert.doesNotMatch(out.draft, /お支払いください/); assert.doesNotMatch(out.draft, DOCUMENT_REQUEST); });
  console.log(JSON.stringify({ result: "PASS", cases: count, calls: h.calls.length, models: [...new Set(h.calls.map(c => c.model))] }));
}
if (require.main === module) main().catch(error => { console.error("Synthetic consultation evaluation failed:", String(error.message).slice(0, 300)); process.exitCode = 1; });
module.exports = { createHarness };
