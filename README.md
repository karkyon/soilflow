# SoilFlow 受入・請求管理システム

株式会社フジモト 下足守事業所向けの、受入日報のデジタル化・伝票の電子サイン・月次請求・請求書メール送信・freee会計連携のシステムです（freee会計連携あり版、提案番号 SF-2026-11-F）。

- 技術構成：Next.js ＋ NestJS ＋ PostgreSQL、Google Cloud（Cloud Run・Cloud SQL・Cloud Storage）
- 本稼働：2027年3月上旬（予定）

## 資料

最初に [`docs/00_資料体系・読み方ガイド.md`](docs/00_資料体系・読み方ガイド.md) を読んでください。

| 資料 | ファイル |
|---|---|
| 00 資料体系・読み方ガイド | [docs/00_資料体系・読み方ガイド.md](docs/00_資料体系・読み方ガイド.md) |
| 01 用語定義書 | [docs/01_用語定義書.md](docs/01_用語定義書.md) |
| 02 要件定義書 | [docs/02_要件定義書.md](docs/02_要件定義書.md) |
| 03 業務フロー図 | [docs/03_業務フロー図.md](docs/03_業務フロー図.md) |
| 04 基本設計書 | [docs/04_基本設計書.md](docs/04_基本設計書.md) |
| 05 画面設計書（外部設計） | [docs/05_画面設計書.md](docs/05_画面設計書.md) |
| 06 試作画面（HTML） | [docs/mockup/SoilFlow_試作画面.html](docs/mockup/SoilFlow_試作画面.html) |
| 06 ご説明資料（HTML） | [docs/mockup/SoilFlow_ご説明資料.html](docs/mockup/SoilFlow_ご説明資料.html) |
| 07 DB設計書 | [docs/07_DB設計書.md](docs/07_DB設計書.md) |
| 07 DDL・初期データ・ER図 | [docs/spec/schema.sql](docs/spec/schema.sql) |
| 08 API設計書 | [docs/08_API設計書.md](docs/08_API設計書.md) |
| 08 API 契約（openapi.yaml） | [docs/spec/openapi.yaml](docs/spec/openapi.yaml) |
| 09 外部インターフェイス設計書 | [docs/09_外部インターフェイス設計書.md](docs/09_外部インターフェイス設計書.md) |
| 10 帳票設計書 | [docs/10_帳票設計書.md](docs/10_帳票設計書.md) |
| 11 計算仕様書 | [docs/11_計算仕様書.md](docs/11_計算仕様書.md) |
| 11 正解データ | [docs/spec/billing-golden.json](docs/spec/billing-golden.json) |
| 12 環境・インフラ・ネットワーク設計書 | [docs/12_環境・インフラ・ネットワーク設計書.md](docs/12_環境・インフラ・ネットワーク設計書.md) |
| 13 セキュリティ設計書 | [docs/13_セキュリティ設計書.md](docs/13_セキュリティ設計書.md) |
| 14 開発標準・技術スタック | [docs/14_開発標準・技術スタック.md](docs/14_開発標準・技術スタック.md) |
| 15 テスト計画書 | [docs/15_テスト計画書.md](docs/15_テスト計画書.md) |
| 16 移行・導入計画書 | [docs/16_移行・導入計画書.md](docs/16_移行・導入計画書.md) |
| 17 運用・保守手順書 | [docs/17_運用・保守手順書.md](docs/17_運用・保守手順書.md) |
| 18 WBS・開発スケジュール | [docs/18_WBS・開発スケジュール.md](docs/18_WBS・開発スケジュール.md) |
| 19 未決事項・変更管理台帳 | [docs/ledger/19_未決事項・変更管理台帳.md](docs/ledger/19_未決事項・変更管理台帳.md) |
| 19 トレーサビリティ表 | [docs/ledger/19_トレーサビリティ表.md](docs/ledger/19_トレーサビリティ表.md) |
| Word 版（全資料） | [docs/word/](docs/word/) |

## ディレクトリ構成（予定）

```
soilflow/
├─ docs/            資料（この README から辿る）
│  ├─ ledger/       台帳
│  ├─ reference/    価格表の転記・マスタの CSV ひな形
│  ├─ spec/         openapi.yaml・schema.sql・seed.sql・er.md・billing-golden.json
│  ├─ mockup/       試作画面・ご説明資料・画面の写真
│  └─ word/         全資料の Word 版
├─ apps/
│  ├─ web/          Next.js（受付・タブレット・本社の画面）
│  └─ api/          NestJS（API・ジョブ。実装済み・試験済み）
├─ packages/
│  ├─ billing/      請求計算（billing.js・billing.test.js。実装済み・試験済み）
│  └─ pdf/          帳票（pdfmake。日報・伝票・請求書）
├─ infra/           Terraform（GCP の構成）
└─ tools/           資料の Word 版を作るスクリプト
```

## 開発環境の起動

```bash
docker compose up -d db          # PostgreSQL 16
pnpm install
pnpm --filter api migrate && pnpm --filter api seed   # 初期の管理者（SEED_ADMIN_* 未設定なら仮パスワードを表示）
pnpm --filter api dev            # API  http://localhost:4000/api/v1
pnpm --filter web dev            # 画面 http://localhost:3000 （/api は API へ転送）
```

- 受付（PC）`/reception/`　サイン用タブレット `/terminal/`　本社 `/office/`
- `ADAPTERS=fake` で freee・メール・保存先をローカルの代わりの実装で動かします
- 本番の画面は `pnpm --filter web build` で `apps/web/out` に静的に出力します
