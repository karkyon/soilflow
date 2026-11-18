-- =====================================================================
-- SoilFlow データベース定義（07 DB設計書の正本）
-- 対象：PostgreSQL 16（Cloud SQL for PostgreSQL）
-- 文字コード UTF8、照合順序 C（読みがな順は アプリで ja ロケールの比較を使う）、時刻は timestamptz で保存し日本時間で表示
-- 状態の値は CHECK 制約で持つ（ENUM 型は値の追加に手間がかかるため使わない）
-- 版 1.0（2026-11-18）
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 0. 共通
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION sf_touch_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  IF TG_OP = 'UPDATE' AND NEW.version = OLD.version THEN
    NEW.version := OLD.version + 1;
  END IF;
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------------
-- 1. 設定・利用者
-- ---------------------------------------------------------------------
CREATE TABLE settings (
  id                      smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  company_name            text        NOT NULL,                 -- 株式会社フジモト
  office_name             text        NOT NULL,                 -- 下足守事業所
  postal_code             text,
  address                 text,
  tel                     text,
  fax                     text,
  invoice_registration_no text CHECK (invoice_registration_no ~ '^T[0-9]{13}$'),  -- 登録番号（Q-07）
  bank_account_text       text,                                 -- 振込先（請求書に印字する文字列）
  invoice_note            text,                                 -- 請求書の備考の定型文
  mail_from_address       text,                                 -- Q-25
  mail_from_name          text,
  mail_reply_to           text,
  mail_subject_template   text        NOT NULL DEFAULT '【{company}】{year}年{month}月分 ご請求書（{billing_party}様）',
  mail_body_template      text        NOT NULL,
  report_first_hour       smallint    NOT NULL DEFAULT 7  CHECK (report_first_hour BETWEEN 0 AND 23),
  report_last_hour        smallint    NOT NULL DEFAULT 16 CHECK (report_last_hour BETWEEN 0 AND 23),
  tax_rate                smallint    NOT NULL DEFAULT 10 CHECK (tax_rate BETWEEN 0 AND 100),
  tax_rounding            text        NOT NULL DEFAULT 'floor' CHECK (tax_rounding IN ('floor','round','ceil')),  -- Q-06
  slip_warning_enabled    boolean     NOT NULL DEFAULT true,    -- 締めの前に伝票未発行の便を警告する（Q-31）
  updated_at              timestamptz NOT NULL DEFAULT now(),
  updated_by              uuid,
  version                 integer     NOT NULL DEFAULT 1,
  CHECK (report_first_hour <= report_last_hour)
);

CREATE TABLE users (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  login_id              text        NOT NULL UNIQUE CHECK (login_id ~ '^[a-z0-9._-]{3,40}$'),
  name                  text        NOT NULL,
  role                  text        NOT NULL CHECK (role IN ('RECEPTION','OFFICE','ADMIN','SIGN_TERMINAL')),
  email                 text,
  password_hash         text        NOT NULL,                   -- argon2id
  mfa_enabled           boolean     NOT NULL DEFAULT false,     -- 管理者のメールによる2段階の確認（NFR-12）
  paired_terminal_id    uuid REFERENCES users(id),              -- 受付の利用者 → 対になるサイン端末（FR-SGN-06）
  failed_login_count    smallint    NOT NULL DEFAULT 0,
  locked_until          timestamptz,
  password_changed_at   timestamptz NOT NULL DEFAULT now(),
  must_change_password  boolean     NOT NULL DEFAULT true,
  active                boolean     NOT NULL DEFAULT true,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  version               integer     NOT NULL DEFAULT 1,
  CHECK (paired_terminal_id IS NULL OR role IN ('RECEPTION','OFFICE','ADMIN'))
);
CREATE TRIGGER trg_users_touch BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION sf_touch_updated_at();

CREATE TABLE sessions (
  id            text PRIMARY KEY,                               -- セッション ID の SHA-256（元の値は Cookie にだけある）
  user_id       uuid        NOT NULL REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  idle_timeout  interval    NOT NULL,                           -- 受付・端末 12時間、本社・管理者 60分（NFR-13）
  mfa_passed    boolean     NOT NULL DEFAULT false,
  ip            inet,
  user_agent    text,
  revoked_at    timestamptz
);
CREATE INDEX ix_sessions_user ON sessions(user_id) WHERE revoked_at IS NULL;

CREATE TABLE mfa_codes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid        NOT NULL REFERENCES users(id),
  code_hash   text        NOT NULL,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  attempts    smallint    NOT NULL DEFAULT 0
);

-- ---------------------------------------------------------------------
-- 2. マスタ
-- ---------------------------------------------------------------------
CREATE TABLE billing_parties (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                  text        NOT NULL,
  kana                  text        NOT NULL,
  honorific             text        NOT NULL DEFAULT '御中' CHECK (honorific IN ('御中','様','殿')),
  postal_code           text CHECK (postal_code IS NULL OR postal_code ~ '^[0-9]{3}-[0-9]{4}$'),
  address               text,
  mail_to               text[]      NOT NULL DEFAULT '{}',
  mail_cc               text[]      NOT NULL DEFAULT '{}',
  closing_day           smallint    NOT NULL DEFAULT 0 CHECK (closing_day BETWEEN 0 AND 28),   -- 0＝月末（11 計算仕様書 4.1）
  payment_month_offset  smallint    NOT NULL DEFAULT 1 CHECK (payment_month_offset BETWEEN 0 AND 3),
  payment_day           smallint    NOT NULL DEFAULT 0 CHECK (payment_day BETWEEN 0 AND 31),   -- 0＝末日
  freee_partner_id      bigint,
  freee_partner_name    text,
  freee_partner_code    text,
  freee_mapping_status  text        NOT NULL DEFAULT 'UNMAPPED'
                        CHECK (freee_mapping_status IN ('UNMAPPED','AUTO','CANDIDATE','MANUAL','CREATED')),
  note                  text,
  active                boolean     NOT NULL DEFAULT true,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  version               integer     NOT NULL DEFAULT 1,
  CHECK ((freee_mapping_status IN ('UNMAPPED','CANDIDATE')) OR freee_partner_id IS NOT NULL)
);
CREATE UNIQUE INDEX ux_billing_parties_name ON billing_parties(name) WHERE active;
CREATE TRIGGER trg_billing_parties_touch BEFORE UPDATE ON billing_parties FOR EACH ROW EXECUTE FUNCTION sf_touch_updated_at();

CREATE TABLE customers (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                      text        NOT NULL,
  kana                      text        NOT NULL,
  default_billing_party_id  uuid        NOT NULL REFERENCES billing_parties(id),
  sort_order                integer     NOT NULL DEFAULT 0,
  note                      text,
  active                    boolean     NOT NULL DEFAULT true,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  version                   integer     NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX ux_customers_name ON customers(name) WHERE active;
CREATE TRIGGER trg_customers_touch BEFORE UPDATE ON customers FOR EACH ROW EXECUTE FUNCTION sf_touch_updated_at();

CREATE TABLE sites (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id               uuid        NOT NULL REFERENCES customers(id),
  name                      text        NOT NULL,
  kana                      text        NOT NULL,
  default_billing_party_id  uuid REFERENCES billing_parties(id),   -- 客先の既定より優先（ケースC）
  active                    boolean     NOT NULL DEFAULT true,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  version                   integer     NOT NULL DEFAULT 1,
  UNIQUE (id, customer_id)
);
CREATE UNIQUE INDEX ux_sites_name ON sites(customer_id, name) WHERE active;
CREATE TRIGGER trg_sites_touch BEFORE UPDATE ON sites FOR EACH ROW EXECUTE FUNCTION sf_touch_updated_at();

CREATE TABLE vehicle_classes (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name           text         NOT NULL UNIQUE,                  -- 10t・8t・6t・4t・3t・2t・1t
  capacity_m3    numeric(4,2) NOT NULL CHECK (capacity_m3 > 0),
  small_vehicle  boolean      NOT NULL DEFAULT false,           -- 4t車以下
  sort_order     integer      NOT NULL,
  active         boolean      NOT NULL DEFAULT true,
  created_at     timestamptz  NOT NULL DEFAULT now(),
  updated_at     timestamptz  NOT NULL DEFAULT now(),
  version        integer      NOT NULL DEFAULT 1
);
CREATE TRIGGER trg_vehicle_classes_touch BEFORE UPDATE ON vehicle_classes FOR EACH ROW EXECUTE FUNCTION sf_touch_updated_at();

CREATE TABLE items (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_label             text        NOT NULL,                -- 日報表記（残土・山土…）
  price_item_name          text        NOT NULL,                -- 価格表品目（建設発生土1〜2種…）
  direction                text        NOT NULL CHECK (direction IN ('RECEIVE','DELIVER')),
  price_per_m3_ref         integer CHECK (price_per_m3_ref IS NULL OR price_per_m3_ref >= 0),  -- 参考値の計算用（11 3.3）
  small_vehicle_fee_ref    integer     NOT NULL DEFAULT 0 CHECK (small_vehicle_fee_ref >= 0),
  sort_order               integer     NOT NULL,
  freee_account_item_id    bigint,
  freee_account_item_name  text,
  freee_tax_code           integer,
  freee_tax_name           text,
  freee_item_id            bigint,
  freee_item_name          text,
  active                   boolean     NOT NULL DEFAULT true,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  version                  integer     NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX ux_items_label ON items(report_label) WHERE active;
CREATE TRIGGER trg_items_touch BEFORE UPDATE ON items FOR EACH ROW EXECUTE FUNCTION sf_touch_updated_at();

CREATE TABLE vehicles (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id               uuid        NOT NULL REFERENCES customers(id),
  vehicle_no                text        NOT NULL CHECK (length(vehicle_no) BETWEEN 1 AND 20),
  default_vehicle_class_id  uuid REFERENCES vehicle_classes(id),
  active                    boolean     NOT NULL DEFAULT true,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  version                   integer     NOT NULL DEFAULT 1,
  UNIQUE (customer_id, vehicle_no),
  UNIQUE (id, customer_id)
);
CREATE TRIGGER trg_vehicles_touch BEFORE UPDATE ON vehicles FOR EACH ROW EXECUTE FUNCTION sf_touch_updated_at();

CREATE TABLE price_tables (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  effective_from  date        NOT NULL UNIQUE,
  note            text,
  created_by      uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE price_table_entries (
  price_table_id    uuid    NOT NULL REFERENCES price_tables(id) ON DELETE CASCADE,
  item_id           uuid    NOT NULL REFERENCES items(id),
  vehicle_class_id  uuid    NOT NULL REFERENCES vehicle_classes(id),
  unit_price        integer NOT NULL CHECK (unit_price >= 0),     -- 1台・税抜
  PRIMARY KEY (price_table_id, item_id, vehicle_class_id)
);

CREATE TABLE marks (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  symbol        text        NOT NULL CHECK (length(symbol) BETWEEN 1 AND 2),   -- 草・○
  display_name  text        NOT NULL,                                          -- 草根・泥
  color         text        NOT NULL CHECK (color ~ '^#[0-9a-fA-F]{6}$'),
  sort_order    integer     NOT NULL,
  active        boolean     NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  version       integer     NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX ux_marks_symbol ON marks(symbol) WHERE active;
CREATE TRIGGER trg_marks_touch BEFORE UPDATE ON marks FOR EACH ROW EXECUTE FUNCTION sf_touch_updated_at();

CREATE TABLE mark_rules (
  mark_id       uuid NOT NULL REFERENCES marks(id) ON DELETE CASCADE,
  from_item_id  uuid NOT NULL REFERENCES items(id),
  to_item_id    uuid NOT NULL REFERENCES items(id),
  PRIMARY KEY (mark_id, from_item_id),
  CHECK (from_item_id <> to_item_id)
);

-- ---------------------------------------------------------------------
-- 3. 受入日報
-- ---------------------------------------------------------------------
CREATE TABLE daily_reports (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_date  date        NOT NULL UNIQUE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, report_date)
);

CREATE TABLE report_rows (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  daily_report_id   uuid        NOT NULL REFERENCES daily_reports(id),
  customer_id       uuid        NOT NULL REFERENCES customers(id),
  site_id           uuid,
  vehicle_id        uuid        NOT NULL,
  item_id           uuid        NOT NULL REFERENCES items(id),
  vehicle_class_id  uuid        NOT NULL REFERENCES vehicle_classes(id),
  sort_order        integer     NOT NULL,
  carried_from_row_id uuid REFERENCES report_rows(id),          -- 前日の行の引継ぎ元（FR-RCV-06）
  created_by        uuid        NOT NULL REFERENCES users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz,
  version           integer     NOT NULL DEFAULT 1,
  FOREIGN KEY (site_id, customer_id)    REFERENCES sites(id, customer_id),      -- 現場はその客先のもの
  FOREIGN KEY (vehicle_id, customer_id) REFERENCES vehicles(id, customer_id)    -- 車番はその客先のもの
);
CREATE INDEX ix_report_rows_report ON report_rows(daily_report_id) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX ux_report_rows_key ON report_rows(daily_report_id, customer_id, COALESCE(site_id, '00000000-0000-0000-0000-000000000000'::uuid), vehicle_id, item_id, vehicle_class_id) WHERE deleted_at IS NULL;
CREATE TRIGGER trg_report_rows_touch BEFORE UPDATE ON report_rows FOR EACH ROW EXECUTE FUNCTION sf_touch_updated_at();

-- 伝票（trips から参照するため先に作る）
CREATE TABLE slip_counters (
  slip_date  date    PRIMARY KEY,
  last_no    integer NOT NULL
);

CREATE TABLE slips (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slip_no                  text        NOT NULL UNIQUE,          -- YYYYMMDD-NNN（FR-SLP-08、Q-10）
  slip_date                date        NOT NULL,
  customer_id              uuid        NOT NULL REFERENCES customers(id),
  site_id                  uuid,
  addressee_name           text        NOT NULL,                 -- 宛名（発行時の客先名を書き残す）
  site_name                text,
  billing_party_id         uuid        NOT NULL REFERENCES billing_parties(id),
  default_billing_party_id uuid        NOT NULL REFERENCES billing_parties(id),  -- 発行時の既定（変更の判定用）
  billing_change_reason    text,
  status                   text        NOT NULL DEFAULT 'DRAFT'
                           CHECK (status IN ('DRAFT','AWAITING_SIGNATURE','SIGNED','PAPER_PRINTED','PAPER_SIGNED','CANCELLED')),
  terminal_user_id         uuid REFERENCES users(id),
  sent_to_terminal_at      timestamptz,
  signature_object_key     text,                                 -- Cloud Storage のサイン画像（PNG）
  signer_name              text,
  signed_at                timestamptz,
  pdf_object_key           text,                                 -- フジモト様控え（RPT-03）
  pdf_sha256               text,
  paper_scan_object_key    text,                                 -- 紙伝票のスキャン（FR-SLP-11）
  paper_registered_at      timestamptz,
  paper_registered_by      uuid REFERENCES users(id),
  cancel_reason            text,
  cancelled_at             timestamptz,
  cancelled_by             uuid REFERENCES users(id),
  created_by               uuid        NOT NULL REFERENCES users(id),
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  version                  integer     NOT NULL DEFAULT 1,
  FOREIGN KEY (site_id, customer_id) REFERENCES sites(id, customer_id),
  CHECK (status <> 'SIGNED'       OR (signature_object_key IS NOT NULL AND signed_at IS NOT NULL)),
  CHECK (status <> 'PAPER_SIGNED' OR paper_scan_object_key IS NOT NULL),
  CHECK (status <> 'CANCELLED'    OR (cancel_reason IS NOT NULL AND cancelled_at IS NOT NULL))
  -- 請求先の変更の有無は billing_party_id と default_billing_party_id の比較で分かる。理由は任意（FR-SLP-04）
);
CREATE INDEX ix_slips_date ON slips(slip_date, status);
CREATE INDEX ix_slips_terminal ON slips(terminal_user_id) WHERE status = 'AWAITING_SIGNATURE';
CREATE UNIQUE INDEX ux_slips_one_awaiting_per_terminal ON slips(terminal_user_id) WHERE status = 'AWAITING_SIGNATURE';
CREATE TRIGGER trg_slips_touch BEFORE UPDATE ON slips FOR EACH ROW EXECUTE FUNCTION sf_touch_updated_at();

CREATE TABLE slip_lines (
  slip_id           uuid    NOT NULL REFERENCES slips(id) ON DELETE CASCADE,
  line_no           smallint NOT NULL,
  item_id           uuid    NOT NULL REFERENCES items(id),
  vehicle_class_id  uuid    NOT NULL REFERENCES vehicle_classes(id),
  item_label        text    NOT NULL,                            -- 例：山土（真砂土30mm）10t
  trip_count        integer NOT NULL CHECK (trip_count > 0),
  vehicle_nos       text    NOT NULL,                            -- 例：101・505・707
  PRIMARY KEY (slip_id, line_no)
);

-- 請求書（trips から参照するため先に作る）
CREATE TABLE billing_runs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_month  char(7)     NOT NULL CHECK (target_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  executed_by   uuid        NOT NULL REFERENCES users(id),
  executed_at   timestamptz NOT NULL DEFAULT now(),
  result        jsonb       NOT NULL                               -- 作成件数・問題点（11 4.6）
);

CREATE TABLE invoice_counters (
  ym       char(4) PRIMARY KEY,                                    -- YYMM
  last_no  integer NOT NULL
);

CREATE TABLE invoices (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_no            text        NOT NULL UNIQUE CHECK (invoice_no ~ '^SF-[0-9]{4}-[0-9]{3,}$'),
  billing_party_id      uuid        NOT NULL REFERENCES billing_parties(id),
  billing_run_id        uuid REFERENCES billing_runs(id),
  period_from           date        NOT NULL,
  period_to             date        NOT NULL,
  issue_date            date        NOT NULL,
  due_date              date        NOT NULL,
  billing_party_name    text        NOT NULL,                      -- 作成時の請求先を書き残す
  billing_party_honorific text      NOT NULL,
  billing_party_postal  text,
  billing_party_address text,
  subtotal              bigint      NOT NULL CHECK (subtotal >= 0),
  tax_rate              smallint    NOT NULL,
  tax_rounding          text        NOT NULL CHECK (tax_rounding IN ('floor','round','ceil')),
  tax_amount            bigint      NOT NULL CHECK (tax_amount >= 0),
  total                 bigint      NOT NULL,
  status                text        NOT NULL DEFAULT 'DRAFT'
                        CHECK (status IN ('DRAFT','NEEDS_RECHECK','CONFIRMED','SENDING','SENT','SEND_ERROR','VOIDED')),
  pdf_object_key        text,
  pdf_sha256            text,
  replaces_invoice_id   uuid REFERENCES invoices(id),              -- 取消して再発行した元の請求書
  confirmed_at          timestamptz,
  confirmed_by          uuid REFERENCES users(id),
  sent_at               timestamptz,
  void_reason           text,
  voided_at             timestamptz,
  voided_by             uuid REFERENCES users(id),
  created_by            uuid        NOT NULL REFERENCES users(id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  version               integer     NOT NULL DEFAULT 1,
  CHECK (period_from <= period_to),
  CHECK (total = subtotal + tax_amount),
  CHECK (status <> 'VOIDED' OR (void_reason IS NOT NULL AND voided_at IS NOT NULL))
);
-- 同じ請求先・同じ請求期間の有効な請求書は1件だけ
CREATE UNIQUE INDEX ux_invoices_active_period ON invoices(billing_party_id, period_from, period_to) WHERE status <> 'VOIDED';
-- 電子帳簿保存法の検索（請求日・金額・請求先）（02 6.3）
CREATE INDEX ix_invoices_search ON invoices(issue_date, total, billing_party_id);
CREATE INDEX ix_invoices_status ON invoices(status);
CREATE TRIGGER trg_invoices_touch BEFORE UPDATE ON invoices FOR EACH ROW EXECUTE FUNCTION sf_touch_updated_at();

-- 送信後は金額・明細を変えられない（真実性。状態の変更と取消の記録だけ許す）
CREATE OR REPLACE FUNCTION sf_invoices_freeze() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('SENT','SEND_ERROR','VOIDED') AND (
       NEW.invoice_no IS DISTINCT FROM OLD.invoice_no OR NEW.billing_party_id IS DISTINCT FROM OLD.billing_party_id OR
       NEW.period_from IS DISTINCT FROM OLD.period_from OR NEW.period_to IS DISTINCT FROM OLD.period_to OR
       NEW.issue_date IS DISTINCT FROM OLD.issue_date OR NEW.due_date IS DISTINCT FROM OLD.due_date OR
       NEW.subtotal IS DISTINCT FROM OLD.subtotal OR NEW.tax_amount IS DISTINCT FROM OLD.tax_amount OR
       NEW.total IS DISTINCT FROM OLD.total OR NEW.pdf_object_key IS DISTINCT FROM OLD.pdf_object_key OR
       NEW.pdf_sha256 IS DISTINCT FROM OLD.pdf_sha256) THEN
    RAISE EXCEPTION 'SF_INVOICE_FROZEN: 送信済の請求書は内容を変更できません（%）', OLD.invoice_no USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status = 'VOIDED' AND NEW.status <> 'VOIDED' THEN
    RAISE EXCEPTION 'SF_INVOICE_FROZEN: 取消した請求書は元に戻せません（%）', OLD.invoice_no USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_invoices_freeze BEFORE UPDATE ON invoices FOR EACH ROW EXECUTE FUNCTION sf_invoices_freeze();

CREATE OR REPLACE FUNCTION sf_invoices_no_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('SENT','SEND_ERROR','VOIDED') THEN
    RAISE EXCEPTION 'SF_INVOICE_FROZEN: 送信済の請求書は削除できません（%）', OLD.invoice_no USING ERRCODE = 'P0001';
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER trg_invoices_no_delete BEFORE DELETE ON invoices FOR EACH ROW EXECUTE FUNCTION sf_invoices_no_delete();

CREATE TABLE invoice_lines (
  invoice_id          uuid     NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  line_no             smallint NOT NULL,
  site_id             uuid REFERENCES sites(id),
  site_name           text,
  item_id             uuid     NOT NULL REFERENCES items(id),
  item_name           text     NOT NULL,                           -- 価格表品目名
  vehicle_class_id    uuid     NOT NULL REFERENCES vehicle_classes(id),
  vehicle_class_name  text     NOT NULL,
  unit_price          integer  NOT NULL CHECK (unit_price >= 0),
  trip_count          integer  NOT NULL CHECK (trip_count > 0),
  amount              bigint   NOT NULL,
  PRIMARY KEY (invoice_id, line_no),
  CHECK (amount = unit_price::bigint * trip_count)
);

CREATE TABLE trips (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  daily_report_id    uuid        NOT NULL,
  trip_date          date        NOT NULL,                         -- 日報の日付（検索・締めのため書き残す）
  report_row_id      uuid        NOT NULL REFERENCES report_rows(id),
  trip_time          time(0)     NOT NULL,
  mark_id            uuid REFERENCES marks(id),
  effective_item_id  uuid        NOT NULL REFERENCES items(id),    -- 印で切り替えた後の品目（11 3.1）
  convoy_id          uuid,                                         -- 車列（FR-RCV-12）
  slip_id            uuid REFERENCES slips(id),
  invoice_id         uuid REFERENCES invoices(id),                 -- 今含まれている有効な請求書（取消で外す）
  status             text        NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','CANCELLED')),
  cancel_reason      text,
  cancelled_at       timestamptz,
  cancelled_by       uuid REFERENCES users(id),
  client_op_id       uuid        NOT NULL UNIQUE,                  -- 画面の1回のクリックの ID（同じ記入を二重に保存しない）
  created_by         uuid        NOT NULL REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  version            integer     NOT NULL DEFAULT 1,
  FOREIGN KEY (daily_report_id, trip_date) REFERENCES daily_reports(id, report_date),
  CHECK (status <> 'CANCELLED' OR cancelled_at IS NOT NULL)
);
CREATE INDEX ix_trips_date ON trips(trip_date) WHERE status = 'ACTIVE';
CREATE INDEX ix_trips_row ON trips(report_row_id);
CREATE INDEX ix_trips_slip ON trips(slip_id) WHERE slip_id IS NOT NULL;
CREATE INDEX ix_trips_invoice ON trips(invoice_id) WHERE invoice_id IS NOT NULL;
CREATE INDEX ix_trips_report_updated ON trips(daily_report_id, updated_at);   -- 変更の取得（FR-RCV-17）
CREATE TRIGGER trg_trips_touch BEFORE UPDATE ON trips FOR EACH ROW EXECUTE FUNCTION sf_touch_updated_at();

-- 伝票・請求書に含まれる便は時刻・印・取消を変えられない（FR-RCV-14・FR-BIL-12）
CREATE OR REPLACE FUNCTION sf_trips_lock() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s text; i text;
BEGIN
  IF (NEW.trip_time IS DISTINCT FROM OLD.trip_time OR NEW.mark_id IS DISTINCT FROM OLD.mark_id OR
      NEW.status IS DISTINCT FROM OLD.status OR NEW.report_row_id IS DISTINCT FROM OLD.report_row_id OR
      NEW.effective_item_id IS DISTINCT FROM OLD.effective_item_id) THEN
    IF OLD.invoice_id IS NOT NULL AND NEW.invoice_id IS NOT DISTINCT FROM OLD.invoice_id THEN
      SELECT status INTO i FROM invoices WHERE id = OLD.invoice_id;
      IF i IN ('SENDING','SENT','SEND_ERROR') THEN
        RAISE EXCEPTION 'SF_TRIP_LOCKED_BY_INVOICE: 送信済の請求書に含まれる便は変更できません' USING ERRCODE = 'P0001';
      END IF;
    END IF;
    IF OLD.slip_id IS NOT NULL AND NEW.slip_id IS NOT DISTINCT FROM OLD.slip_id THEN
      SELECT status INTO s FROM slips WHERE id = OLD.slip_id;
      IF s IN ('AWAITING_SIGNATURE','SIGNED','PAPER_PRINTED','PAPER_SIGNED') THEN
        RAISE EXCEPTION 'SF_TRIP_LOCKED_BY_SLIP: 伝票に含まれる便は変更できません。伝票を取り消してから直してください' USING ERRCODE = 'P0001';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_trips_lock BEFORE UPDATE ON trips FOR EACH ROW EXECUTE FUNCTION sf_trips_lock();

CREATE TABLE invoice_trips (                                       -- 請求書に含めた便の記録（取消後も残る）
  invoice_id         uuid    NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  trip_id            uuid    NOT NULL REFERENCES trips(id),
  line_no            smallint NOT NULL,
  effective_item_id  uuid    NOT NULL REFERENCES items(id),
  unit_price         integer NOT NULL,
  PRIMARY KEY (invoice_id, trip_id)
);
CREATE INDEX ix_invoice_trips_trip ON invoice_trips(trip_id);

-- ---------------------------------------------------------------------
-- 4. メール送信
-- ---------------------------------------------------------------------
CREATE TABLE mail_logs (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id           uuid        NOT NULL REFERENCES invoices(id),
  kind                 text        NOT NULL CHECK (kind IN ('SEND','RESEND')),
  to_addresses         text[]      NOT NULL CHECK (cardinality(to_addresses) > 0),
  cc_addresses         text[]      NOT NULL DEFAULT '{}',
  subject              text        NOT NULL,
  body                 text        NOT NULL,
  attachment_name      text        NOT NULL,
  attachment_sha256    text        NOT NULL,
  provider_message_id  text,
  status               text        NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED','SENT','FAILED')),
  error_message        text,
  requested_by         uuid        NOT NULL REFERENCES users(id),
  requested_at         timestamptz NOT NULL DEFAULT now(),
  completed_at         timestamptz
);
CREATE INDEX ix_mail_logs_invoice ON mail_logs(invoice_id, requested_at DESC);

-- ---------------------------------------------------------------------
-- 5. freee 会計連携
-- ---------------------------------------------------------------------
CREATE TABLE freee_connection (
  id                       smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  status                   text        NOT NULL DEFAULT 'DISCONNECTED'
                           CHECK (status IN ('DISCONNECTED','CONNECTED','COMPANY_REQUIRED','REAUTH_REQUIRED')),
  company_id               bigint,
  company_name             text,
  authorized_freee_user    text,                                   -- 許可した人（freee のメールアドレス等）
  access_token_enc         bytea,                                  -- Cloud KMS で暗号化（NFR-14）
  refresh_token_enc        bytea,
  kms_key_version          text,
  access_token_expires_at  timestamptz,
  last_checked_at          timestamptz,
  last_error               text,
  registration_mode        text        NOT NULL DEFAULT 'REVIEW' CHECK (registration_mode IN ('REVIEW','AUTO')),
  connected_at             timestamptz,
  connected_by             uuid REFERENCES users(id),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  version                  integer     NOT NULL DEFAULT 1,
  CHECK (status <> 'CONNECTED' OR (company_id IS NOT NULL AND refresh_token_enc IS NOT NULL))
);
CREATE TRIGGER trg_freee_connection_touch BEFORE UPDATE ON freee_connection FOR EACH ROW EXECUTE FUNCTION sf_touch_updated_at();

CREATE TABLE freee_oauth_states (
  state          text PRIMARY KEY,                                  -- CSRF 対策の使い捨ての値
  code_verifier  text,                                              -- PKCE（freee の対応を確認できたら使う。Q-38）
  user_id        uuid        NOT NULL REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  used_at        timestamptz
);

CREATE TABLE freee_registrations (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id             uuid        NOT NULL UNIQUE REFERENCES invoices(id),
  action                 text        NOT NULL DEFAULT 'CREATE' CHECK (action IN ('CREATE','UPDATE','DELETE')),
  status                 text        NOT NULL
                         CHECK (status IN ('PENDING','NEEDS_ACTION','QUEUED','PROCESSING','REGISTERED','ERROR','DELETED')),
  reasons                jsonb       NOT NULL DEFAULT '[]',         -- 要対応・エラーの理由（コードと文言）
  receipt_id             bigint,                                    -- freee の証憑 ID
  deal_id                bigint,                                    -- freee の取引 ID
  update_target_deal_id  bigint,                                    -- 再発行で更新する元の取引（FR-FRE-19）
  payload                jsonb,                                     -- 最後に送った内容
  attempts               smallint    NOT NULL DEFAULT 0,
  next_attempt_at        timestamptz,
  last_error_code        text,
  last_error_message     text,
  requested_by           uuid REFERENCES users(id),
  requested_at           timestamptz,
  registered_at          timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  version                integer     NOT NULL DEFAULT 1,
  CHECK (status <> 'REGISTERED' OR (deal_id IS NOT NULL AND receipt_id IS NOT NULL))
);
CREATE INDEX ix_freee_reg_status ON freee_registrations(status);
CREATE TRIGGER trg_freee_reg_touch BEFORE UPDATE ON freee_registrations FOR EACH ROW EXECUTE FUNCTION sf_touch_updated_at();

CREATE TABLE freee_api_logs (
  id               bigserial PRIMARY KEY,
  registration_id  uuid REFERENCES freee_registrations(id),
  method           text        NOT NULL,
  path             text        NOT NULL,
  status_code      smallint,
  duration_ms      integer,
  request_summary  jsonb,                                           -- 鍵・個人情報は入れない
  response_summary jsonb,
  error            text,
  requested_by     uuid REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_freee_api_logs_reg ON freee_api_logs(registration_id, created_at);

-- ---------------------------------------------------------------------
-- 6. ジョブ（メール送信・PDF 作成・freee 登録・鍵の更新）
-- ---------------------------------------------------------------------
CREATE TABLE jobs (
  id            bigserial PRIMARY KEY,
  kind          text        NOT NULL CHECK (kind IN ('PDF_SLIP','PDF_INVOICE','MAIL_SEND','FREEE_REGISTER','FREEE_DELETE','FREEE_TOKEN_REFRESH','CLEANUP')),
  payload       jsonb       NOT NULL,
  dedupe_key    text,                                              -- 例：FREEE_REGISTER:<invoice_id>
  status        text        NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED','RUNNING','DONE','FAILED')),
  run_after     timestamptz NOT NULL DEFAULT now(),
  attempts      smallint    NOT NULL DEFAULT 0,
  max_attempts  smallint    NOT NULL DEFAULT 5,
  locked_at     timestamptz,
  locked_by     text,
  last_error    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz
);
CREATE INDEX ix_jobs_pick ON jobs(run_after) WHERE status = 'QUEUED';
CREATE UNIQUE INDEX ux_jobs_dedupe ON jobs(dedupe_key) WHERE status IN ('QUEUED','RUNNING') AND dedupe_key IS NOT NULL;

-- ---------------------------------------------------------------------
-- 7. 操作履歴（追記のみ）
-- ---------------------------------------------------------------------
CREATE TABLE audit_logs (
  id           bigserial PRIMARY KEY,
  occurred_at  timestamptz NOT NULL DEFAULT now(),
  user_id      uuid REFERENCES users(id),
  user_name    text,
  role         text,
  action       text        NOT NULL,          -- 例：TRIP_CREATE、SLIP_BILLING_CHANGE、INVOICE_VOID、FREEE_REGISTER
  target_type  text        NOT NULL,          -- 例：trip、slip、invoice、freee_registration、customer
  target_id    text,
  summary      text        NOT NULL,          -- 画面に出す一文
  before_data  jsonb,
  after_data   jsonb,
  reason       text,
  ip           inet,
  request_id   text
);
CREATE INDEX ix_audit_target ON audit_logs(target_type, target_id, occurred_at DESC);
CREATE INDEX ix_audit_time ON audit_logs(occurred_at DESC);

CREATE OR REPLACE FUNCTION sf_audit_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'SF_AUDIT_APPEND_ONLY: 操作履歴は変更・削除できません' USING ERRCODE = 'P0001';
END $$;
CREATE TRIGGER trg_audit_no_update BEFORE UPDATE OR DELETE ON audit_logs FOR EACH ROW EXECUTE FUNCTION sf_audit_append_only();

-- ---------------------------------------------------------------------
-- 8. ビュー
-- ---------------------------------------------------------------------
-- 便の請求先（11 計算仕様書 3.4）
CREATE VIEW v_trip_billing AS
SELECT t.id AS trip_id, t.trip_date, t.trip_time, t.status, t.mark_id, t.effective_item_id,
       r.customer_id, r.site_id, r.vehicle_id, r.item_id AS row_item_id, r.vehicle_class_id,
       t.slip_id, t.invoice_id,
       COALESCE(CASE WHEN s.status <> 'CANCELLED' THEN s.billing_party_id END,
                st.default_billing_party_id,
                c.default_billing_party_id) AS billing_party_id
FROM trips t
JOIN report_rows r ON r.id = t.report_row_id
JOIN customers c   ON c.id = r.customer_id
LEFT JOIN sites st ON st.id = r.site_id
LEFT JOIN slips s  ON s.id = t.slip_id;

-- 便の単価（11 計算仕様書 3.2）
CREATE VIEW v_trip_price AS
SELECT b.*, (
  SELECT e.unit_price
  FROM price_tables p
  JOIN price_table_entries e ON e.price_table_id = p.id
  WHERE p.effective_from <= b.trip_date AND e.item_id = b.effective_item_id AND e.vehicle_class_id = b.vehicle_class_id
  ORDER BY p.effective_from DESC LIMIT 1) AS unit_price
FROM v_trip_billing b;

-- ---------------------------------------------------------------------
-- 9. 権限（アプリの接続ユーザー）
-- ---------------------------------------------------------------------
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'soilflow_app') THEN
    CREATE ROLE soilflow_app NOLOGIN;
  END IF;
END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO soilflow_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO soilflow_app;
REVOKE UPDATE, DELETE, TRUNCATE ON audit_logs FROM soilflow_app;

COMMIT;
