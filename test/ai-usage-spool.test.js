const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { AiUsageSpool } = require("../lib/ai-usage-spool");

test("利用量spoolは再起動後も同じevent keyを一度だけ保持する", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-usage-spool-"));
  const file = path.join(dir, "usage.json");
  const entry = { eventKey: "event-1", input: 10, output: 5 };
  const first = new AiUsageSpool(file);
  first.enqueue(entry);
  first.enqueue(entry);
  assert.equal(first.size, 1);
  const restarted = new AiUsageSpool(file);
  assert.deepEqual(restarted.peek(), entry);
  restarted.remove("event-1");
  assert.equal(new AiUsageSpool(file).size, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("利用量spoolは一時ファイルから原子的に更新する", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-usage-spool-"));
  const file = path.join(dir, "usage.json");
  const spool = new AiUsageSpool(file);
  spool.enqueue({ eventKey: "event-2" });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.readdirSync(dir).filter((name) => name.endsWith(".tmp")).length, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});
