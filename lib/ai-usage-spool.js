"use strict";

const fs = require("fs");
const path = require("path");

const DEFAULT_MAX_ENTRIES = 50000;
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;

function resolveAiUsageSpoolPath(env = process.env, cwd = process.cwd()) {
  if (env.AI_USAGE_SPOOL_PATH) return env.AI_USAGE_SPOOL_PATH;
  if (env.RAILWAY_VOLUME_MOUNT_PATH) return path.join(env.RAILWAY_VOLUME_MOUNT_PATH, "data", "ai-usage-spool.json");
  if (env.NODE_ENV === "production" || env.RAILWAY_ENVIRONMENT_NAME === "production") {
    throw new Error("AI usage spool requires AI_USAGE_SPOOL_PATH or RAILWAY_VOLUME_MOUNT_PATH in production");
  }
  return path.join(cwd, "data", "ai-usage-spool.ndjson");
}

class AiUsageSpool {
  constructor(filePath, options = {}) {
    this.filePath = filePath;
    this.maxEntries = options.maxEntries || DEFAULT_MAX_ENTRIES;
    this.maxBytes = options.maxBytes || DEFAULT_MAX_BYTES;
    this.entries = new Map();
    this.journalOperations = 0;
    this.journalBytes = 0;
    this.load();
  }

  load() {
    let raw;
    try { raw = fs.readFileSync(this.filePath, "utf8"); }
    catch (error) {
      if (error && error.code === "ENOENT") return;
      throw error;
    }
    const trimmed = raw.trim();
    if (!trimmed) return;
    // 旧JSON配列は読込直後にjournalへatomic変換し、旧JSON末尾への追記を防ぐ。
    if (trimmed.startsWith("[")) {
      const parsed = JSON.parse(trimmed);
      if (!Array.isArray(parsed)) throw new Error("ai_usage_spool_invalid_legacy_format");
      for (const entry of parsed) this.addLoadedEntry(entry);
      if (this.entries.size > this.maxEntries) throw new Error("ai_usage_spool_capacity_exceeded");
      this.compact(true);
      return;
    }

    const lines = raw.split("\n");
    let safeBytes = 0;
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (!line) continue;
      let record;
      try { record = JSON.parse(line); }
      catch (error) {
        const isTornTail = index === lines.length - 1 && !raw.endsWith("\n");
        if (!isTornTail) throw new Error(`ai_usage_spool_corrupt_record_${index + 1}`);
        fs.truncateSync(this.filePath, safeBytes);
        this.journalBytes = safeBytes;
        return;
      }
      this.journalOperations += 1;
      if (record.op === "put") this.addLoadedEntry(record.entry);
      else if (record.op === "delete" && typeof record.eventKey === "string") this.entries.delete(record.eventKey);
      safeBytes += Buffer.byteLength(`${line}\n`);
    }
    this.journalBytes = safeBytes;
    // JSON本体だけが書かれ、末尾改行前に停止した場合も次のrecordと連結させない。
    if (!raw.endsWith("\n")) this.compact(true);
    if (this.entries.size > this.maxEntries || this.journalBytes > this.maxBytes) {
      throw new Error("ai_usage_spool_capacity_exceeded");
    }
  }

  addLoadedEntry(entry) {
    if (!entry || typeof entry.eventKey !== "string" || this.entries.has(entry.eventKey)) return;
    this.entries.set(entry.eventKey, entry);
  }

  append(record, allowOverSoftLimit = false) {
    const line = `${JSON.stringify(record)}\n`;
    const bytes = Buffer.byteLength(line);
    if (!allowOverSoftLimit && this.journalBytes + bytes > this.maxBytes) {
      this.compact(true);
      if (this.journalBytes + bytes > this.maxBytes) throw new Error("ai_usage_spool_capacity_exceeded");
    }
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const descriptor = fs.openSync(this.filePath, "a", 0o600);
    try {
      fs.fchmodSync(descriptor, 0o600);
      fs.writeSync(descriptor, line);
      fs.fsyncSync(descriptor);
    } finally { fs.closeSync(descriptor); }
    this.journalOperations += 1;
    this.journalBytes += bytes;
  }

  compact(force = false) {
    if (!force && this.journalOperations < Math.max(128, this.entries.size * 2)) return;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    const body = [...this.entries.values()].map((entry) => JSON.stringify({ op: "put", entry })).join("\n");
    const contents = body ? `${body}\n` : "";
    const descriptor = fs.openSync(temporary, "w", 0o600);
    try {
      fs.fchmodSync(descriptor, 0o600);
      fs.writeSync(descriptor, contents);
      fs.fsyncSync(descriptor);
    } finally { fs.closeSync(descriptor); }
    fs.renameSync(temporary, this.filePath);
    this.journalOperations = this.entries.size;
    this.journalBytes = Buffer.byteLength(contents);
  }

  enqueue(entry) {
    if (this.entries.has(entry.eventKey)) return;
    if (this.entries.size >= this.maxEntries) throw new Error("ai_usage_spool_capacity_exceeded");
    this.append({ op: "put", entry });
    this.entries.set(entry.eventKey, entry);
  }

  peek() { return this.entries.values().next().value || null; }

  remove(eventKey) {
    if (!this.entries.has(eventKey)) return;
    const record = { op: "delete", eventKey };
    const lineBytes = Buffer.byteLength(`${JSON.stringify(record)}\n`);
    if (this.journalBytes + lineBytes > this.maxBytes) {
      // DBへ記録済みなのでメモリから除き、残りの未送信分をatomicに再構築する。
      this.entries.delete(eventKey);
      this.compact(true);
      return;
    }
    this.append(record, true);
    this.entries.delete(eventKey);
    this.compact();
  }

  get size() { return this.entries.size; }
}

module.exports = { AiUsageSpool, resolveAiUsageSpoolPath };
