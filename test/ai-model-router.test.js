const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeAiRoutes, resolveAiRoute, publicModelCatalog } = require("../lib/ai-model-router");

test("GPT-5.6 roles default to Terra, Luna and Sol by responsibility", () => {
  const routes = normalizeAiRoutes();
  assert.equal(routes.draft.model, "gpt-5.6-terra");
  assert.equal(routes.learning.model, "gpt-5.6-terra");
  assert.equal(routes.classify.model, "gpt-5.6-luna");
  assert.equal(routes.critical.model, "gpt-5.6-sol");
});

test("a tenant can switch one role without changing the other roles", () => {
  const routes = normalizeAiRoutes({ draft: { model: "gpt-5.6-sol", reasoningEffort: "xhigh" } });
  assert.equal(routes.draft.model, "gpt-5.6-sol");
  assert.equal(routes.draft.reasoningEffort, "xhigh");
  assert.equal(routes.classify.model, "gpt-5.6-luna");
});

test("unknown models fail closed unless explicitly registered for a future rollout", () => {
  assert.equal(resolveAiRoute({ aiRoutes: { draft: { model: "unknown-model" } } }, "draft").model, "gpt-5.6-terra");
  assert.equal(resolveAiRoute({ aiRoutes: { draft: { model: "gpt-future" } } }, "draft", { extraModels: ["gpt-future"] }).model, "gpt-future");
  assert.ok(publicModelCatalog(["gpt-future"]).some(item => item.id === "gpt-future"));
});

test("booking and finalize aliases use the safe intended roles", () => {
  assert.equal(resolveAiRoute({}, "booking").model, "gpt-5.6-sol");
  assert.equal(resolveAiRoute({}, "finalize").model, "gpt-5.6-terra");
});
