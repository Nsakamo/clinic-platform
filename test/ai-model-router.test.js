const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeAiRoutes, resolveAiRoute, publicModelCatalog } = require("../lib/ai-model-router");

test("GPT-6 roles default to Luna and Sol by responsibility", () => {
  const routes = normalizeAiRoutes();
  assert.equal(routes.draft.model, "gpt-6-luna");
  assert.equal(routes.chat.model, "gpt-6-luna");
  assert.equal(routes.finalize.model, "gpt-6-luna");
  assert.equal(routes.finalize.reasoningEffort, "low");
  assert.equal(routes.learning.model, "gpt-6-sol");
  assert.equal(routes.classify.model, "gpt-6-luna");
  assert.equal(routes.critical.model, "gpt-6-sol");
});

test("a tenant can switch one role without changing the other roles", () => {
  const routes = normalizeAiRoutes({ draft: { model: "gpt-6-sol", reasoningEffort: "xhigh" } });
  assert.equal(routes.draft.model, "gpt-6-sol");
  assert.equal(routes.draft.reasoningEffort, "xhigh");
  assert.equal(routes.classify.model, "gpt-6-luna");
});

test("既存法人が下書き用に選んだモデルを文体校正へ引き継ぐ", () => {
  const migrated = normalizeAiRoutes({ draft: { model: "gpt-6-luna", reasoningEffort: "medium" } });
  assert.equal(migrated.finalize.model, "gpt-6-luna");
  assert.equal(migrated.finalize.reasoningEffort, "low");
  const separatelyChosen = normalizeAiRoutes({ draft: { model: "gpt-6-luna" }, finalize: { model: "gpt-6-sol" } });
  assert.equal(separatelyChosen.finalize.model, "gpt-6-sol");
});

test("unknown models fail closed unless explicitly registered for a future rollout", () => {
  assert.equal(resolveAiRoute({ aiRoutes: { draft: { model: "unknown-model" } } }, "draft").model, "gpt-6-luna");
  assert.equal(resolveAiRoute({ aiRoutes: { draft: { model: "gpt-future" } } }, "draft", { extraModels: ["gpt-future"] }).model, "gpt-future");
  assert.ok(publicModelCatalog(["gpt-future"]).some(item => item.id === "gpt-future"));
});

test("saved GPT-5.6 routes move to the approved GPT-6 defaults", () => {
  const routes = normalizeAiRoutes({
    draft: { model: "gpt-5.6-terra", reasoningEffort: "medium" },
    classify: { model: "gpt-5.6-luna", reasoningEffort: "low" },
    critical: { model: "gpt-5.6-sol", reasoningEffort: "high" },
  });
  assert.equal(routes.draft.model, "gpt-6-luna");
  assert.equal(routes.classify.model, "gpt-6-luna");
  assert.equal(routes.critical.model, "gpt-6-sol");
});

test("booking keeps critical reasoning while style review uses low effort by default", () => {
  assert.equal(resolveAiRoute({}, "booking").model, "gpt-6-sol");
  assert.equal(resolveAiRoute({}, "finalize").model, "gpt-6-luna");
  assert.equal(resolveAiRoute({}, "finalize").reasoningEffort, "low");
  assert.equal(resolveAiRoute({ aiRoutes: { finalize: { model: "gpt-6-luna", reasoningEffort: "low" } } }, "finalize").model, "gpt-6-luna");
});

test("GPT-6.1 Sol can be chosen per role and never receives an unsupported reasoning effort", () => {
  const routes = normalizeAiRoutes({ draft: { model: "gpt-6.1-sol", reasoningEffort: "medium" }, chat: { model: "gpt-6.1-sol", reasoningEffort: "none" }, critical: { model: "gpt-6.1-sol", reasoningEffort: "high" } });
  assert.equal(routes.draft.model, "gpt-6.1-sol");
  assert.equal(routes.draft.reasoningEffort, "medium");
  assert.equal(routes.chat.model, "gpt-6.1-sol");
  assert.equal(routes.chat.reasoningEffort, "low");
  assert.equal(routes.critical.reasoningEffort, "high");
  assert.equal(routes.classify.model, "gpt-6-luna");
  assert.equal(resolveAiRoute({}, "draft", { override: { model: "gpt-6.1-sol", reasoningEffort: "none" } }).reasoningEffort, "low");
  assert.equal(normalizeAiRoutes({ draft: { model: "gpt-6-sol", reasoningEffort: "none" } }).draft.reasoningEffort, "none");
  const catalog = publicModelCatalog();
  assert.ok(catalog.some(item => item.id === "gpt-6.1-sol" && item.label === "GPT-6.1 Sol"));
  assert.equal(publicModelCatalog(["gpt-6.1-sol"]).filter(item => item.id === "gpt-6.1-sol").length, 1);
});

test("GPT-6.1 Sol snapshot IDs registered for rollout also avoid the unsupported effort", () => {
  const routes = normalizeAiRoutes({ draft: { model: "GPT-6.1-sol-2026-10-01", reasoningEffort: "none" } }, ["GPT-6.1-sol-2026-10-01"]);
  assert.equal(routes.draft.model, "GPT-6.1-sol-2026-10-01");
  assert.equal(routes.draft.reasoningEffort, "low");
  assert.equal(normalizeAiRoutes({ draft: { model: "gpt-6.1-solar", reasoningEffort: "none" } }, ["gpt-6.1-solar"]).draft.reasoningEffort, "none");
});
