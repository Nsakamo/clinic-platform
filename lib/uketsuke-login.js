"use strict";

/** Fixed trusted destinations. No email, tenant, token or browser Host is forwarded. */
function uketsukeLoginUrl(publicBase) {
  let origin;
  try {
    const parsed = new URL(publicBase);
    if (parsed.username || parsed.password) return null;
    origin = parsed.origin;
  } catch { return null; }
  if (origin === "https://clinic-platform-staging.up.railway.app") {
    return "https://smilemedi-cloud-w-git-56d932-rupansannsei96-yahoocojps-projects.vercel.app/login?destination=migiude";
  }
  if (origin === "https://migiude.uketsuke-run.online" || origin === "https://clinic-platform-production-cbec.up.railway.app") {
    return "https://app.uketsuke-run.online/login?destination=migiude";
  }
  return null;
}
function emailLoginPage(html, publicBase) {
  return uketsukeLoginUrl(publicBase) ? html : html.replace(/<!-- email-login-start -->[\s\S]*?<!-- email-login-end -->/, "");
}
module.exports = { uketsukeLoginUrl, emailLoginPage };
