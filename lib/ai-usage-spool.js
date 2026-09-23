"use strict";

const fs = require("fs");
const path = require("path");

class AiUsageSpool {
  constructor(filePath) {
    this.filePath = filePath;
    this.entries = [];
    this.load();
  }

  load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      if (Array.isArray(parsed)) this.entries = parsed.filter((entry) => entry && typeof entry.eventKey === "string");
    } catch (error) {
      if (error && error.code !== "ENOENT") console.error("ai usage spool load:", String(error.message || error).slice(0, 120));
    }
  }

  persist() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(this.entries), { mode: 0o600 });
    fs.renameSync(temporary, this.filePath);
  }

  enqueue(entry) {
    if (!this.entries.some((item) => item.eventKey === entry.eventKey)) {
      this.entries.push(entry);
      this.persist();
    }
  }

  peek() { return this.entries[0] || null; }

  remove(eventKey) {
    const index = this.entries.findIndex((entry) => entry.eventKey === eventKey);
    if (index < 0) return;
    this.entries.splice(index, 1);
    this.persist();
  }

  get size() { return this.entries.length; }
}

module.exports = { AiUsageSpool };
