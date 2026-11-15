"use strict";

// スタッフが手で返信するときのテンプレート（定型文）。法人ごとに設定へ保存する。

const TEMPLATE_MAX = 300;
const TEMPLATE_TITLE_MAX = 60;
const TEMPLATE_CATEGORY_MAX = 30;
const TEMPLATE_BODY_MAX = 2000;
const TEMPLATE_VARIABLES = ["{お名前}", "{予約ページ}", "{医院名}"];

function cleanLine(value, max) {
  return (typeof value === "string" ? value : "").replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

// 画面は分類なしを「その他」の欄に出すため、「その他」は分類なしとして保存する（並び替えの順番をそろえる）
function cleanCategory(value) {
  const category = cleanLine(value, TEMPLATE_CATEGORY_MAX);
  return category === "その他" ? "" : category;
}

function cleanBody(value) {
  return (typeof value === "string" ? value : "").replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, "").trim().slice(0, TEMPLATE_BODY_MAX);
}

function normalizeTemplate(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = String(raw.id == null ? "" : raw.id).trim();
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(id)) return null;
  const title = cleanLine(raw.title, TEMPLATE_TITLE_MAX);
  const body = cleanBody(raw.body);
  if (!title || !body) return null;
  const updated = Number(raw.updated);
  return { id, title, category: cleanCategory(raw.category), body, updated: Number.isFinite(updated) && updated > 0 ? Math.round(updated) : 0 };
}

function normalizeTemplates(list) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(list) ? list : []) {
    const item = normalizeTemplate(raw);
    if (!item || seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
    if (out.length >= TEMPLATE_MAX) break;
  }
  return out;
}

function newTemplateId(now, random) {
  const time = Math.max(0, Math.round(Number(now) || Date.now())).toString(36);
  const rand = Math.floor((typeof random === "number" ? random : Math.random()) * 1e8).toString(36);
  return "tpl_" + time + rand;
}

// 追加・更新。返り値 { ok, templates, template } / { ok:false, error }
function saveTemplate(list, input, now) {
  const current = normalizeTemplates(list);
  const title = cleanLine(input && input.title, TEMPLATE_TITLE_MAX);
  const body = cleanBody(input && input.body);
  if (!title || !body) return { ok: false, error: "required" };
  const category = cleanCategory(input && input.category);
  const stamp = Math.round(Number(now) || Date.now());
  const id = String(input && input.id != null ? input.id : "").trim();
  if (id) {
    const index = current.findIndex(item => item.id === id);
    if (index < 0) return { ok: false, error: "not_found" };
    current[index] = { id, title, category, body, updated: stamp };
    return { ok: true, templates: current, template: current[index] };
  }
  if (current.length >= TEMPLATE_MAX) return { ok: false, error: "too_many" };
  let nextId = newTemplateId(stamp);
  while (current.some(item => item.id === nextId)) nextId = newTemplateId(stamp + 1);
  const template = { id: nextId, title, category, body, updated: stamp };
  current.push(template);
  return { ok: true, templates: current, template };
}

function deleteTemplate(list, id) {
  const current = normalizeTemplates(list);
  const key = String(id == null ? "" : id);
  const next = current.filter(item => item.id !== key);
  if (next.length === current.length) return { ok: false, error: "not_found" };
  return { ok: true, templates: next };
}

function moveTemplate(list, id, direction) {
  const current = normalizeTemplates(list);
  const index = current.findIndex(item => item.id === String(id == null ? "" : id));
  if (index < 0) return { ok: false, error: "not_found" };
  const dir = Number(direction);
  if (dir !== -1 && dir !== 1) return { ok: false, error: "invalid_direction" };
  // 画面は分類ごとにまとめて表示するため、同じ分類の中で隣のテンプレートと入れ替える
  const cat = current[index].category || "";
  let target = index + dir;
  while (target >= 0 && target < current.length && (current[target].category || "") !== cat) target += dir;
  if (target < 0 || target >= current.length) return { ok: true, templates: current };
  const tmp = current[index];
  current[index] = current[target];
  current[target] = tmp;
  return { ok: true, templates: current };
}

// 差し込み。値が無い項目は「（お名前）」のように目に見える形で残し、スタッフが送信前に気付けるようにする。
function fillTemplate(body, values) {
  const v = values || {};
  const map = {
    "{お名前}": String(v.name || "").trim() || "（お名前）",
    "{予約ページ}": String(v.bookingPageUrl || "").trim() || "（予約ページURL）",
    "{医院名}": String(v.clinicName || "").trim() || "（医院名）",
  };
  return String(body == null ? "" : body).replace(/\{(お名前|予約ページ|医院名)\}/g, m => map[m]);
}

module.exports = {
  TEMPLATE_BODY_MAX,
  TEMPLATE_CATEGORY_MAX,
  TEMPLATE_MAX,
  TEMPLATE_TITLE_MAX,
  TEMPLATE_VARIABLES,
  deleteTemplate,
  fillTemplate,
  moveTemplate,
  newTemplateId,
  normalizeTemplates,
  saveTemplate,
};
