const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeAiRoutes, resolveAiRoute, publicModelCatalog } = require("../lib/ai-model-router");

test("GPT-6 roles default to Luna and Sol by responsibility", () => {
  const routes = normalizeAiRoutes();
  assert.equal(routes.draft.model, "gpt-6-sol");
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

test("unknown models fail closed unless explicitly registered for a future rollout", () => {
  assert.equal(resolveAiRoute({ aiRoutes: { draft: { model: "unknown-model" } } }, "draft").model, "gpt-6-sol");
  assert.equal(resolveAiRoute({ aiRoutes: { draft: { model: "gpt-future" } } }, "draft", { extraModels: ["gpt-future"] }).model, "gpt-future");
  assert.ok(publicModelCatalog(["gpt-future"]).some(item => item.id === "gpt-future"));
});

test("saved GPT-5.6 routes move to the approved GPT-6 defaults", () => {
  const routes = normalizeAiRoutes({
    draft: { model: "gpt-5.6-terra", reasoningEffort: "medium" },
    classify: { model: "gpt-5.6-luna", reasoningEffort: "low" },
    critical: { model: "gpt-5.6-sol", reasoningEffort: "high" },
  });
  assert.equal(routes.draft.model, "gpt-6-sol");
  assert.equal(routes.classify.model, "gpt-6-luna");
  assert.equal(routes.critical.model, "gpt-6-sol");
});

test("booking and finalize aliases use the safe intended roles", () => {
  assert.equal(resolveAiRoute({}, "booking").model, "gpt-6-sol");
  assert.equal(resolveAiRoute({}, "finalize").model, "gpt-6-sol");
});
