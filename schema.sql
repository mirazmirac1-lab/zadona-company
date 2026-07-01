-- Zadona sales system schema

CREATE TABLE IF NOT EXISTS inventory (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  qty INTEGER NOT NULL DEFAULT 0,
  price NUMERIC(12,2) NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sales (
  id SERIAL PRIMARY KEY,
  item_id INTEGER REFERENCES inventory(id) ON DELETE SET NULL,
  item_name TEXT NOT NULL,
  qty INTEGER NOT NULL,
  total NUMERIC(12,2) NOT NULL,
  paid_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  debtor_name TEXT,
  debtor_phone TEXT,
  sale_date TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sales_debtor_name ON sales (lower(debtor_name));
CREATE INDEX IF NOT EXISTS idx_sales_date ON sales (sale_date);
