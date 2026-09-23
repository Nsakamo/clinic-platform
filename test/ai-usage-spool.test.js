const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { AiUsageSpool, resolveAiUsageSpoolPath } = require("../lib/ai-usage-spool");

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

test("利用量spoolは追記journalで更新し、ファイル権限を制限する", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-usage-spool-"));
  const file = path.join(dir, "usage.json");
  const spool = new AiUsageSpool(file);
  spool.enqueue({ eventKey: "event-2" });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.match(fs.readFileSync(file, "utf8"), /"op":"put"/);
  assert.equal(fs.readdirSync(dir).filter((name) => name.endsWith(".tmp")).length, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("本番では永続spoolパスの設定を必須にする", () => {
  assert.throws(
    () => resolveAiUsageSpoolPath({ NODE_ENV: "production" }, "/ephemeral"),
    /requires AI_USAGE_SPOOL_PATH or RAILWAY_VOLUME_MOUNT_PATH/,
  );
  assert.equal(
    resolveAiUsageSpoolPath({ NODE_ENV: "production", RAILWAY_VOLUME_MOUNT_PATH: "/data" }),
    "/data/ai-usage-spool.ndjson",
  );
  assert.equal(
    resolveAiUsageSpoolPath({ NODE_ENV: "production", AI_USAGE_SPOOL_PATH: "/mnt/usage.ndjson" }),
    "/mnt/usage.ndjson",
  );
});

test("削除journalが増えた場合は未送信分だけへcompactする", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-usage-spool-"));
  const file = path.join(dir, "usage.ndjson");
  const spool = new AiUsageSpool(file);
  for (let index = 0; index < 140; index += 1) {
    const eventKey = `event-${index}`;
    spool.enqueue({ eventKey });
    spool.remove(eventKey);
  }
  assert.equal(spool.size, 0);
  assert.ok(fs.statSync(file).size < 2000);
  assert.equal(fs.readdirSync(dir).filter((name) => name.endsWith(".tmp")).length, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});
