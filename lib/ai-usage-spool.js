"use strict";

const fs = require("fs");
const path = require("path");

function resolveAiUsageSpoolPath(env = process.env, cwd = process.cwd()) {
  if (env.AI_USAGE_SPOOL_PATH) return env.AI_USAGE_SPOOL_PATH;
  if (env.RAILWAY_VOLUME_MOUNT_PATH) return path.join(env.RAILWAY_VOLUME_MOUNT_PATH, "ai-usage-spool.ndjson");
  if (env.NODE_ENV === "production" || env.RAILWAY_ENVIRONMENT_NAME === "production") {
    throw new Error("AI usage spool requires AI_USAGE_SPOOL_PATH or RAILWAY_VOLUME_MOUNT_PATH in production");
  }
  return path.join(cwd, "data", "ai-usage-spool.ndjson");
}

class AiUsageSpool {
  constructor(filePath) {
    this.filePath = filePath;
    this.entries = new Map();
    this.journalOperations = 0;
    this.load();
  }

  load() {
    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      const trimmed = raw.trim();
      if (!trimmed) return;
      // 旧JSON配列spoolも読み込み、次回compactionでjournal形式へ移行する。
      if (trimmed.startsWith("[")) {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
          for (const entry of parsed) this.addLoadedEntry(entry);
          this.journalOperations = this.entries.size + 128;
        }
        return;
      }
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        const record = JSON.parse(line);
        this.journalOperations += 1;
        if (record.op === "put") this.addLoadedEntry(record.entry);
        else if (record.op === "delete" && typeof record.eventKey === "string") this.deleteLoadedEntry(record.eventKey);
      }
    } catch (error) {
      if (error && error.code !== "ENOENT") console.error("ai usage spool load:", String(error.message || error).slice(0, 120));
    }
  }

  addLoadedEntry(entry) {
    if (!entry || typeof entry.eventKey !== "string" || this.entries.has(entry.eventKey)) return;
    this.entries.set(entry.eventKey, entry);
  }

  deleteLoadedEntry(eventKey) {
    this.entries.delete(eventKey);
  }

  append(record) {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const descriptor = fs.openSync(this.filePath, "a", 0o600);
    try {
      fs.fchmodSync(descriptor, 0o600);
      fs.writeSync(descriptor, `${JSON.stringify(record)}\n`);
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    this.journalOperations += 1;
  }

  compactIfNeeded() {
    if (this.journalOperations < Math.max(128, this.entries.size * 2)) return;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    const body = [...this.entries.values()].map((entry) => JSON.stringify({ op: "put", entry })).join("\n");
    fs.writeFileSync(temporary, body ? `${body}\n` : "", { mode: 0o600 });
    fs.renameSync(temporary, this.filePath);
    this.journalOperations = this.entries.size;
  }

  enqueue(entry) {
    if (this.entries.has(entry.eventKey)) return;
    this.append({ op: "put", entry });
    this.entries.set(entry.eventKey, entry);
  }

  peek() { return this.entries.values().next().value || null; }

  remove(eventKey) {
    if (!this.entries.has(eventKey)) return;
    this.append({ op: "delete", eventKey });
    this.deleteLoadedEntry(eventKey);
    this.compactIfNeeded();
  }

  get size() { return this.entries.size; }
}

module.exports = { AiUsageSpool, resolveAiUsageSpoolPath };
