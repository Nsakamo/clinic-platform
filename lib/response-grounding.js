"use strict";

// AI自身のconfidenceとは別に、問い合わせと返信案に含まれる事実主張を
// 「店舗ルール」「本人確認済み予約データ」などの根拠で送信可能か判定する。
// 過去対応例は文章・対応手順の参考であり、変わり得る事実の根拠にはしない。

const PATTERNS = {
  medical: /(痛み|出血|腫れ|発熱|しびれ|副作用|症状|診断|薬|服用|アレルギー|治療|施術後)/,
  paymentTrouble: /(返金|不正利用|二重請求|身に覚え|支払(?:い)?トラブル|決済エラー|クレーム|苦情)/,
  money: /(料金|価格|費用|いくら|割引|キャンセル料|手数料|送料|税込|税抜|\d[\d,]*(?:円|％|%))/,
  availability: /(空き|空いて|予約枠|予約可能|予約できます|日時変更|予約を変更|予約変更したい|キャンセルしたい|キャンセルして|予約をキャンセル|予約を取|予約をお取り)/,
  personal: /(あなたの|お客様の|患者情報|会員ランク|ポイント|回数券|来院履歴|予約内容|登録情報)/,
  policy: /(期限|規定|対象外|返品|交換|発送|配送|営業日|営業時間|休診|対応可能)/,
};

const DRAFT_CLAIMS = {
  medicalAssurance: /(問題ありません|大丈夫です|正常です|心配ありません|副作用ではありません|治ります)/,
  bookingFact: /(空いて(?:います|おります)|空きが(?:あります|ござい)|予約(?:でき|可能)|ご予約を確認|変更(?:しました|完了)|キャンセル(?:しました|完了))/,
  personalFact: /(お客様の(?:予約|登録|ポイント|回数券|来院)|ご予約は|現在の予約)/,
};

function has(pattern, value) {
  return pattern.test(String(value || ""));
}

function unique(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

function evaluateResponseGrounding(input) {
  input = input || {};
  const query = String(input.query || "");
  const draft = String(input.draft || "");
  const combined = query + "\n" + draft;
  const ruleMatches = Array.isArray(input.ruleMatches) ? input.ruleMatches : [];
  const precedentMatches = Array.isArray(input.precedentMatches) ? input.precedentMatches : [];
  const hasRule = ruleMatches.some((r) => Number(r.score || 0) >= 0.12 || Number(r.overlap || 0) >= 2);
  const hasTrustedPrecedent = precedentMatches.some((example) => example && example.trusted === true);
  const verifiedBooking = !!input.verifiedBooking;
  const verifiedSlots = !!input.verifiedSlots;
  const reasons = [];
  const domains = [];

  if (has(PATTERNS.medical, query)) {
    domains.push("medical");
    reasons.push("医療・症状に関する問い合わせはスタッフ確認が必要です");
  }
  if (has(PATTERNS.paymentTrouble, query)) {
    domains.push("payment_trouble");
    reasons.push("返金・決済トラブル・苦情はスタッフ判断が必要です");
  }
  if (has(PATTERNS.money, combined)) {
    domains.push("money");
    if (!hasRule && !hasTrustedPrecedent) reasons.push("料金・金額の根拠となる最新ルールまたはスタッフ確定例がありません");
  }
  if (has(PATTERNS.availability, query) || has(DRAFT_CLAIMS.bookingFact, draft)) {
    domains.push("booking");
    if (!verifiedBooking && !verifiedSlots) reasons.push("予約状況・空き枠を本人確認済みシステムデータで確認できていません");
  }
  if (has(PATTERNS.personal, query) || has(DRAFT_CLAIMS.personalFact, draft)) {
    domains.push("personal");
    if (!verifiedBooking) reasons.push("患者固有情報を本人確認済みデータで確認できていません");
  }
  if (has(PATTERNS.policy, combined)) {
    domains.push("policy");
    if (!hasRule && !hasTrustedPrecedent && !verifiedBooking && !verifiedSlots) reasons.push("規定・対応可否の根拠となる最新ルールまたはスタッフ確定例がありません");
  }
  if (has(DRAFT_CLAIMS.medicalAssurance, draft)) {
    domains.push("medical_claim");
    reasons.push("返信案に医療的な安全断定が含まれています");
  }

  const sources = [];
  if (hasRule) sources.push("店舗ルール");
  if (hasTrustedPrecedent) sources.push("類似するスタッフ確定例");
  if (verifiedBooking) sources.push("本人確認済み予約・患者情報");
  if (verifiedSlots) sources.push("リアルタイム空き枠");
  if (Number(input.learningExampleCount || 0) > 0) sources.push("過去対応例（文章・手順の参考のみ）");

  return {
    autoSendAllowed: unique(reasons).length === 0,
    reasons: unique(reasons),
    domains: unique(domains),
    sources: unique(sources),
    ruleRefs: ruleMatches.filter((r) => Number(r.score || 0) >= 0.12 || Number(r.overlap || 0) >= 2).slice(0, 8).map((r) => ({ id: r.id, title: r.title, score: Math.round(Number(r.score || 0) * 100) })),
  };
}

module.exports = { evaluateResponseGrounding };
