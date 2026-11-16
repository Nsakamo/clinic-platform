"use strict";

// 患者からのメールに付いた画像・動画・ファイルを、右腕くんの会話で見られるようにするための判定。
// 保存・配信はログイン中の同じ法人のスタッフだけ（/api/inbound-file）。患者の写真を公開URLにしない。

const MAIL_ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;   // 1ファイルの上限（Gmailの添付上限と同じ）
const MAIL_ATTACHMENTS_TOTAL_MAX_BYTES = 50 * 1024 * 1024; // 1通あたりの合計上限
const MAIL_ATTACHMENTS_MAX_COUNT = 10;                // 1通あたりの件数上限
const MAIL_RELATED_SMALL_BYTES = 30 * 1024;           // 本文に埋め込まれた小さな画像（署名のロゴ等）は取り込まない

// ブラウザでそのまま開いてよい形式（スクリプトを実行できない形式だけ）。SVG・HTML などは必ずダウンロード扱い。
const INLINE_MIME = new Set([
  "image/jpeg", "image/png", "image/gif", "image/webp", "image/heic", "image/heif", "image/avif", "image/bmp",
  "video/mp4", "video/quicktime", "video/webm", "video/3gpp", "video/x-m4v",
  "audio/mpeg", "audio/mp4", "audio/aac", "audio/x-m4a", "audio/wav", "audio/x-wav", "audio/ogg", "audio/webm",
  "application/pdf",
]);

const EXTENSION_MIME = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", heic: "image/heic", heif: "image/heif",
  mp4: "video/mp4", mov: "video/quicktime", m4v: "video/x-m4v", webm: "video/webm", "3gp": "video/3gpp",
  m4a: "audio/x-m4a", mp3: "audio/mpeg", wav: "audio/wav", pdf: "application/pdf",
};

function cleanFileName(value) {
  const name = String(value == null ? "" : value).normalize("NFC").replace(/[\u0000-\u001f\u007f/\\]+/g, " ").replace(/\s+/g, " ").trim();
  return (name || "添付ファイル").slice(0, 120);
}

// メールソフトが application/octet-stream で送ってくる写真・動画も、拡張子から形式を判断する
function normalizeMime(mime, fileName) {
  let type = String(mime || "").toLowerCase().split(";")[0].trim();
  if (!/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(type)) type = "application/octet-stream";
  if (type === "application/octet-stream" || type === "image/jpg") {
    const ext = String(fileName || "").toLowerCase().split(".").pop();
    if (type === "image/jpg") return "image/jpeg";
    if (EXTENSION_MIME[ext]) return EXTENSION_MIME[ext];
  }
  return type;
}

function attachmentKind(mime) {
  if (!INLINE_MIME.has(mime)) return "file";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  return "file";
}

function isInlineSafe(mime) { return INLINE_MIME.has(String(mime || "").toLowerCase()); }

// mailparser の attachments から、取り込むものと取り込めないもの（理由つき）に分ける
function selectMailAttachments(list) {
  const keep = [];
  const skipped = [];
  let total = 0;
  for (const raw of Array.isArray(list) ? list : []) {
    if (!raw) continue;
    const data = Buffer.isBuffer(raw.content) ? raw.content : null;
    const size = data ? data.length : Number(raw.size) || 0;
    const name = cleanFileName(raw.filename || raw.name);
    const mime = normalizeMime(raw.contentType, name);
    if (!data || !size) continue;
    // 本文中に埋め込まれた小さな画像（署名のロゴ・アイコン）は会話に出さない
    if (raw.related && size < MAIL_RELATED_SMALL_BYTES) continue;
    if (mime === "message/delivery-status") continue; // 配信エラー通知の機械的な部品
    if (keep.length >= MAIL_ATTACHMENTS_MAX_COUNT) { skipped.push({ name, mime, size, reason: "too_many" }); continue; }
    if (size > MAIL_ATTACHMENT_MAX_BYTES) { skipped.push({ name, mime, size, reason: "too_large" }); continue; }
    if (total + size > MAIL_ATTACHMENTS_TOTAL_MAX_BYTES) { skipped.push({ name, mime, size, reason: "total_too_large" }); continue; }
    total += size;
    keep.push({ name, mime, size, kind: attachmentKind(mime), data });
  }
  return { keep, skipped };
}

function skippedLabel(item) {
  const reason = item && item.reason === "too_many" ? "件数が多い" : "サイズが大きい";
  return cleanFileName(item && item.name) + "（" + reason + "ため右腕くんでは表示できません。メールソフトで確認してください）";
}

// 配信時のヘッダー。スクリプトを動かせる形式は inline にせず、どの形式も sandbox で開く。
function inboundFileHeaders(file) {
  const mime = String(file && file.mime || "application/octet-stream").toLowerCase();
  const inline = isInlineSafe(mime);
  const name = cleanFileName(file && file.name);
  const headers = {
    "Content-Type": inline ? mime : "application/octet-stream",
    "Content-Disposition": (inline ? "inline" : "attachment") + "; filename*=UTF-8''" + encodeURIComponent(name),
    "Cache-Control": "private, no-store, max-age=0",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'unsafe-inline'; sandbox",
    "Accept-Ranges": "bytes",
  };
  // ブラウザ内蔵のPDFビューアは sandbox 指定だと表示できないため、PDFだけ外す（PDFは別プロセスのビューアで開かれる）
  if (mime === "application/pdf") delete headers["Content-Security-Policy"];
  return headers;
}

// 動画の再生（特にSafari）は Range 要求で分割取得する。範囲が不正なら null。
function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header || "").trim());
  if (!m || !size) return null;
  let start, end;
  if (m[1] === "" && m[2] === "") return null;
  if (m[1] === "") { const n = Number(m[2]); if (!n) return null; start = Math.max(0, size - n); end = size - 1; }
  else { start = Number(m[1]); end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1); }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return null;
  return { start, end };
}

module.exports = {
  MAIL_ATTACHMENTS_MAX_COUNT,
  MAIL_ATTACHMENTS_TOTAL_MAX_BYTES,
  MAIL_ATTACHMENT_MAX_BYTES,
  attachmentKind,
  cleanFileName,
  inboundFileHeaders,
  isInlineSafe,
  normalizeMime,
  parseRange,
  selectMailAttachments,
  skippedLabel,
};
