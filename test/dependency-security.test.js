"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { simpleParser } = require("mailparser");
const { convert } = require("html-to-text");
const nodemailer = require("nodemailer");

test("更新後のメール解析で日本語HTML本文と添付を読み取れる", async () => {
  const raw = [
    "From: patient@example.test",
    "To: clinic@example.test",
    "Subject: =?UTF-8?B?5LqI57SE44Gu44GK5ZWP44GE5ZCI44KP44Gb?=",
    "MIME-Version: 1.0",
    'Content-Type: multipart/mixed; boundary="test-boundary"',
    "",
    "--test-boundary",
    'Content-Type: text/html; charset="UTF-8"',
    "",
    "<p>予約について<br>確認をお願いします。</p>",
    "--test-boundary",
    'Content-Type: text/plain; name="memo.txt"',
    "Content-Disposition: attachment; filename=memo.txt",
    "Content-Transfer-Encoding: base64",
    "",
    "44OG44K544OI",
    "--test-boundary--",
    "",
  ].join("\r\n");
  const parsed = await simpleParser(Buffer.from(raw));
  assert.match(parsed.subject, /予約のお問い合わせ/);
  assert.match(parsed.html, /予約について/);
  const plainText = convert(parsed.html);
  assert.match(plainText, /予約について/);
  assert.match(plainText, /確認をお願いします/);
  assert.equal(parsed.attachments.length, 1);
  assert.equal(parsed.attachments[0].filename, "memo.txt");
});

test("更新後のNodemailerで日本語メールを組み立てられる", async () => {
  const transport = nodemailer.createTransport({ jsonTransport: true });
  const result = await transport.sendMail({
    from: "clinic@example.test",
    to: "patient@example.test",
    subject: "ご予約確認",
    text: "ご予約を承りました。",
  });
  assert.ok(result.message);
  const message = JSON.parse(String(result.message));
  assert.equal(message.subject, "ご予約確認");
  assert.equal(message.text, "ご予約を承りました。");
});
