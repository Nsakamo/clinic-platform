"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const decision = require("../lib/reply-decision");
const { selectConversationContext, preserveTopicBoundary } = require("../lib/conversation-context");
const { explicitEditMismatch, normalizeDraftEditHistory, isDraftChatConsultation } = require("../lib/draft-edit");
const { evaluateResponseGrounding } = require("../lib/response-grounding");
const source = fs.readFileSync(require.resolve("../migiude.js"), "utf8");
const rules = "感染症による変更は、予約前日の受診日・予約者名・病院名のある証明書を12時間以内に提出した場合のみ免除対象。条件を満たさない当日変更は3,300円。";
const query = "テスト：インフルになり、本日11時の予約に行けません。日付を変更したいです。";

test("感染症の変更理由から免除・証明書ルールも取得し、インフルエンサーは誤検出しない", () => {
  assert.match(decision.replyRuleQuery(query), /受診証明/);
  assert.match(decision.replyRuleQuery("診断書のルールを使って伝えて"), /キャンセル.*免除/);
  assert.equal(decision.replyRuleQuery("インフルエンサーの来院予約を変更したい"), "インフルエンサーの来院予約を変更したい");
  assert.equal(decision.needsCancellationPolicyReview(query, rules), true);
  assert.equal(decision.needsCancellationPolicyReview("テスト：ご来院ありがとうございます", rules), false);
  assert.equal(decision.needsCancellationPolicyReview(query, "免除規定なし"), false);
  for (const unrelated of ["テスト：受診証明書を発行してもらえますか", "テスト：診断書の発行方法を教えてください", "テスト：インフルエンザの予防について教えてください", "テスト：インフルエンザの治癒証明書をお願いします"]) {
    assert.equal(decision.needsCancellationPolicyReview(unrelated, rules), false, unrelated);
  }
  assert.equal(decision.needsCancellationPolicyReview(query + " 証明書の写真を提出しました", rules), true);
});

test("患者連絡の実際の日付をJSTで渡し、時刻だけの旧履歴には日付を補わない", () => {
  const text = decision.replyMessageText({ from: "them", text: query, sentAt: Date.parse("2026-10-02T23:54:00Z"), at: Date.parse("2026-10-02T23:54:00Z") });
  assert.match(text, /2026\/10\/3.*8:54:00/);
  assert.match(text, /本日11時/);
  assert.equal(decision.replyMessageText({ text: query, time: "09:54" }), query);
  assert.match(decision.replyMessageText({ text: query, at: Date.parse("2026-10-02T23:54:00Z") }), /受信記録日時（送信日時は不明）/);
  assert.match(decision.REPLY_DECISION, /別の月の次回予約/);
  assert.match(decision.REPLY_DECISION, /連絡を送った日時を基準/);
});

test("丁寧な欠席表現・発熱も証明書発行だけと誤判定せず、学校の発行依頼は分ける", () => {
  for (const text of [
    "テスト：インフルエンザで明日伺うことができません。証明書は必要ですか",
    "テスト：インフルになり明日はお休みさせてください。診断書いりますか",
    "テスト：発熱があり明日伺えません。診断書は必要でしょうか",
    "テスト：インフルで明日来院することができません。",
    "テスト：インフルエンザで来られません。",
    "テスト：インフルエンザで出勤停止になり、明日伺えません。証明書は必要ですか",
    "テスト：コロナで会社も休んでいます。明日の分はキャンセルでお願いします。診断書は要りますか",
    "テスト：インフルエンザなので別の日に変更したいです。診断書は必要ですか",
    "テスト：インフルで明日の予約を取り消したいです。証明書いりますか",
    "テスト：発熱で明日は受診できません",
    "テスト：インフルで明日は休ませてください",
    "テスト：インフルで予定を変更し、振り替えたいです",
  ]) {
    assert.equal(decision.isCancellationInquiry(text), true, text);
    assert.equal(decision.needsCancellationPolicyReview(text, rules), true, text);
    assert.match(decision.replyRuleQuery(text), /受診証明/, text);
  }
  const school = "テスト：インフルエンザで学校をお休みするので治癒証明書をお願いします";
  assert.equal(decision.isCancellationInquiry(school), false);
  assert.equal(decision.needsCancellationPolicyReview(school, rules), false);
  assert.equal(decision.isCancellationInquiry("テスト：発熱していますが伺えますか"), false);
});

test("旧返信に送信日時がなくても話題だけを区切り、仮の活動日時を返信資料へ漏らさない", () => {
  const before = Date.parse("2026-10-01T00:00:00Z");
  const old = { from: "us", text: "テスト：前の返信です", time: "09:00" };
  const c = { ts: before, msgs: [{ from: "them", text: query }, old] };
  preserveTopicBoundary(c);
  assert.equal(old.topicActivityAt, before);
  assert.equal(old.at, undefined);
  assert.equal(old.sentAt, undefined);
  assert.equal(decision.replyMessageText(old), old.text);
  c.msgs.push({ from: "them", text: "テスト：営業時間について", sentAt: before + 86400000 });
  c.ts = before + 86400000;
  assert.deepEqual(selectConversationContext(c).current.map(m => m.text), ["テスト：営業時間について"]);
  assert.match(source, /preserveTopicBoundary\(c\);\s*c\.msgs\.push/);
});

test("日付を跨ぐ遅延処理でも送信日時を保存し、欠落・未来日時や旧履歴の日時を捏造しない", async () => {
  const sentAt = Date.parse("2026-10-02T14:59:00Z"), receivedAt = Date.parse("2026-10-02T15:05:00Z");
  const times = decision.inboundMessageTimes(sentAt, receivedAt);
  assert.deepEqual(times, { at: sentAt, sentAt, receivedAt });
  assert.match(decision.replyMessageText({ ...times, text: "テスト：本日の予約を変更したいです" }), /送信日時.*2026\/10\/2.*23:59/);
  for (const invalid of [undefined, "不正", -1, receivedAt + 86400000]) {
    assert.deepEqual(decision.inboundMessageTimes(invalid, receivedAt), { at: receivedAt, receivedAt });
  }
  const start = source.indexOf("async function processQueuedLinePayload(");
  const end = source.indexOf("let lineWebhookQueueRunning", start);
  let received;
  const context = { isProcessableLineEvent: () => true, lineProfile: async () => ({ name: "テスト患者" }), handleInbound: async (_t, opts) => { received = opts; } };
  vm.runInNewContext(source.slice(start, end), context);
  await context.processQueuedLinePayload({}, { token: "テスト", botId: "テスト" }, { source: { userId: "テスト" }, timestamp: sentAt, message: { type: "text", text: "テスト：本日の予約を変更したいです" } });
  assert.equal(received.sentAt, sentAt);
  assert.match(source, /sentAt: parsed\.date \? mdate : undefined/);
  const mail = decision.inboundMessageTimes(sentAt, receivedAt, "mail_header");
  assert.equal(mail.at, receivedAt);
  assert.match(decision.replyMessageText({ ...mail, text: query }), /メール記載日時.*料金適用日は要確認/);
  const inbound = source.slice(source.indexOf("async function handleInboundCore("), source.indexOf("// ===== 予約自動受付: 確認待ち"));
  assert.match(inbound, /inboundMessageTimes\(opts\.sentAt, recvAt, opts\.sentAtSource\)/);
  assert.doesNotMatch(inbound, /previousMessage\.at\s*=/);
});

test("証明書発行案の無関係な免除案内を内容監査で修正する", async () => {
  const corrected = "受診証明書の発行についてスタッフが確認し、ご案内いたします。";
  const h = reviewHarness(['{"pass":false,"reason":"無関係なキャンセル案内"}', corrected, '{"pass":true}']);
  const p = { c: { channel: "line" }, lastQ: "テスト：受診証明書を発行してもらえますか", latestInstruction: "証明書の発行についてだけ回答して", evidence: rules };
  const result = await h.review({}, p, "証明書を確認します。感染症のキャンセル料は条件を満たせば免除されます。");
  assert.equal(result.text, corrected);
  assert.equal(h.calls.length, 3);
  assert.match(h.calls[0].sys, /無関係な規定や予約を持ち出す/);
});

function reviewHarness(responses) {
  const calls = [];
  const finalizations = [];
  const start = source.indexOf("async function reviewDraftChatCandidate(");
  const end = source.indexOf('app.post("/api/draft-chat"', start);
  const context = {
    ...decision, explicitEditMismatch,
    finalizeGeneratedDraft: async (_t, text) => { finalizations.push(text); return { text, issues: [] }; },
    hasConversationalTone: () => false, PATIENT_COURTESY: "丁寧に",
    aiChat: async (_t, sys, messages, _limit, task) => { calls.push({ sys, messages, task }); return responses.shift(); },
  };
  vm.runInNewContext(source.slice(start, end), context);
  return { review: context.reviewDraftChatCandidate, calls, finalizations };
}

test("既に整形した初回案を二重整形せず、修正で落ちた注意書きは二回目で回復できる", async () => {
  const correct = "証明書はこの案内から12時間以内に提出してください。前日キャンセルの金額は確認のうえ案内します。";
  const h = reviewHarness([
    '{"pass":false,"reason":"患者送信時刻から締切を計算している"}',
    "証明書はこの案内から12時間以内に提出してください。",
    '{"pass":false,"reason":"金額の確認待ちが落ちた"}',
    correct, '{"pass":true}',
  ]);
  const out = await h.review({}, { c: { channel: "line" }, lastQ: query, latestInstruction: "規定を案内", alreadyFinalized: true, evidence: rules }, "証明書は23時までです。金額は確認します。");
  assert.equal(out.text, correct);
  assert.equal(h.calls.length, 5);
  assert.equal(h.finalizations.length, 2);
  assert.match(h.calls[3].messages[0].content, /金額の確認待ちが落ちた/);
  assert.match(h.calls[3].sys, /指摘されていない正しい条件・未確定事項の説明を落とさない/);
});

test("二回修復しても照合できない案は採用せず、修復回数は上限を守る", async () => {
  const h = reviewHarness(['{"pass":false}', "誤案1", '{"pass":false}', "誤案2", '{"pass":false}']);
  const out = await h.review({}, { c: { channel: "line" }, lastQ: query, latestInstruction: "規定を案内", evidence: rules }, "誤案0");
  assert.equal(out.text, "");
  assert.ok(out.error);
  assert.equal(h.calls.length, 5);
});

test("料金と提出期限の起点は推測で補わず、相対表現と金額確認を維持する", () => {
  assert.match(decision.REPLY_DECISION, /患者の送信時刻から具体的な締切時刻を計算しない/);
  assert.match(decision.REPLY_DECISION, /金額は確認のうえ案内する/);
  assert.match(decision.REPLY_DECISION, /単にスタッフが証明書を確認すると書くだけでは料金確認の説明にならない/);
});

test("証明書提出後は案内済みの条件の再掲を必須にせず、選択対象とスタッフ指示を照合する", async () => {
  const text = "証明書をご提出いただきありがとうございます。スタッフが内容を確認し、ご案内いたします。";
  const h = reviewHarness(['{"pass":true}']);
  const result = await h.review({}, {
    c: { channel: "line" }, lastQ: "証明書の写真を提出しました", latestInstruction: "受領と確認待ちを伝えて",
    selectedTopics: ["証明書の受領"], evidence: rules + "\nスタッフ共通指示：簡潔に\n対応メモ：メール連絡希望\n確認済み空き枠：10月6日11時\n店舗返信：条件と3,300円を案内済み",
  }, text);
  assert.equal(result.text, text);
  assert.match(h.calls[0].sys, /患者へ既に伝えた条件・料金の再掲は合格条件ではない/);
  assert.match(h.calls[0].messages[0].content, /選ばれていない項目は補わない/);
  for (const value of ["簡潔に", "メール連絡希望", "10月6日11時", "証明書の受領"]) assert.ok(h.calls[0].messages[0].content.includes(value));
});

test("通常の治療予約の変更を感染症・証明書専用ゲートで止めない", async () => {
  const start = source.indexOf("async function genDraft(t, c, opts) {"), end = source.indexOf("// 毎回承認モード", start);
  const context = {
    ...decision, activeConversationMessages: c => c.msgs, S: () => ({ tone: "", prefs: [] }),
    rulesRankedWithScores: () => [{ r: { content: rules }, n: 3, score: 0.5 }], rulesBlock: () => rules, ruleBudget: () => 16000,
    examplesRanked: () => [], trustedLearningPrecedent: () => false, prefsBlock: () => "", notesBlock: () => "", replyToneInstruction: () => "",
    JP_QUALITY: "", PATIENT_COURTESY: "", baEnabled: () => false, staffLineReviewAll: () => false, PARTNER_KEY: "",
    aiChat: async () => JSON.stringify({ draft: "ご希望の日時をお知らせください。", confidence: "high", needs_human: false, action: { type: "reschedule" } }),
    finalizeGeneratedDraft: async (_t, text) => ({ text, issues: [] }), applyCourtesyGate: () => {},
    reviewDraftChatCandidate: async () => { throw new Error("感染症専用の追加照合は不要"); },
    evaluateResponseGrounding, applyLearningReadinessGate: () => ({}),
  };
  vm.runInNewContext(source.slice(start, end), context);
  const out = await context.genDraft({}, { channel: "line", msgs: [{ from: "them", text: "次回の治療の予約を来週に変更したいです" }] }, { skipExternal: true });
  assert.equal(out.replyRequiresStaff, false);
  assert.equal(out.action.type, "reschedule");
});

test("編集後の照合・修復・再照合に正式ルールを渡し、証明書案内の抜けを修復する", async () => {
  const corrected = "ご連絡ありがとうございます。証明書を12時間以内にご提出いただき、予約前日の受診日・予約者名・病院名が確認できれば免除対象となります。条件を満たさない当日変更は3,300円です。";
  const h = reviewHarness(['{"pass":false,"reason":"証明書の案内がない"}', corrected, '{"pass":true,"reason":"ルールに一致"}']);
  const p = { c: { channel: "line" }, lastQ: query, latestInstruction: "診断書のルールを使って伝えて", evidence: rules + "\n参考の将来予約：11月10日", previousDraft: "11月の予約の空き状況を確認します。" };
  const result = await h.review({}, p, p.previousDraft);
  assert.equal(result.text, corrected);
  assert.equal(result.error, "");
  assert.equal(h.calls.length, 3);
  for (const call of h.calls) {
    assert.match(call.messages[0].content, /予約前日の受診日/);
    assert.match(call.messages[0].content, /3,300円/);
    assert.match(call.sys, /今回のキャンセル対象や料金判断に使わない/);
  }
});

test("照合失敗や修復失敗は旧い案を採用せず、免除や予約操作も実行しない", async () => {
  for (const reply of [null, "壊れたJSON", '{"pass":false,"reason":"証明未確認なのに免除を確定"}']) {
    const h = reviewHarness([reply, null]);
    const result = await h.review({}, { c: { channel: "line" }, lastQ: query, latestInstruction: "診断書の条件を案内して", evidence: rules }, "免除しました。予約を変更しました。");
    assert.equal(result.text, "");
    assert.match(result.error, /正確に反映できません/);
    assert.equal(h.calls.every(c => ["audit", "chat"].includes(c.task)), true);
  }
});

test("編集準備は関連証明書ルールと会話日時を照合資料へ含める", async () => {
  const start = source.indexOf("async function draftChatPrep(");
  const end = source.indexOf('app.get("/api/draft-chat-history"', start);
  const queries = [];
  const context = {
    ...decision, selectConversationContext, normalizeDraftEditHistory, isDraftChatConsultation,
    rulesRankedWithScores: (_t, q) => { queries.push(q); return [{ n: 2, r: { content: rules } }]; },
    rulesBlock: rel => rel.map(r => r.content).join("\n"),
    S: () => ({ engine: "gpt", tone: "" }), notesBlock: () => "", prefsBlock: () => "", replyToneInstruction: () => "",
    baEnabled: () => false, PARTNER_KEY: "", staffBookingPrompt: () => "", ANTHROPIC_KEY: "", process: { env: {} }, JP_QUALITY: "",
  };
  vm.runInNewContext(source.slice(start, end), context);
  const c = { id: "テスト患者", channel: "line", ts: 1, msgs: [{ from: "them", text: query, sentAt: Date.parse("2026-10-03T00:54:00Z"), at: Date.parse("2026-10-03T00:54:00Z") }] };
  const result = await context.draftChatPrep({ store: { [c.id]: c } }, { id: c.id, messages: [{ role: "user", content: "診断書のやつ使って伝えて" }] });
  assert.match(queries[0], /受診証明/);
  assert.match(result.evidence, /12時間以内/);
  assert.match(result.evidence, /送信日時.*2026\/10\/3/);
  assert.match(result.base, /旧下書きの誤りを最新指示より優先しない/);
  assert.equal(result.consultation, false);
});

test("初回生成は人の確認が必要でも免除案内の漏れを照合する", async () => {
  const start = source.indexOf("async function genDraft(t, c, opts) {");
  const end = source.indexOf("// 毎回承認モード", start);
  let reviewed = false, prompt = "";
  const context = {
    ...decision, activeConversationMessages: c => c.msgs,
    S: () => ({ tone: "", prefs: [] }),
    rulesRankedWithScores: () => [{ r: { content: rules }, n: 3, score: 0.5 }], rulesBlock: () => rules, ruleBudget: () => 16000,
    examplesRanked: () => [], trustedLearningPrecedent: () => false, prefsBlock: () => "", notesBlock: () => "", replyToneInstruction: () => "",
    JP_QUALITY: "", PATIENT_COURTESY: "", baEnabled: () => false, staffLineReviewAll: () => false, PARTNER_KEY: "",
    aiChat: async (_t, sys) => { prompt = sys; return JSON.stringify({ draft: "空き状況を確認します。", confidence: "high", needs_human: true }); },
    finalizeGeneratedDraft: async (_t, text) => ({ text, issues: [] }), applyCourtesyGate: () => {},
    reviewDraftChatCandidate: async (_t, p) => { reviewed = true; assert.match(p.evidence, /12時間以内/); return { text: "証明書の条件を確認し、規定を案内します。", error: "" }; },
    evaluateResponseGrounding, applyLearningReadinessGate: () => ({}),
  };
  vm.runInNewContext(source.slice(start, end), context);
  const result = await context.genDraft({}, { channel: "line", msgs: [{ from: "them", text: query, at: Date.parse("2026-10-03T00:54:00Z") }] }, { skipExternal: true });
  assert.equal(reviewed, true);
  assert.equal(result.grounding.autoSendAllowed, false);
  assert.match(prompt, /既知の規定を省略しない/);
});

test("感染症免除は根拠があっても患者申告だけで自動確定・自動送信しない", () => {
  const result = evaluateResponseGrounding({ query, draft: "証明書をご提出ください。", ruleMatches: [{ overlap: 4, score: 0.5 }], verifiedBooking: true });
  assert.equal(result.autoSendAllowed, false);
  assert.match(result.reasons.join(" "), /スタッフ確認/);
});

test("証明書発行だけの問い合わせへ免除案内を強制せず、提出後は古い感染症文脈でもスタッフ確認を維持", async () => {
  const start = source.indexOf("async function genDraft(t, c, opts) {"), end = source.indexOf("// 毎回承認モード", start);
  for (const infection of [false, true]) {
    let reviewed = false;
    const context = {
      ...decision, activeConversationMessages: c => c.msgs, S: () => ({ tone: "", prefs: [] }),
      rulesRankedWithScores: () => [{ r: { content: rules }, n: 3, score: 0.5 }], rulesBlock: () => rules, ruleBudget: () => 16000,
      examplesRanked: () => [], trustedLearningPrecedent: () => false, prefsBlock: () => "", notesBlock: () => "", replyToneInstruction: () => "",
      JP_QUALITY: "", PATIENT_COURTESY: "", baEnabled: () => false, staffLineReviewAll: () => false, PARTNER_KEY: "",
      aiChat: async () => JSON.stringify({ draft: "証明書について確認します。", confidence: "high", needs_human: !infection }),
      finalizeGeneratedDraft: async (_t, text) => ({ text, issues: [] }), applyCourtesyGate: () => {},
      reviewDraftChatCandidate: async (_t, p) => {
        reviewed = true;
        assert.equal(p.forbidCancellationGuidance, undefined);
        assert.match(p.latestInstruction, /今回の依頼だけに回答/);
        assert.match(p.latestInstruction, /言い方が定型でなくても/);
        return { text: "証明書の内容はスタッフが確認します。", error: "" };
      },
      evaluateResponseGrounding, applyLearningReadinessGate: () => ({}),
    };
    vm.runInNewContext(source.slice(start, end), context);
    const msgs = (infection ? [query, "テスト：ありがとうございます", "テスト：分かりました", "テスト：写真を用意します", "テスト：証明書の写真を提出しました"] : ["テスト：受診証明書を発行してもらえますか"])
      .map(text => ({ from: "them", text }));
    const out = await context.genDraft({}, { channel: "line", msgs }, { skipExternal: true });
    assert.equal(reviewed, true);
    if (infection) {
      assert.equal(out.needs_human, true);
      assert.equal(out.grounding.autoSendAllowed, false);
      assert.match(out.grounding.reasons.join(" "), /免除条件・証明書/);
    } else { assert.doesNotMatch(out.draft, /免除|3,300円/); }
  }
});

test("自動返信とスタッフLINE承認も実送信日時を持ち、翌日の別話題を分離する", async () => {
  const start = source.indexOf("async function baDeliver(t, c, text) {"), end = source.indexOf("async function ", start + 20);
  const context = { deliverText: async () => ({ sent: true }), finishLearningUsageTrace: async () => {}, statBump: () => {}, nowt: () => "テスト", lastText: () => "テスト", dbSave: () => {}, notifyAll: () => {} };
  vm.runInNewContext(source.slice(start, end), context);
  const c = { id: "テスト", msgs: [{ from: "them", text: query, at: Date.now() - 1000 }] };
  await context.baDeliver({}, c, "テスト：ご案内します");
  const outgoing = c.msgs.at(-1);
  assert.ok(outgoing.sentAt > 0);
  assert.match(decision.replyMessageText(outgoing), /送信日時/);
  c.msgs.push({ from: "them", text: "テスト：営業時間を教えてください", sentAt: outgoing.sentAt + 86400000 });
  assert.deepEqual(selectConversationContext(c).current.map(m => m.text), ["テスト：営業時間を教えてください"]);
  for (const line of source.split("\n").filter(line => /msgs\.push\(.*from: "us"/.test(line))) {
    assert.match(line, /sentAt/, line);
  }
});

test("非定型の感染症連絡は発行だけと断定せず、関連するキャンセル案内を機械的に禁止しない", async () => {
  const start = source.indexOf("async function genDraft(t, c, opts) {"), end = source.indexOf("// 毎回承認モード", start);
  let inspected = false;
  const context = {
    ...decision, activeConversationMessages: c => c.msgs, S: () => ({ tone: "", prefs: [] }),
    rulesRankedWithScores: () => [{ r: { content: rules }, n: 3, score: 0.5 }], rulesBlock: () => rules, ruleBudget: () => 16000,
    examplesRanked: () => [], trustedLearningPrecedent: () => false, prefsBlock: () => "", notesBlock: () => "", replyToneInstruction: () => "",
    JP_QUALITY: "", PATIENT_COURTESY: "", baEnabled: () => false, staffLineReviewAll: () => false, PARTNER_KEY: "",
    aiChat: async () => JSON.stringify({ draft: "証明書と予約変更について確認します。", confidence: "high", needs_human: true }),
    finalizeGeneratedDraft: async (_t, text) => ({ text, issues: [] }), applyCourtesyGate: () => {},
    reviewDraftChatCandidate: async (_t, p) => { inspected = true; assert.equal(p.forbidCancellationGuidance, undefined); assert.match(p.latestInstruction, /言い方が定型でなくても/); return { text: "免除条件と必要な証明書を案内します。", error: "" }; },
    evaluateResponseGrounding, applyLearningReadinessGate: () => ({}),
  };
  vm.runInNewContext(source.slice(start, end), context);
  const out = await context.genDraft({}, { channel: "line", msgs: [{ from: "them", text: "テスト：インフルで明日の都合が悪くなりました。証明書は必要ですか" }] }, { skipExternal: true });
  assert.equal(inspected, true);
  assert.match(out.draft, /免除条件/);
  assert.equal(out.grounding.autoSendAllowed, false);
});

test("感染症のスタッフ確認ゲートを予約の自動提案も迂回できず、通常提案は維持", async () => {
  const start = source.indexOf("async function handleInboundCore("), end = source.indexOf("// ===== 複数アカウント対応", start);
  for (const blocked of [true, false]) {
    let proposed = 0, delivered = 0;
    const context = {
      ...decision, cancelAutoReply: () => {}, colorFor: () => "", nowt: () => "テスト", statBump: () => {}, lastText: () => "テスト", dbSave: () => {},
      preserveTopicBoundary,
      baEnabled: () => true, PARTNER_KEY: "テスト", baHandlePending: async () => false, staffLineReviewAll: () => false,
      genDraft: async () => ({ draft: "テスト：証明書はスタッフが確認します。", confidence: "high", needs_human: blocked, replyRequiresStaff: blocked,
        grounding: { autoSendAllowed: false, reasons: [] }, validation: { pass: false }, action: { type: "cancel", appointmentId: "テスト将来予約" } }),
      startLearningUsageTrace: async () => {}, baAction: async () => { proposed++; return true; }, S: () => ({ autoReply: false }),
      deliverText: async () => { delivered++; return { sent: true }; }, notifyAll: () => {}, staffLineEscalate: async () => {},
      aiUsageContext: { getStore: () => ({ entries: [] }) }, forwardToPartner: async () => {},
    };
    vm.runInNewContext(source.slice(start, end), context);
    const t = { slug: "テスト", store: {} };
    await context.handleInboundCore(t, { channel: "line", uid: "テスト", text: query });
    assert.equal(proposed, blocked ? 0 : 1);
    assert.equal(delivered, 0);
    if (blocked) assert.match(t.store["line:テスト"].draft, /証明書/);
  }
});
