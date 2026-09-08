"use strict";

/** Fixed trusted destinations. No email, tenant, token or browser Host is forwarded. */
function uketsukeLoginUrl(publicBase) {
  let origin;
  try { origin = new URL(publicBase).origin; } catch { return null; }
  if (origin === "https://clinic-platform-staging.up.railway.app") {
    return "https://smilemedi-cloud-w-git-56d932-rupansannsei96-yahoocojps-projects.vercel.app/login?destination=migiude";
  }
  if (origin === "https://migiude.uketsuke-run.online") {
    return "https://app.uketsuke-run.online/login?destination=migiude";
  }
  return null;
}
module.exports = { uketsukeLoginUrl };
