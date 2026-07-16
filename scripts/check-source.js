"use strict";

const fs = require("fs");
const vm = require("vm");

const source = fs.readFileSync(require.resolve("../migiude.js"), "utf8");
new vm.Script(source, { filename: "migiude.js" });

const start = source.indexOf("const PAGE = `");
const end = source.indexOf("</html>`;", start);
if (start < 0 || end < 0) throw new Error("PAGE template not found");

const context = {};
const literal = source.slice(start + "const PAGE = ".length, end + "</html>`".length);
vm.runInNewContext("PAGE=" + literal, context);

const scripts = [...context.PAGE.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
if (!scripts.length) throw new Error("browser script not found in PAGE");
scripts.forEach((script, index) => new vm.Script(script, { filename: "PAGE-script-" + index + ".js" }));

[
  "/webhook/staff-line",
  "/api/staff-line/config",
  "/api/staff-line/link-code",
  "/api/staff-line/test",
  "/api/quality-preview",
  "/api/staff-booking-action",
  "/api/staff-booking-confirm",
  "/api/partner/password-reset",
  "setStaffLineToken",
  "staffLineApprovalMessage",
  "staffLineHistoryPageMessage",
  "enrichStaffLineBookingPreview",
  "finalizeGeneratedDraft",
  "isPersistentConversationInstruction",
  "staffBookingPending"
].forEach((required) => {
  if (!source.includes(required)) throw new Error("required implementation missing: " + required);
});

["/api/slack/", "/api/slack-test", "setSlackWebhook"].forEach((removed) => {
  if (source.includes(removed)) throw new Error("removed Slack implementation still present: " + removed);
});

console.log("server and embedded browser scripts parsed successfully");
