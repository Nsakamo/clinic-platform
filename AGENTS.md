# AGENTS.md — 右腕くん共同開発ルール

## 開始時

1. `docs/21-codex-handoff.md` を読む。
2. 連携変更は `PARTNER_API.md` と、正本 `smilemedi-cloud/docs/19-partner-api-contract.md` を読む。
3. `git status --short --branch` で他のAI・人の未コミット変更がないか確認する。

## ブランチと引き継ぎ

- 実装は `staging`。`main` へ直接pushしない。
- mainへのマージは、ユーザー、または対象機能・変更範囲について本番反映を明示的に依頼された実装担当AIが行える。実装担当AIは許可対象の機能概要と確定した本番PR番号を引継ぎ記録またはPR本文へ残す。同じ対象差分のテスト・監査指摘修正は再確認不要だが、後から追加した別機能・別PR・別リリースへ許可を流用しない。許可がない場合はmain PRを作成して停止する。
- 実装担当AIがmainへマージできるのは、staging統合、全必須テスト、隔離stagingの実ブラウザ確認、独立Claude監査（P0/P1/P2=0）、PR必須チェックがすべて合格した場合だけとする。監査役AIは読み取り専用で、修正・mainマージを行わない。
- 本番Railwayでは患者・予約・送信・設定を変更するE2Eを行わない。マージ後はhealth、主要画面、エラーログ、デプロイ状態を読み取り確認する。
- CodexとClaudeは同時編集しない。実装者がcommit/pushしてから、別のAIがpullしてレビュー/E2Eする。
- amend/rebase/force pushは禁止。修正は新しいコミットで積む。
- 本番Railwayで書き込みE2Eをしない。右腕くんの隔離stagingサービスを用意して確認する。

## 必須検証

- `node --check migiude.js`
- `PAGE`内のブラウザーJavaScriptも構文解析する（サーバー構文チェックだけではテンプレート内の崩れを検出できない）。
- `git diff --check`
- LINE/メール/Slackの実送信はテスト専用アカウント・チャンネルだけを使う。
- テストデータの名前・本文には `テスト` を含め、自分が作ったもの以外は削除しない。

## セキュリティ

- `PLATFORM_SECRET`、`CRED_KEY`、APIキー、LINEトークン、メールパスワード、Slack Webhook URL・Bot Token・Signing Secretをコード・ログ・チャットへ出さない。
- スタッフ承認通知は法人専用スタッフLINEを使う。患者向けLINEと同じチャネル、または他法人登録済みチャネルを許可しない。資格情報は再表示せず、Webhookはdestinationで法人を特定してからその法人のsecretで署名検証する。
- 予約のキャンセル・日時変更は、現在の会話の本人確認済み患者と予約IDをサーバーで再照合し、スタッフの最終確認後だけ実行する。
