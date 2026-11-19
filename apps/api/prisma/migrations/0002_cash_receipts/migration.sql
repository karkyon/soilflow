-- 現金のお客さま（FR-BIL-15、設計案【回答待ち Q-29】）
-- 請求先の支払い方法が「現金」なら、伝票ごとにその場で領収書を出して受け取り、その伝票の便は月の締めの請求書に入れない。
-- settings.cash_payment_enabled が false の間は画面に出さない（今の動きを変えない）

ALTER TABLE settings ADD COLUMN cash_payment_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE billing_parties ADD COLUMN payment_method text NOT NULL DEFAULT 'INVOICE' CHECK (payment_method IN ('INVOICE','CASH'));

CREATE TABLE cash_receipt_counters (
  ym       char(4) PRIMARY KEY,                                    -- YYMM
  last_no  integer NOT NULL
);

CREATE TABLE cash_receipts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_no          text        NOT NULL UNIQUE,                 -- R-YYMM-NNN
  slip_id             uuid        NOT NULL REFERENCES slips(id),
  billing_party_id    uuid        NOT NULL REFERENCES billing_parties(id),
  receipt_date        date        NOT NULL,
  addressee_name      text        NOT NULL,                        -- 宛名（伝票の宛名。上様も可）
  lines               jsonb       NOT NULL,                        -- [{ itemName, vehicleClassName, tripCount, unitPrice, amount }]
  subtotal            bigint      NOT NULL CHECK (subtotal >= 0),
  tax_rate            smallint    NOT NULL,
  tax_rounding        text        NOT NULL CHECK (tax_rounding IN ('floor','round','ceil')),
  tax_amount          bigint      NOT NULL CHECK (tax_amount >= 0),
  total               bigint      NOT NULL CHECK (total = subtotal + tax_amount),
  received_by         uuid        NOT NULL REFERENCES users(id),
  received_at         timestamptz NOT NULL DEFAULT now(),
  pdf_object_key      text,
  pdf_sha256          text,
  status              text        NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','VOIDED')),
  void_reason         text,
  voided_at           timestamptz,
  voided_by           uuid REFERENCES users(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  version             integer     NOT NULL DEFAULT 1,
  CHECK (status <> 'VOIDED' OR (voided_at IS NOT NULL AND void_reason IS NOT NULL))
);
-- 1枚の伝票に有効な領収書は1枚だけ
CREATE UNIQUE INDEX uq_cash_receipts_slip_active ON cash_receipts (slip_id) WHERE status = 'ACTIVE';
CREATE INDEX ix_cash_receipts_date ON cash_receipts (receipt_date);
CREATE TRIGGER trg_cash_receipts_touch BEFORE UPDATE ON cash_receipts FOR EACH ROW EXECUTE FUNCTION sf_touch_updated_at();

-- 領収書の金額・明細は書き換えない（取消だけ）
CREATE OR REPLACE FUNCTION sf_cash_receipts_freeze() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.receipt_no <> OLD.receipt_no OR NEW.slip_id <> OLD.slip_id OR NEW.lines <> OLD.lines OR NEW.subtotal <> OLD.subtotal
     OR NEW.tax_amount <> OLD.tax_amount OR NEW.total <> OLD.total OR NEW.receipt_date <> OLD.receipt_date OR NEW.addressee_name <> OLD.addressee_name THEN
    RAISE EXCEPTION 'cash receipt is frozen' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status = 'VOIDED' AND NEW.status <> 'VOIDED' THEN
    RAISE EXCEPTION 'voided cash receipt cannot be restored' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_cash_receipts_freeze BEFORE UPDATE ON cash_receipts FOR EACH ROW EXECUTE FUNCTION sf_cash_receipts_freeze();
