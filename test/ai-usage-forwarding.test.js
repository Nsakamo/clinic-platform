const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "..", "migiude.js"), "utf8");

test("AI provider responses retain model-specific input and output usage", () => {
  assert.match(source, /provider: "openai", model: route\.model/);
  assert.match(source, /d\.usage && d\.usage\.prompt_tokens/);
  assert.match(source, /provider: "anthropic", model: "claude-sonnet-4-6"/);
  assert.match(source, /d\.usage && d\.usage\.input_tokens/);
});

test("inbound usage is isolated per request and forwarded to the partner hook", () => {
  assert.match(source, /aiUsageContext\.run\(\{ entries: \[\] \}/);
  assert.match(source, /usage: \{ entries: usageEntries \}/);
  assert.match(source, /store\.entries\.push\(result\.usage\)/);
});
