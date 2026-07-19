"use strict";

// 日本語の問い合わせを外部APIなしで比較するための軽量検索。
// 返信本文の定型敬語ではなく「患者の質問」を主に比較し、関係の薄い例をAIへ渡さない。

function normalizeLearningText(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " url ")
    .replace(/(教えてください|お願いいたします|お願いします|ありがとうございます|ございます|でしょうか|できますか|ありますか|あります|について|したいです|ですか|ますか|でした|です|ます)/g, "")
    .replace(/[\s\u3000]+/g, "")
    .replace(/[!-/:-@[-`{-~。、，．！？「」『』（）()【】［］\[\]…・〜～ー]/g, "");
}

function ngrams(value, size) {
  const text = normalizeLearningText(value);
  const set = new Set();
  if (!text) return set;
  if (text.length <= size) {
    set.add(text);
    return set;
  }
  for (let i = 0; i <= text.length - size; i++) set.add(text.slice(i, i + size));
  return set;
}

function intersectionSize(a, b) {
  let count = 0;
  a.forEach((value) => { if (b.has(value)) count++; });
  return count;
}

function textSimilarity(left, right) {
  const a = normalizeLearningText(left);
  const b = normalizeLearningText(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const a2 = ngrams(a, 2), b2 = ngrams(b, 2);
  const a3 = ngrams(a, 3), b3 = ngrams(b, 3);
  const i2 = intersectionSize(a2, b2), i3 = intersectionSize(a3, b3);
  const dice2 = a2.size + b2.size ? (2 * i2) / (a2.size + b2.size) : 0;
  const dice3 = a3.size + b3.size ? (2 * i3) / (a3.size + b3.size) : 0;
  const containment = (a.length >= 4 && b.length >= 4 && (a.includes(b) || b.includes(a))) ? 1 : 0;
  return Math.min(1, dice2 * 0.55 + dice3 * 0.35 + containment * 0.1);
}

function queryScore(query, exampleQuestion) {
  const q = normalizeLearningText(query);
  const e = normalizeLearningText(exampleQuestion);
  if (!q || !e) return 0;
  if (q === e) return 1;
  const q2 = ngrams(q, 2), e2 = ngrams(e, 2);
  const common = intersectionSize(q2, e2);
  if (!common) return 0;
  const coverage = common / Math.max(1, q2.size);
  const precision = common / Math.max(1, e2.size);
  const dice = (2 * common) / Math.max(1, q2.size + e2.size);
  const containment = (q.length >= 4 && e.length >= 4 && (q.includes(e) || e.includes(q))) ? 1 : 0;
  return Math.min(1, coverage * 0.45 + precision * 0.2 + dice * 0.25 + containment * 0.1);
}

function rankLearningExamples(examples, query, limit, now) {
  const latest = String(query && typeof query === "object" ? query.latest : query || "").trim();
  const context = String(query && typeof query === "object" ? query.context : query || "").trim();
  if (!latest && !context) return [];
  const at = Number(now) || Date.now();
  const scored = (Array.isArray(examples) ? examples : []).map((example) => {
    const latestScore = queryScore(latest, example.q);
    const contextScore = context && context !== latest ? queryScore(context, example.q) : latestScore;
    const lexical = Math.max(latestScore, latestScore * 0.75 + contextScore * 0.25);
    const ageDays = Math.max(0, at - Number(example.ts || 0)) / 86400000;
    const recency = Math.max(0, 1 - ageDays / 180);
    const confirmations = Math.min(1, Math.log2(Math.max(1, Number(example.confirmedCount || 1))) / 4);
    // 新しさと確認回数は同程度の候補の順位だけを動かし、無関係な例を浮上させない。
    const score = lexical + (lexical > 0 ? recency * 0.025 + confirmations * 0.025 : 0);
    return { example, lexical, score };
  }).filter((item) => item.lexical >= 0.16);

  scored.sort((a, b) => b.score - a.score || Number(b.example.ts || 0) - Number(a.example.ts || 0) || Number(b.example.id || 0) - Number(a.example.id || 0));
  const picked = [];
  for (const item of scored) {
    // 同じような問い合わせ例でプロンプトを埋めず、より新しく評価の高い1件を残す。
    if (picked.some((existing) => textSimilarity(existing.q, item.example.q) >= 0.72)) continue;
    picked.push({ ...item.example, matchScore: Math.min(1, item.lexical) });
    if (picked.length >= (limit || 4)) break;
  }
  return picked;
}

function sameLearningExample(left, right) {
  if (!left || !right) return false;
  return textSimilarity(left.q, right.q) >= 0.96
    && textSimilarity(left.final, right.final) >= 0.96;
}

module.exports = {
  normalizeLearningText,
  rankLearningExamples,
  sameLearningExample,
  textSimilarity,
};
