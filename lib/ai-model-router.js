const MODEL_CATALOG = Object.freeze({
  "gpt-5.6-sol": { label: "GPT-5.6 Sol", tier: "highest" },
  "gpt-5.6-terra": { label: "GPT-5.6 Terra", tier: "balanced" },
  "gpt-5.6-luna": { label: "GPT-5.6 Luna", tier: "fast" },
});

const TASK_DEFAULTS = Object.freeze({
  draft: { model: "gpt-5.6-terra", reasoningEffort: "medium" },
  chat: { model: "gpt-5.6-terra", reasoningEffort: "medium" },
  learning: { model: "gpt-5.6-terra", reasoningEffort: "high" },
  audit: { model: "gpt-5.6-terra", reasoningEffort: "medium" },
  classify: { model: "gpt-5.6-luna", reasoningEffort: "low" },
  critical: { model: "gpt-5.6-sol", reasoningEffort: "high" },
});

const TASK_ALIASES = Object.freeze({ finalize: "draft", summarize: "classify", booking: "critical" });
const REASONING_EFFORTS = new Set(["none", "low", "medium", "high", "xhigh", "max"]);

function canonicalTask(task) {
  const key = String(task || "draft");
  return TASK_DEFAULTS[key] ? key : (TASK_ALIASES[key] || "draft");
}

function allowedModels(extraModels) {
  const values = Object.keys(MODEL_CATALOG).concat(Array.isArray(extraModels) ? extraModels : []);
  return new Set(values.map(String).filter(v => /^[a-z0-9][a-z0-9._:-]{1,80}$/i.test(v)));
}

function normalizeAiRoutes(value, extraModels) {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const allowed = allowedModels(extraModels);
  const out = {};
  for (const [task, defaults] of Object.entries(TASK_DEFAULTS)) {
    const candidate = input[task] && typeof input[task] === "object" ? input[task] : {};
    const model = allowed.has(String(candidate.model || "")) ? String(candidate.model) : defaults.model;
    const reasoningEffort = REASONING_EFFORTS.has(String(candidate.reasoningEffort || "")) ? String(candidate.reasoningEffort) : defaults.reasoningEffort;
    out[task] = { provider: "openai", model, reasoningEffort };
  }
  return out;
}

function resolveAiRoute(settings, task, options) {
  const key = canonicalTask(task);
  const routes = normalizeAiRoutes(settings && settings.aiRoutes, options && options.extraModels);
  const override = options && options.override;
  if (override && typeof override === "object") {
    const candidate = normalizeAiRoutes({ [key]: override }, options && options.extraModels)[key];
    return Object.assign({ task: key }, candidate);
  }
  return Object.assign({ task: key }, routes[key]);
}

function publicModelCatalog(extraModels) {
  const custom = (Array.isArray(extraModels) ? extraModels : []).filter(model => !MODEL_CATALOG[model]).map(model => ({ id: model, label: model, tier: "custom" }));
  return Object.entries(MODEL_CATALOG).map(([id, meta]) => ({ id, label: meta.label, tier: meta.tier })).concat(custom);
}

module.exports = { MODEL_CATALOG, TASK_DEFAULTS, canonicalTask, normalizeAiRoutes, resolveAiRoute, publicModelCatalog };
