function normalizeText(value, max) {
  let text = "";
  if (Array.isArray(value)) text = value.map(item => normalizeText(item, max || 1000)).filter(Boolean).join("\n");
  else if (value && typeof value === "object") text = Object.values(value).map(item => normalizeText(item, max || 1000)).filter(Boolean).join("\n");
  else text = String(value || "");
  return text.split(/\n+/).map(line => line.replace(/[ \t]+/g, " ").trim()).filter(Boolean).join("\n").slice(0, max || 1000);
}

function bulletBlock(value, max) {
  const lines = normalizeText(value, max).split("\n").map(line => line.replace(/^[・●*-]\s*/, "").trim()).filter(Boolean);
  return lines.map(line => "・" + line).join("\n");
}

function bookingLearningFallback(question) {
  const q = normalizeText(question, 1200);
  const external = /キレイパス|カンナム|トリビュー|くまポン|外部.*予約|予約サイト/i.test(q);
  const source = /キレイパス/i.test(q) ? "キレイパスなどの外部予約サイト" : (external ? "外部予約サイト" : "予約システム");
  return [
    "【適用する状況】\n・" + source + "経由の予約について、患者から予約内容に問題がないか確認を求められたとき",
    "【確認すること】\n・患者から提示された会員情報などを使い、予約日時・来院先・メニューを予約システム上の最新情報と照合する",
    "【回答方針】\n・予約を確認できた場合のみ問題ない旨を案内する\n・確認できない場合は断定せず、不足している本人確認情報や予約情報を尋ねる",
    "【引き継がない情報】\n・今回の会員ID・予約日時・患者固有の情報は、別の患者への回答に流用しない",
  ].join("\n\n");
}

function contextualLearningFallback(input) {
  const q = normalizeText(input && input.q, 1200);
  if (/予約|来院|日時|会員ID|認証コード/i.test(q)) return bookingLearningFallback(q);
  return [
    "【適用する状況】\n・今回と同じ種類・目的の問い合わせを受けたとき",
    "【確認すること】\n・問い合わせに関係する店舗ルール、患者情報、最新のシステム情報を確認する",
    "【回答方針】\n・確認できた事実に基づき、今回スタッフが確定した回答と同じ判断・案内手順で回答する\n・短い修正指示だけを単独のルールとして扱わない",
    "【引き継がない情報】\n・患者固有の氏名・番号・日時・今回限りの特例は、別の患者への回答に流用しない",
  ].join("\n\n");
}

function formatLearningProposal(value, fallback) {
  const v = value && typeof value === "object" ? value : {};
  const situation = normalizeText(v.situation, 500);
  const checks = normalizeText(v.checks, 700);
  const response = normalizeText(v.response, 700);
  const exclusions = normalizeText(v.exclusions, 500);
  if (!situation || !checks || !response) return fallback;
  return [
    "【適用する状況】\n" + bulletBlock(situation, 500),
    "【確認すること】\n" + bulletBlock(checks, 900),
    "【回答方針】\n" + bulletBlock(response, 900),
    "【引き継がない情報】\n" + bulletBlock(exclusions || "患者固有の情報と今回限りの特例は、別の患者への回答に流用しない", 600),
  ].join("\n\n").slice(0, 2400);
}

module.exports = { contextualLearningFallback, formatLearningProposal };
