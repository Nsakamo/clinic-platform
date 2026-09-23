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
    resolveAiUsageSpoolPath({ NODE_ENV: "production", RAILWAY_VOLUME_MOUNT_PATH: "/mnt/volume" }),
    "/mnt/volume/data/ai-usage-spool.json",
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

test("旧JSON配列を読込時にjournalへ変換してから追記する", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-usage-spool-"));
  const file = path.join(dir, "usage.ndjson");
  fs.writeFileSync(file, JSON.stringify([{ eventKey: "old" }]));
  const spool = new AiUsageSpool(file);
  spool.enqueue({ eventKey: "new" });
  const restarted = new AiUsageSpool(file);
  assert.equal(restarted.size, 2);
  assert.equal(fs.readFileSync(file, "utf8").startsWith("["), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("末尾の不完全recordを切り離して以後の追記を復元できる", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-usage-spool-"));
  const file = path.join(dir, "usage.ndjson");
  fs.writeFileSync(file, '{"op":"put","entry":{"eventKey":"one"}}\n{"op":"put"');
  const recovered = new AiUsageSpool(file);
  recovered.enqueue({ eventKey: "two" });
  const restarted = new AiUsageSpool(file);
  assert.equal(restarted.size, 2);
  assert.equal(restarted.peek().eventKey, "one");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("末尾改行だけ欠けた完全recordを次のrecordと連結しない", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-usage-spool-"));
  const file = path.join(dir, "usage.ndjson");
  fs.writeFileSync(file, '{"op":"put","entry":{"eventKey":"one"}}');
  const recovered = new AiUsageSpool(file);
  recovered.enqueue({ eventKey: "two" });
  const restarted = new AiUsageSpool(file);
  assert.equal(restarted.size, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("未送信spoolは件数とbytes上限を越えて増えない", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-usage-spool-"));
  const file = path.join(dir, "usage.ndjson");
  const byCount = new AiUsageSpool(file, { maxEntries: 2, maxBytes: 4096 });
  byCount.enqueue({ eventKey: "one" });
  byCount.enqueue({ eventKey: "two" });
  assert.throws(() => byCount.enqueue({ eventKey: "three" }), /capacity_exceeded/);
  assert.equal(byCount.size, 2);
  fs.rmSync(dir, { recursive: true, force: true });

  const bytesDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-usage-spool-"));
  const bytesFile = path.join(bytesDir, "usage.ndjson");
  const byBytes = new AiUsageSpool(bytesFile, { maxEntries: 100, maxBytes: 120 });
  assert.throws(() => byBytes.enqueue({ eventKey: "large", model: "x".repeat(200) }), /capacity_exceeded/);
  assert.equal(byBytes.size, 0);
  fs.rmSync(bytesDir, { recursive: true, force: true });
});
