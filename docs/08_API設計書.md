# 08 API設計書

| 項目 | 内容 |
|---|---|
| 文書番号 | SF-DOC-08 |
| 版 | 1.0（2026-11-18） |
| 正本 | `spec/openapi.yaml`（OpenAPI 3.1。検証ツール openapi-spec-validator で検証済み：73パス・85操作・37スキーマ） |
| 関連 | 04 基本設計書、07 DB設計書、09 外部インターフェイス設計書 |

この資料は API の共通の決まりと一覧です。項目の型・必須・値の範囲は openapi.yaml を正とします。

## 1. 共通の決まり

| 項目 | 決まり |
|---|---|
| ベースパス | `/api/v1`（画面と同じドメイン。Firebase Hosting が Cloud Run へ転送） |
| 形式 | JSON（UTF-8）。ファイルの登録だけ multipart/form-data |
| 名前 | 項目名は camelCase。DB の列（snake_case）とは API の層で変換する |
| 日付・時刻 | 日付 `YYYY-MM-DD`、時刻 `HH:MM`、日時 ISO 8601（+09:00） |
| 金額 | 整数（円）。受付・サイン端末への応答には含めない |
| ID | UUID |
| 同時更新 | 更新系は `version` を送る。合わなければ 409 `CONFLICT` |
| 二重送信 | 便の記入は `clientOpId`、締め・メール送信・freee 登録は状態と `dedupe_key` で二重に処理しない |
| 一覧の件数 | 操作履歴だけページ分け（`page`、1ページ100件）。それ以外は条件で絞り込み、上限1,000件 |
| キャッシュ | すべて `Cache-Control: no-store` |
| ファイル | API はファイルを直接返さず、署名付き URL（5分で失効）を返す |
| 版 | URL に版（v1）を入れる。互換のない変更は v2 を作る |

## 2. 認証と権限

| 項目 | 決まり |
|---|---|
| 方式 | ログインでセッションを作り、Cookie `__session` に入れる（HttpOnly・Secure・SameSite=Lax）。Firebase Hosting が転送する Cookie はこの名前だけ |
| CSRF 対策 | 更新系（POST・PATCH・PUT・DELETE）はヘッダ `X-CSRF-Token` が必須。値は `GET /auth/me` で受け取る（セッションに結びついた値） |
| 2段階の確認 | 2段階の確認を有効にした管理者は、ログイン後に `POST /auth/mfa` を通すまで他の API を使えない |
| 権限 | openapi.yaml の各操作の `x-roles` が呼び出せる区分。NestJS の Guard で確かめ、外れれば 403 `FORBIDDEN` |
| ロック | 5回続けて失敗したら15分ロック（423 `ACCOUNT_LOCKED`） |
| Cloud Scheduler | `/internal/jobs/run` は Google が発行する OIDC トークン（サービスアカウント）を検証する |
| メールサービス | `/webhooks/mail-events` はメールサービスの署名を検証する |

## 3. エラー

### 3.1 形

```json
{ "code": "TRIP_LOCKED_BY_SLIP", "message": "伝票に含まれる便は変更できません。伝票を取り消してから直してください", "details": { "slipId": "…" }, "requestId": "…" }
```

### 3.2 コードの一覧

| HTTP | code | 意味 | 主な発生箇所 |
|---|---|---|---|
| 400 | VALIDATION_ERROR | 入力の誤り（details に項目ごとの理由） | 全般 |
| 401 | UNAUTHENTICATED | ログインしていない・セッション切れ | 全般 |
| 401 | MFA_REQUIRED | 2段階の確認が済んでいない | 管理者 |
| 403 | FORBIDDEN | 利用者区分で許されない | 全般 |
| 403 | CSRF_INVALID | CSRF トークンが合わない | 更新系 |
| 404 | NOT_FOUND | 見つからない | 全般 |
| 409 | CONFLICT | version が合わない（他の人が先に変更した） | 更新系 |
| 409 | TERMINAL_BUSY | その端末に別のサイン待ちがある | 伝票をタブレットへ送る |
| 409 | SLIP_NOT_AWAITING | サイン待ちでない（取りやめ・確定済み） | サインの確定 |
| 422 | TRIP_LOCKED_BY_SLIP | 伝票に含まれる便は変えられない | 便・行の変更 |
| 422 | TRIP_LOCKED_BY_INVOICE | 送信済の請求書に含まれる便は変えられない | 便・行の変更 |
| 422 | FUTURE_TIME | 今より後の時間帯には記入できない | 便の記入 |
| 422 | ROW_HAS_TRIPS | 有効な便がある行は削除できない | 行の削除 |
| 422 | NO_TRIPS_FOR_SLIP | 伝票にする便がない | 伝票の発行 |
| 422 | SLIP_LOCKED_BY_INVOICE | 送信済の請求書に含まれる便がある伝票は取り消せない | 伝票の取消 |
| 422 | INVALID_STATE | その状態ではできない操作 | 伝票・請求書・freee |
| 422 | INVOICE_FROZEN | 送信済の請求書の内容は変えられない | 請求書 |
| 422 | PRICE_TABLE_LOCKED | 請求書に使われた単価表は変えられない | 単価表 |
| 422 | MAIL_TO_MISSING | 送付先メールがない | メール送信 |
| 422 | FREEE_NOT_CONNECTED | freee と連携していない・再連携が必要 | freee |
| 422 | FREEE_MAPPING_MISSING | 取引先・品目の対応付けがない | freee 登録 |
| 422 | FREEE_DEAL_SETTLED | freee で決済済みのため自動で変えない | 請求書の取消・再発行 |
| 423 | ACCOUNT_LOCKED | ログインのロック中 | ログイン |
| 429 | RATE_LIMITED | 短時間に操作が多すぎる（ログイン10回/分など） | ログイン・全般 |
| 500 | INTERNAL | サーバーの障害 | 全般 |
| 502 | FREEE_UPSTREAM / MAIL_UPSTREAM | freee・メールサービスの障害 | freee・メール |
| 503 | MAINTENANCE | 保守作業中 | 全般 |

DB のトリガーが返すエラー（`SF_TRIP_LOCKED_BY_SLIP` など、07 DB設計書 5章）は、API の層で同じ名前のコード（先頭の `SF_` を外したもの）に置き換えます。

## 4. 変更分の取得（日報・伝票）

1. 画面は最初に `GET /daily-reports/{date}` で全部を受け取り、応答の `cursor` を覚える。
2. 5秒ごとに `GET /daily-reports/{date}/changes?since=<cursor>` を呼び、変わった行・便と、新しい台数・cursor を受け取る。
3. cursor は「最後の更新日時と ID」を符号化した文字列で、画面は中身を解釈しない。

## 5. 操作履歴に残す操作

更新系の API はすべて、同じトランザクションの中で `audit_logs` に1件書きます（FR-CMN-04）。

| action | 対象 | 記録する値 |
|---|---|---|
| ROW_CREATE / ROW_UPDATE / ROW_DELETE / ROW_CARRY_OVER | report_row | 行の項目 |
| TRIP_CREATE / TRIP_UPDATE / TRIP_CANCEL | trip | 時刻・印・品目・車列 |
| SLIP_CREATE / SLIP_BILLING_CHANGE / SLIP_SEND / SLIP_WITHDRAW / SLIP_SIGN / SLIP_PAPER_PRINT / SLIP_PAPER_SCAN / SLIP_CANCEL | slip | 状態・請求先（変更前後）・理由 |
| BILLING_RUN / INVOICE_REBUILD / INVOICE_CONFIRM / INVOICE_UNCONFIRM / INVOICE_DATES / INVOICE_VOID / INVOICE_REISSUE | invoice | 金額・状態・理由 |
| MAIL_SEND / MAIL_RESEND / MAIL_FAILED | invoice | 宛先・件名・結果 |
| FREEE_CONNECT / FREEE_DISCONNECT / FREEE_REAUTH_REQUIRED / FREEE_MODE / FREEE_PARTNER_MAP / FREEE_PARTNER_CREATE / FREEE_ITEM_MAP / FREEE_REGISTER / FREEE_UPDATE / FREEE_DELETE | freee_registration ほか | 取引 ID・証憑 ID・結果（鍵は記録しない） |
| MASTER_CREATE / MASTER_UPDATE / MASTER_IMPORT / PRICE_TABLE_* | 各マスタ | 変更前後 |
| USER_* / SETTINGS_UPDATE / LOGIN / LOGIN_FAILED / LOGOUT | user・settings | パスワードは記録しない |

## 6. エンドポイントの一覧

openapi.yaml から作った一覧です。

### ログイン・セッション（auth）

| メソッド | パス | 内容 | 利用者区分 |
|---|---|---|---|
| POST | `/auth/login` | ログイン（FR-CMN-01） | ANY |
| POST | `/auth/mfa` | 2段階の確認コードの確認（管理者、NFR-12） | ADMIN |
| POST | `/auth/logout` | ログアウト | ANY |
| GET | `/auth/me` | ログイン中の利用者と CSRF トークン | ANY |
| POST | `/auth/password` | 自分のパスワードの変更（12文字以上） | ANY |

### 受入日報・行・便（FR-RCV）（reports）

| メソッド | パス | 内容 | 利用者区分 |
|---|---|---|---|
| GET | `/daily-reports/{date}` | 日報（行・便・台数）。なければ作る（FR-RCV-01・02・16） | RECEPTION・OFFICE・ADMIN |
| GET | `/daily-reports/{date}/changes` | 前回のカーソル以降に変わった行・便（FR-RCV-17、04 3.3） | RECEPTION・OFFICE・ADMIN |
| GET | `/daily-reports/{date}/carry-over` | 前の営業日に便があった行の一覧（FR-RCV-06） | RECEPTION・OFFICE・ADMIN |
| POST | `/daily-reports/{date}/carry-over` | 選んだ行を引き継ぐ | RECEPTION・OFFICE・ADMIN |
| GET | `/daily-reports/{date}/pdf` | 日報の PDF（RPT-01）の署名付き URL | RECEPTION・OFFICE・ADMIN |
| POST | `/report-rows` | 行の追加・車番の追加（FR-RCV-04・05）。新しい車番は vehicleNo で送ると車番マスタに登録する | RECEPTION・OFFICE・ADMIN |
| PATCH | `/report-rows/{id}` | 行の修正（FR-RCV-15）。ロックされていない便の品目を計算し直す | RECEPTION・OFFICE・ADMIN |
| DELETE | `/report-rows/{id}` | 行の削除（有効な便がある行は不可） | RECEPTION・OFFICE・ADMIN |
| POST | `/trips` | 便の記入（1行または車列）（FR-RCV-07・08・12） | RECEPTION・OFFICE・ADMIN |
| PATCH | `/trips/{id}` | 便の時刻・印の変更（FR-RCV-10・13）。applyToConvoy=true で車列の全部の便に同じ印 | RECEPTION・OFFICE・ADMIN |
| POST | `/trips/{id}/cancel` | 便の取消（記録は残る）（FR-RCV-13） | RECEPTION・OFFICE・ADMIN |

### 伝票（FR-SLP）（slips）

| メソッド | パス | 内容 | 利用者区分 |
|---|---|---|---|
| GET | `/slips` | 伝票の一覧（受付は当日、本社は期間）（FR-SLP-12） | RECEPTION・OFFICE・ADMIN |
| POST | `/slips` | 伝票の発行（FR-SLP-01〜04）。tripIds を省くとその客先・現場の未発行の便すべて | RECEPTION・OFFICE・ADMIN |
| GET | `/slips/{id}` | 伝票の詳細 | RECEPTION・OFFICE・ADMIN |
| PATCH | `/slips/{id}` | 請求先の変更（DRAFT・AWAITING_SIGNATURE のとき）（FR-SLP-04） | RECEPTION・OFFICE・ADMIN |
| POST | `/slips/{id}/send-to-terminal` | サイン用タブレットへ送る（FR-SLP-05）。terminalId を省くと利用者の対の端末 | RECEPTION・OFFICE・ADMIN |
| POST | `/slips/{id}/withdraw` | タブレットへの送信を取りやめる（FR-SGN-05） | RECEPTION・OFFICE・ADMIN |
| POST | `/slips/{id}/print-paper` | 紙伝票（サイン欄が空、RPT-04）に切り替えて印刷用の URL を返す（FR-SLP-11） | RECEPTION・OFFICE・ADMIN |
| POST | `/slips/{id}/paper-scan` | 紙伝票のスキャン PDF を登録（FR-SLP-11） | OFFICE・ADMIN |
| POST | `/slips/{id}/cancel` | 伝票の取消（理由必須）（FR-SLP-10） | RECEPTION・OFFICE・ADMIN |
| GET | `/slips/{id}/pdf` | 伝票の PDF（サイン入り RPT-02/03、紙伝票のスキャン） | RECEPTION・OFFICE・ADMIN |

### サイン端末（FR-SGN）（terminal）

| メソッド | パス | 内容 | 利用者区分 |
|---|---|---|---|
| GET | `/terminal/current-slip` | この端末に表示する伝票（なければ null）（FR-SGN-01） | SIGN_TERMINAL |
| POST | `/terminal/slips/{id}/sign` | サインの確定（FR-SGN-04） | SIGN_TERMINAL |

### 集計・状況（FR-AGG）（aggregates）

| メソッド | パス | 内容 | 利用者区分 |
|---|---|---|---|
| GET | `/dashboard` | 本社の状況（FR-AGG-01） | OFFICE・ADMIN |
| GET | `/aggregates` | 集計（FR-AGG-03、11 6章） | OFFICE・ADMIN |
| GET | `/aggregates/trips` | 集計の1行に入った便（日報・伝票・サイン・請求書へたどる）（FR-AGG-04） | OFFICE・ADMIN |
| GET | `/aggregates/export` | 集計の出力（CSV・Excel）（FR-AGG-05） | OFFICE・ADMIN |

### 締め・請求書（FR-BIL）（billing）

| メソッド | パス | 内容 | 利用者区分 |
|---|---|---|---|
| GET | `/billing/precheck` | 締めの前の確認（FR-BIL-04） | OFFICE・ADMIN |
| POST | `/billing/runs` | 締め（請求書の自動作成）（FR-BIL-03）。50件を超えるときは 202 でジョブにする | OFFICE・ADMIN |
| GET | `/billing/runs/{id}` | 締めの結果（進み具合） | OFFICE・ADMIN |
| GET | `/invoices` | 請求書の一覧・検索（請求日・金額の範囲・請求先の組合せ、02 6.3） | OFFICE・ADMIN |
| GET | `/invoices/{id}` | 請求書の詳細（明細・元の便・伝票へのリンク）（FR-BIL-10） | OFFICE・ADMIN |
| PATCH | `/invoices/{id}` | 請求日・入金期日の変更（送信前だけ）（FR-BIL-08） | OFFICE・ADMIN |
| POST | `/invoices/{id}/rebuild` | 作り直す（FR-BIL-11） | OFFICE・ADMIN |
| POST | `/invoices/{id}/confirm` | 確認済にする（FR-BIL-10） | OFFICE・ADMIN |
| POST | `/invoices/{id}/unconfirm` | 確認を取り消す | OFFICE・ADMIN |
| POST | `/invoices/{id}/void` | 取消（理由必須）。freee 登録済なら取引の削除を予約（FR-BIL-13、FR-FRE-18） | OFFICE・ADMIN |
| POST | `/invoices/{id}/reissue` | 取消して再発行（FR-BIL-13、FR-FRE-19）。新しい請求書（DRAFT）を返す | OFFICE・ADMIN |
| GET | `/invoices/{id}/pdf` | 請求書 PDF（RPT-05）の署名付き URL | OFFICE・ADMIN |

### メール送信（FR-MAL）（mail）

| メソッド | パス | 内容 | 利用者区分 |
|---|---|---|---|
| POST | `/invoices/mail-preview` | 送信前の確認（宛先・件名・本文・添付・freee の警告）（FR-MAL-02、FR-FRE-22） | OFFICE・ADMIN |
| POST | `/invoices/send` | 確認済の請求書をメール送信（FR-MAL-02） | OFFICE・ADMIN |
| POST | `/invoices/{id}/resend` | 再送（FR-MAL-05）。宛先を変えて送れる | OFFICE・ADMIN |
| GET | `/invoices/{id}/mail-logs` | 送信履歴（FR-MAL-04） | OFFICE・ADMIN |
| POST | `/webhooks/mail-events` | メールサービスからの送信結果（不達など）（FR-MAL-06）。署名を検証する | EXTERNAL |

### freee会計連携（FR-FRE）（freee）

| メソッド | パス | 内容 | 利用者区分 |
|---|---|---|---|
| GET | `/freee/connection` | 連携の状態（FR-FRE-03） | OFFICE・ADMIN |
| PATCH | `/freee/connection` | 登録のしかた・事業所の選択（FR-FRE-02・09） | ADMIN |
| DELETE | `/freee/connection` | 連携の解除（鍵を消す）（FR-FRE-04） | ADMIN |
| POST | `/freee/connection/authorize` | 連携許可を始める。freee の認可画面の URL を返す（FR-FRE-01） | ADMIN |
| GET | `/freee/oauth/callback` | freee からの戻り先。state を確かめて鍵を受け取り、SCR-41 へ戻す | ADMIN |
| GET | `/freee/companies` | 選べる事業所（連携許可で事業所が決まらなかったとき） | ADMIN |
| GET | `/freee/partners` | freee の取引先（検索） | ADMIN |
| POST | `/freee/partners` | 請求先から freee に取引先を作って対応付ける（FR-FRE-07） | ADMIN |
| GET | `/freee/partner-mappings` | 請求先と取引先の対応付けの一覧（FR-FRE-06） | OFFICE・ADMIN |
| POST | `/freee/partner-mappings/auto-match` | 名前で自動照合（09 4.3） | ADMIN |
| PUT | `/billing-parties/{id}/freee-partner` | 取引先を選び直す（null で外す） | ADMIN |
| GET | `/freee/account-items` | 勘定科目（収入のもの） | ADMIN |
| GET | `/freee/taxes` | 税区分（事業所で使えるもの。GET /api/1/taxes/companies/{company_id}） | ADMIN |
| GET | `/freee/items` | freee の品目 | ADMIN |
| PUT | `/items/{id}/freee-mapping` | 品目と勘定科目・税区分・品目の対応付け（FR-FRE-08） | ADMIN |
| GET | `/freee/registrations` | freee 登録の一覧と件数（FR-FRE-17） | OFFICE・ADMIN |
| GET | `/freee/registrations/{id}/preview` | freee に送る内容（FR-FRE-11） | OFFICE・ADMIN |
| POST | `/freee/registrations/register` | 選択分を freee へ登録（FR-FRE-12）。要対応は受け付けない | ADMIN |
| POST | `/freee/registrations/{id}/retry` | エラーの再登録（FR-FRE-16） | ADMIN |
| GET | `/freee/api-logs` | freee 登録の履歴（FR-FRE-20） | OFFICE・ADMIN |

### マスタ（FR-MST）（masters）

| メソッド | パス | 内容 | 利用者区分 |
|---|---|---|---|
| GET | `/masters/{kind}` | マスタの一覧（受付には金額・freee の項目を返さない） | RECEPTION・OFFICE・ADMIN |
| POST | `/masters/{kind}` | マスタの追加（客先を作ると同名の請求先も作る、11 3.4） | OFFICE・ADMIN |
| PATCH | `/masters/{kind}/{id}` | マスタの変更・無効化（active=false） | OFFICE・ADMIN |
| POST | `/masters/import` | CSV の一括登録（客先・現場・請求先・車番）（FR-MST-10）。dryRun=true で確認だけ | OFFICE・ADMIN |
| GET | `/price-tables` | 単価表の一覧（参考値と違う金額の印つき）（FR-MST-07） | OFFICE・ADMIN |
| POST | `/price-tables` | 新しい単価表（copyFrom の表を写して作る） | OFFICE・ADMIN |
| PUT | `/price-tables/{id}/entries` | 単価表の金額をまとめて保存（適用開始日が過ぎ、請求書に使われた表は変更不可） | OFFICE・ADMIN |

### 利用者・操作履歴・設定（FR-CMN）（admin）

| メソッド | パス | 内容 | 利用者区分 |
|---|---|---|---|
| GET | `/users` | 利用者の一覧（FR-CMN-03） | ADMIN |
| POST | `/users` | 利用者の追加（仮のパスワードを返す。次回ログインで変更） | ADMIN |
| PATCH | `/users/{id}` | 区分・対の端末・有効の変更 | ADMIN |
| POST | `/users/{id}/reset-password` | パスワードの初期化（ロックも解除） | ADMIN |
| GET | `/audit-logs` | 操作履歴（FR-CMN-04） | OFFICE・ADMIN |
| GET | `/settings` | システム設定 | OFFICE・ADMIN |
| PATCH | `/settings` | システム設定の変更（FR-CMN-05） | ADMIN |

### Cloud Scheduler からの呼び出し（internal）

| メソッド | パス | 内容 | 利用者区分 |
|---|---|---|---|
| POST | `/internal/jobs/run` | ジョブの実行（Cloud Scheduler から毎分。Google の OIDC トークンを検証） | SCHEDULER |
| GET | `/healthz` | 稼働確認（DB への接続を含む） | ANY |

## 7. 主な処理の手順

### 7.1 締め（POST /billing/runs）

1. 対象の請求先の行を `FOR UPDATE` でロックする。
2. `packages/billing` の `buildInvoices`（11 計算仕様書 4章）で請求書を作る。すでに有効な請求書がある請求先は飛ばす（作り直しは `/invoices/{id}/rebuild`）。
3. `invoice_counters` で番号を採り、`invoices`・`invoice_lines`・`invoice_trips` を書き、便の `invoice_id` を付ける。
4. `billing_runs` に結果（作成件数・問題点）を書く。
5. PDF の作成をジョブに予約する（作り終わるまで画面は「PDF作成中」）。
6. 50件を超えるときは 2〜5 をジョブで行い、202 を返す。

### 7.2 メール送信（POST /invoices/send）

1. 請求書ごとに、状態が CONFIRMED・SEND_ERROR で、PDF があり、送付先があることを確かめる。
2. 状態を SENDING にし、`mail_logs` を QUEUED で作る。
3. メールサービスへ送る（09 5章）。受け付けられたら SENT・`sent_at`、断られたら SEND_ERROR。
4. SENT になった請求書について freee 登録を作る（09 4.2：登録のしかたと対応付けで PENDING・QUEUED・NEEDS_ACTION）。
5. 後でメールサービスから不達の知らせ（webhook）が来たら、`mail_logs` を FAILED にし、請求書を SEND_ERROR にして本社の状況画面に出す（freee 登録は取り消さない。必要なら本社が請求書を取り消す）。

### 7.3 freee への登録（POST /freee/registrations/register）

09 外部インターフェイス設計書 4.4 の手順です。
