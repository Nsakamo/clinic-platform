"use strict";

// 予約ページ（今使っている予約システム）と、使わなくなった予約サイト・URL・語句の設定。
// 予約システムを乗り換えた医院で、古い学習例・見本・会話から旧サイトの案内が混ざらないようにする。

const RETIRED_TERMS_MAX = 20;
const RETIRED_TERM_MIN = 2;
const RETIRED_TERM_MAX_LEN = 80;
const BOOKING_PAGE_URL_MAX = 300;

function normalizeBookingPageUrl(value) {
  const text = String(value == null ? "" : value).trim();
  if (!text) return "";
  if (text.length > BOOKING_PAGE_URL_MAX) return null;
  let url;
  try { url = new URL(text); } catch (e) { return null; }
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password) return null;
  return url.toString();
}

function normalizeRetiredTerms(value) {
  const list = Array.isArray(value) ? value : String(value == null ? "" : value).split(/\r?\n|[、,]/);
  const out = [];
  const seen = new Set();
  for (const item of list) {
    const term = String(item == null ? "" : item).trim();
    if (term.length < RETIRED_TERM_MIN || term.length > RETIRED_TERM_MAX_LEN) continue;
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(term);
    if (out.length >= RETIRED_TERMS_MAX) break;
  }
  return out;
}

function textMentionsRetiredTerm(text, terms) {
  const list = normalizeRetiredTerms(terms);
  if (!list.length) return false;
  const haystack = String(text == null ? "" : text).toLowerCase();
  return list.some(term => haystack.includes(term.toLowerCase()));
}

// 学習例が旧サイトを案内しているか。AIの初回案（draft0）はスタッフが直していれば根拠にならないので見ない。
function learningUsesRetiredTerms(example, terms) {
  if (!example) return false;
  let meta = "";
  try { meta = example.learningMeta ? JSON.stringify(example.learningMeta) : ""; } catch (e) { meta = ""; }
  return textMentionsRetiredTerm([example.q, example.final, example.instr, meta].join("\n"), terms);
}

function bookingFactsBlock(settings) {
  const s = settings || {};
  const url = normalizeBookingPageUrl(s.bookingPageUrl) || "";
  const retired = normalizeRetiredTerms(s.retiredTerms);
  if (!url && !retired.length) return "";
  let text = "【予約ページ（現在の正しい案内先。予約の案内先については店舗ルール・スタッフの共通指示・過去の対応例より優先する）】";
  if (url) text += "新規予約・メニューや空き枠の確認・予約の確認・変更・キャンセルを案内するときの予約ページは " + url + " だけを使う。";
  if (retired.length) {
    text += "次の予約サイト・URL・語句は使わなくなった。過去の対応例・書き方の見本・会話履歴・ルールに出てきても、患者へ案内したり下書きに書いたりしない: "
      + retired.join(" / ") + "。";
    if (url) text += "旧サイトの案内が必要に見える場面では、上の予約ページに置き換えて案内する。";
  }
  return text;
}

// 答えられることまで「確認してご案内します」で保留しないための共通方針。
const ANSWER_FIRST_POLICY = "【保留にしない答え方】患者の質問のうち、店舗ルール・照会結果・会話から答えられる部分は、その場で具体的に答える（結論、条件、患者が次にすること、案内先のURL）。"
  + "答えに患者側の情報が足りないときは『確認してご案内します』で終わらせず、必要な情報を患者に具体的に尋ねる（例: どの画面で、どのような表示が出たか／ご希望の医院・日時・メニュー／ご予約時のお名前と電話番号）。"
  + "『確認のうえ改めてご案内します』は、在庫・個別の予約操作・料金の例外判断・医療判断など、医院側で確認しないと答えられない部分だけに使い、何を確認するのかを一言で書く。"
  + "患者の依頼に直接関わる規定（キャンセル・日時変更の依頼に対するキャンセル料・変更料、免除条件など）は、尋ねられていなくても店舗ルールどおり案内する。依頼と関係のない用件（別の予約・他院・別メニューの案内など）は持ち込まない。";

module.exports = {
  ANSWER_FIRST_POLICY,
  RETIRED_TERMS_MAX,
  bookingFactsBlock,
  learningUsesRetiredTerms,
  normalizeBookingPageUrl,
  normalizeRetiredTerms,
  textMentionsRetiredTerm,
};
