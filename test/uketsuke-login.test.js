"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { uketsukeLoginUrl, emailLoginPage } = require("../lib/uketsuke-login");
const fs = require("node:fs");
const vm = require("node:vm");
test("production and staging use separate fixed email authentication destinations", () => {
  assert.equal(uketsukeLoginUrl("https://migiude.uketsuke-run.online"), "https://app.uketsuke-run.online/login?destination=migiude");
  assert.equal(uketsukeLoginUrl("https://clinic-platform-production-cbec.up.railway.app"), "https://app.uketsuke-run.online/login?destination=migiude");
  assert.match(uketsukeLoginUrl("https://clinic-platform-staging.up.railway.app"), /^https:\/\/smilemedi-cloud-w-git-56d932-.*\.vercel\.app\/login\?destination=migiude$/);
});
test("actual login markup hides email entry when unavailable without removing password login", () => {
  const source = fs.readFileSync(require.resolve("../migiude.js"), "utf8");
  const start = source.indexOf("const LOGIN_PAGE = `");
  const end = source.indexOf("</body></html>`;", start) + "</body></html>`;".length;
  const html = vm.runInNewContext(source.slice(start, end) + ";LOGIN_PAGE");
  assert.match(emailLoginPage(html, "https://migiude.uketsuke-run.online"), /href="\/login\/email"/);
  const unavailable = emailLoginPage(html, "https://example.invalid");
  assert.doesNotMatch(unavailable, /href="\/login\/email"/);
  assert.match(unavailable, /id="p" type="password"/);
});
test("actual email endpoint redirects only to fixed origin, or returns recoverable 503", () => {
  const source = fs.readFileSync(require.resolve("../migiude.js"), "utf8");
  const start = source.indexOf('app.get("/login/email",');
  const end = source.indexOf('app.get("/forgot",', start);
  let handler;
  vm.runInNewContext(source.slice(start, end), { app: { get: (_path, fn) => { handler = fn; } }, uketsukeLoginUrl,
    requestPublicBase: req => req.base, pageWithEnvironmentBanner: (_req, html) => html });
  for (const [base, expected] of [["https://migiude.uketsuke-run.online",303], ["https://example.invalid",503]]) {
    const result = {};
    const res = { set: (key,value) => { result[key]=value; }, status: status => { result.status=status;return res; },
      send: body => { result.body=body; }, redirect: (status,url) => { result.status=status;result.url=url; } };
    handler({base, query:{next:"https://evil.invalid"}},res);
    assert.equal(result.status,expected);
    assert.equal(result["Cache-Control"],"no-store");
    if(expected===303) assert.equal(result.url,uketsukeLoginUrl(base));
    else assert.match(result.body,/ログイン画面へ戻る/);
  }
});
test("unconfigured or untrusted origin cannot choose login destination", () => {
  for (const value of ["", "invalid", "http://migiude.uketsuke-run.online", "https://example.invalid", "https://migiude.uketsuke-run.online.evil.invalid"]) assert.equal(uketsukeLoginUrl(value), null);
});
