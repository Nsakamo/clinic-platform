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
  return Array.from(name || "添付ファイル").slice(0, 120).join(""); // 絵文字などを途中で切らない（文字単位）
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
  const reason = skippedLabelReason(item && item.reason);
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

// 動画の再生（特にSafari）は Range 要求で分割取得する。
// 解釈できない・複数範囲の指定は null（Rangeを無視して全体を返す）。ファイルの外を指す指定は { unsatisfiable: true }（416）。
// 終わりの無い指定（bytes=0- 等）は、会話を開くたびに本体を丸ごと読まないよう RANGE_OPEN_END_MAX_BYTES までに区切る。
const RANGE_OPEN_END_MAX_BYTES = 4 * 1024 * 1024;
function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header || "").trim());
  if (!m || (m[1] === "" && m[2] === "")) return null;
  if (!size) return { unsatisfiable: true };
  let start, end;
  if (m[1] === "") {
    const n = Number(m[2]);
    if (!n) return { unsatisfiable: true };
    start = Math.max(0, size - n); end = size - 1;
  } else {
    start = Number(m[1]);
    if (start >= size) return { unsatisfiable: true };
    end = m[2] === "" ? Math.min(size - 1, start + RANGE_OPEN_END_MAX_BYTES - 1) : Math.min(Number(m[2]), size - 1);
    if (end < start) return null; // 終わりが始まりより前の指定は無効として無視
  }
  return { start, end };
}

function skippedLabelReason(reason) {
  if (reason === "too_many") return "件数が多い";
  if (reason === "storage_full") return "保存容量の上限に達した";
  if (reason === "save_failed") return "一時的に保存できなかった";
  if (reason === "mail_too_large") return "メール全体が大きすぎる";
  return "サイズが大きい";
}

// AIへの指示: 患者の添付の中身はAIには見えない
const ATTACHMENT_UNSEEN_POLICY = "【患者の添付】会話中の［image］［video］［file］［audio］［添付ファイル…］は患者が送った写真・動画・ファイルで、AIには中身が見えない。"
  + "中身を見た・確認した・拝見したとは書かず、写真などから症状や状態を評価しない。触れる必要があるときは「お送りいただいた写真（ファイル）はスタッフが確認いたします」のように、スタッフが確認する旨だけを伝える。";

module.exports = {
  ATTACHMENT_UNSEEN_POLICY,
  MAIL_ATTACHMENTS_MAX_COUNT,
  MAIL_ATTACHMENTS_TOTAL_MAX_BYTES,
  MAIL_ATTACHMENT_MAX_BYTES,
  attachmentKind,
  cleanFileName,
  inboundFileHeaders,
  isInlineSafe,
  normalizeMime,
  parseRange,
  RANGE_OPEN_END_MAX_BYTES,
  selectMailAttachments,
  skippedLabel,
};
