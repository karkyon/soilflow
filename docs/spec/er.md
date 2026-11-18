# ER図

| 項目 | 内容 |
|---|---|
| 文書番号 | SF-DOC-07B |
| 版 | 1.0（2026-11-18） |
| 正本 | `spec/schema.sql`（この図は schema.sql を実際の PostgreSQL 16 に流した結果のテーブル・外部キーから作成） |

記号：`||--o{` は「1対0以上」です。線の名前は、多い側のテーブルの外部キーの列名です。

## 1. マスタ

```mermaid
erDiagram
  billing_parties ||--o{ customers : "default_billing_party_id"
  billing_parties ||--o{ sites : "default_billing_party_id"
  customers ||--o{ sites : "customer_id"
  customers ||--o{ vehicles : "customer_id"
  items ||--o{ mark_rules : "from_item_id"
  items ||--o{ mark_rules : "to_item_id"
  items ||--o{ price_table_entries : "item_id"
  marks ||--o{ mark_rules : "mark_id"
  price_tables ||--o{ price_table_entries : "price_table_id"
  vehicle_classes ||--o{ price_table_entries : "vehicle_class_id"
  vehicle_classes ||--o{ vehicles : "default_vehicle_class_id"
  billing_parties {
    uuid id PK
    text name
    smallint closing_day
    smallint payment_month_offset
    smallint payment_day
    bigint freee_partner_id
  }
  customers {
    uuid id PK
    text name
    uuid default_billing_party_id FK
  }
  sites {
    uuid id PK
    uuid customer_id FK
    text name
    uuid default_billing_party_id FK
  }
  vehicles {
    uuid id PK
    uuid customer_id FK
    text vehicle_no
  }
  items {
    uuid id PK
    text report_label
    text price_item_name
    text direction
    bigint freee_account_item_id
    int freee_tax_code
  }
  vehicle_classes {
    uuid id PK
    text name
    numeric capacity_m3
  }
  price_tables {
    uuid id PK
    date effective_from
  }
  price_table_entries {
    uuid price_table_id PK
    uuid item_id PK
    uuid vehicle_class_id PK
    int unit_price
  }
  marks {
    uuid id PK
    text symbol
  }
  mark_rules {
    uuid mark_id PK
    uuid from_item_id PK
    uuid to_item_id FK
  }
```

## 2. 受入日報・伝票

```mermaid
erDiagram
  billing_parties ||--o{ slips : "billing_party_id"
  billing_parties ||--o{ slips : "default_billing_party_id"
  customers ||--o{ report_rows : "customer_id"
  customers ||--o{ slips : "customer_id"
  daily_reports ||--o{ report_rows : "daily_report_id"
  daily_reports ||--o{ trips : "daily_report_id"
  daily_reports ||--o{ trips : "trip_date"
  items ||--o{ report_rows : "item_id"
  items ||--o{ slip_lines : "item_id"
  items ||--o{ trips : "effective_item_id"
  marks ||--o{ trips : "mark_id"
  report_rows ||--o{ report_rows : "carried_from_row_id"
  report_rows ||--o{ trips : "report_row_id"
  sites ||--o{ report_rows : "customer_id"
  sites ||--o{ report_rows : "site_id"
  sites ||--o{ slips : "customer_id"
  sites ||--o{ slips : "site_id"
  slips ||--o{ slip_lines : "slip_id"
  slips ||--o{ trips : "slip_id"
  vehicle_classes ||--o{ report_rows : "vehicle_class_id"
  vehicle_classes ||--o{ slip_lines : "vehicle_class_id"
  vehicles ||--o{ report_rows : "customer_id"
  vehicles ||--o{ report_rows : "vehicle_id"
  daily_reports {
    uuid id PK
    date report_date
  }
  report_rows {
    uuid id PK
    uuid customer_id FK
    uuid site_id FK
    uuid vehicle_id FK
    uuid item_id FK
    uuid vehicle_class_id FK
  }
  trips {
    uuid id PK
    date trip_date
    time trip_time
    uuid mark_id FK
    uuid effective_item_id FK
    uuid convoy_id
    uuid slip_id FK
    uuid invoice_id FK
    text status
  }
  slips {
    uuid id PK
    text slip_no
    uuid billing_party_id FK
    text status
    text signature_object_key
    text pdf_object_key
  }
  slip_lines {
    uuid slip_id PK
    smallint line_no PK
    int trip_count
  }
```

## 3. 請求・メール・freee

```mermaid
erDiagram
  billing_parties ||--o{ invoices : "billing_party_id"
  billing_runs ||--o{ invoices : "billing_run_id"
  invoices ||--o{ freee_registrations : "invoice_id"
  invoices ||--o{ invoice_lines : "invoice_id"
  invoices ||--o{ invoice_trips : "invoice_id"
  invoices ||--o{ invoices : "replaces_invoice_id"
  invoices ||--o{ mail_logs : "invoice_id"
  invoices ||--o{ trips : "invoice_id"
  items ||--o{ invoice_lines : "item_id"
  items ||--o{ invoice_trips : "effective_item_id"
  sites ||--o{ invoice_lines : "site_id"
  trips ||--o{ invoice_trips : "trip_id"
  vehicle_classes ||--o{ invoice_lines : "vehicle_class_id"
  billing_runs {
    uuid id PK
    char target_month
  }
  invoices {
    uuid id PK
    text invoice_no
    uuid billing_party_id FK
    date period_from
    date period_to
    bigint total
    text status
    uuid replaces_invoice_id FK
  }
  invoice_lines {
    uuid invoice_id PK
    smallint line_no PK
    int unit_price
    int trip_count
    bigint amount
  }
  invoice_trips {
    uuid invoice_id PK
    uuid trip_id PK
    int unit_price
  }
  mail_logs {
    uuid id PK
    uuid invoice_id FK
    text kind
    text status
  }
  freee_registrations {
    uuid id PK
    uuid invoice_id FK
    text status
    bigint receipt_id
    bigint deal_id
  }
```

## 4. 利用者への参照（作成者・確認者など）

```mermaid
erDiagram
  users ||--o{ audit_logs : "user_id"
  users ||--o{ billing_runs : "executed_by"
  users ||--o{ freee_api_logs : "requested_by"
  users ||--o{ freee_connection : "connected_by"
  users ||--o{ freee_oauth_states : "user_id"
  users ||--o{ freee_registrations : "requested_by"
  users ||--o{ invoices : "confirmed_by"
  users ||--o{ invoices : "created_by"
  users ||--o{ invoices : "voided_by"
  users ||--o{ mail_logs : "requested_by"
  users ||--o{ mfa_codes : "user_id"
  users ||--o{ price_tables : "created_by"
  users ||--o{ report_rows : "created_by"
  users ||--o{ sessions : "user_id"
  users ||--o{ slips : "cancelled_by"
  users ||--o{ slips : "created_by"
  users ||--o{ slips : "paper_registered_by"
  users ||--o{ slips : "terminal_user_id"
  users ||--o{ trips : "cancelled_by"
  users ||--o{ trips : "created_by"
  users ||--o{ users : "paired_terminal_id"
```

## 5. 全体（参考）

```mermaid
erDiagram
  billing_parties ||--o{ customers : "default_billing_party_id"
  billing_parties ||--o{ invoices : "billing_party_id"
  billing_parties ||--o{ sites : "default_billing_party_id"
  billing_parties ||--o{ slips : "billing_party_id"
  billing_parties ||--o{ slips : "default_billing_party_id"
  billing_runs ||--o{ invoices : "billing_run_id"
  customers ||--o{ report_rows : "customer_id"
  customers ||--o{ sites : "customer_id"
  customers ||--o{ slips : "customer_id"
  customers ||--o{ vehicles : "customer_id"
  daily_reports ||--o{ report_rows : "daily_report_id"
  daily_reports ||--o{ trips : "daily_report_id"
  daily_reports ||--o{ trips : "trip_date"
  invoices ||--o{ freee_registrations : "invoice_id"
  invoices ||--o{ invoice_lines : "invoice_id"
  invoices ||--o{ invoice_trips : "invoice_id"
  invoices ||--o{ invoices : "replaces_invoice_id"
  invoices ||--o{ mail_logs : "invoice_id"
  invoices ||--o{ trips : "invoice_id"
  items ||--o{ invoice_lines : "item_id"
  items ||--o{ invoice_trips : "effective_item_id"
  items ||--o{ mark_rules : "from_item_id"
  items ||--o{ mark_rules : "to_item_id"
  items ||--o{ price_table_entries : "item_id"
  items ||--o{ report_rows : "item_id"
  items ||--o{ slip_lines : "item_id"
  items ||--o{ trips : "effective_item_id"
  marks ||--o{ mark_rules : "mark_id"
  marks ||--o{ trips : "mark_id"
  price_tables ||--o{ price_table_entries : "price_table_id"
  report_rows ||--o{ report_rows : "carried_from_row_id"
  report_rows ||--o{ trips : "report_row_id"
  sites ||--o{ invoice_lines : "site_id"
  sites ||--o{ report_rows : "customer_id"
  sites ||--o{ report_rows : "site_id"
  sites ||--o{ slips : "customer_id"
  sites ||--o{ slips : "site_id"
  slips ||--o{ slip_lines : "slip_id"
  slips ||--o{ trips : "slip_id"
  trips ||--o{ invoice_trips : "trip_id"
  vehicle_classes ||--o{ invoice_lines : "vehicle_class_id"
  vehicle_classes ||--o{ price_table_entries : "vehicle_class_id"
  vehicle_classes ||--o{ report_rows : "vehicle_class_id"
  vehicle_classes ||--o{ slip_lines : "vehicle_class_id"
  vehicle_classes ||--o{ vehicles : "default_vehicle_class_id"
  vehicles ||--o{ report_rows : "customer_id"
  vehicles ||--o{ report_rows : "vehicle_id"
  billing_parties {
    uuid id PK
    text name
    smallint closing_day
    smallint payment_month_offset
    smallint payment_day
    bigint freee_partner_id
  }
  customers {
    uuid id PK
    text name
    uuid default_billing_party_id FK
  }
  sites {
    uuid id PK
    uuid customer_id FK
    text name
    uuid default_billing_party_id FK
  }
  vehicles {
    uuid id PK
    uuid customer_id FK
    text vehicle_no
  }
  items {
    uuid id PK
    text report_label
    text price_item_name
    text direction
    bigint freee_account_item_id
    int freee_tax_code
  }
  vehicle_classes {
    uuid id PK
    text name
    numeric capacity_m3
  }
  price_tables {
    uuid id PK
    date effective_from
  }
  price_table_entries {
    uuid price_table_id PK
    uuid item_id PK
    uuid vehicle_class_id PK
    int unit_price
  }
  marks {
    uuid id PK
    text symbol
  }
  mark_rules {
    uuid mark_id PK
    uuid from_item_id PK
    uuid to_item_id FK
  }
  daily_reports {
    uuid id PK
    date report_date
  }
  report_rows {
    uuid id PK
    uuid customer_id FK
    uuid site_id FK
    uuid vehicle_id FK
    uuid item_id FK
    uuid vehicle_class_id FK
  }
  trips {
    uuid id PK
    date trip_date
    time trip_time
    uuid mark_id FK
    uuid effective_item_id FK
    uuid convoy_id
    uuid slip_id FK
    uuid invoice_id FK
    text status
  }
  slips {
    uuid id PK
    text slip_no
    uuid billing_party_id FK
    text status
    text signature_object_key
    text pdf_object_key
  }
  slip_lines {
    uuid slip_id PK
    smallint line_no PK
    int trip_count
  }
  invoices {
    uuid id PK
    text invoice_no
    uuid billing_party_id FK
    date period_from
    date period_to
    bigint total
    text status
    uuid replaces_invoice_id FK
  }
  invoice_lines {
    uuid invoice_id PK
    smallint line_no PK
    int unit_price
    int trip_count
    bigint amount
  }
  invoice_trips {
    uuid invoice_id PK
    uuid trip_id PK
    int unit_price
  }
  billing_runs {
    uuid id PK
    char target_month
  }
  mail_logs {
    uuid id PK
    uuid invoice_id FK
    text kind
    text status
  }
  freee_registrations {
    uuid id PK
    uuid invoice_id FK
    text status
    bigint receipt_id
    bigint deal_id
  }
```
