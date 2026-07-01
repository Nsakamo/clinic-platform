# 右腕くん ⇄ 受付るん パートナーAPI

**契約の正本（唯一の正）は受付るん側リポジトリの `docs/19-partner-api-contract.md`。**
API を変える／足すときは、まず正本を更新し、右腕くん（`migiude.js`）と受付るん（`lib/migiude.ts` / API routes）を
同じセッションで揃えること。破壊的変更は避け、フィールド追加で対応する。

## この repo（右腕くん）が提供するエンドポイント（`migiude.js` 内、`pGuard` 認証）

- `GET  /api/partner/tenants` … 顧客一覧
- `POST /api/partner/tenants` … 新規作成（空テナント）`{name, slug?}` → `{slug,name}`
- `DELETE /api/partner/tenants/:slug` … 完全削除
- `GET  /api/partner/conn?slug=` … 連携状態
- `PUT  /api/partner/line-config` … LINE設定（受付るん運営画面から）
- `PUT  /api/partner/mail-config` … メール設定（受付るん運営画面から）
- `POST /api/partner/suspend` … 停止/再開
- `POST /api/partner/sso` … SSO URL発行
- `POST /api/partner/reset-login` … ログイン再発行
- `POST /api/partner/send-line` … 患者へLINE送信

認証キー：`x-partner-key` == `ADMIN_SECRET`（= 受付るん側の共有キー / `PLATFORM_SECRET`）。

## この repo が呼ぶ受付るんのエンドポイント（`PARTNER_HOOK_URL` / `PARTNER_BOOKING_URL`）

- `POST /api/hooks/migiude` … 受信イベント転送＋AI使用量（`usage`）
- `GET  /api/partner/booking?slug=&channel=&userId=` … AI下書き用の患者コンテキスト。
  返却 `text`（整形済み）を `bookingToText` が最優先で下書きに差し込む。

詳細な各リクエスト/レスポンス形は正本（受付るん `docs/19`）を参照。
