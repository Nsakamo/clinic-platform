"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { uketsukeLoginUrl } = require("../lib/uketsuke-login");
test("production and staging use separate fixed email authentication destinations", () => {
  assert.equal(uketsukeLoginUrl("https://migiude.uketsuke-run.online"), "https://app.uketsuke-run.online/login?destination=migiude");
  assert.match(uketsukeLoginUrl("https://clinic-platform-staging.up.railway.app"), /^https:\/\/smilemedi-cloud-w-git-56d932-.*\.vercel\.app\/login\?destination=migiude$/);
});
test("unconfigured or untrusted origin cannot choose login destination", () => {
  for (const value of ["", "invalid", "http://migiude.uketsuke-run.online", "https://example.invalid", "https://migiude.uketsuke-run.online.evil.invalid"]) assert.equal(uketsukeLoginUrl(value), null);
});
