-- ============================================================
-- BLUE HERON JOGJA — ERP MVP
-- Schema + Seed Data
-- Last updated: SOT cross-check pass complete
--
-- SOT = INV_ERP_V3.xlsx (Blue Heron original Excel)
-- Items/recipes marked [SOT] came directly from the Excel.
-- Items marked [BH-EXT] were added by us for Blue Heron context
-- (Wagyu steak, burgers) and do not exist in the original Excel.
-- ============================================================


-- ============================================================
-- 1. TABLES
-- ============================================================

CREATE TABLE items (
  item_id                TEXT PRIMARY KEY,
  item_name              TEXT NOT NULL,
  category               TEXT NOT NULL CHECK (category IN ('Ingredient', 'Prep', 'Dish', 'Packaging', 'Other')),
  purchase_unit          TEXT,
  usage_unit             TEXT NOT NULL,
  -- How many usage units per purchase unit (e.g. 1 kg = 1000 gr → conversion = 1000)
  conversion             NUMERIC DEFAULT 1,
  par_level              NUMERIC DEFAULT 0,
  -- Cost override: set manually when no PO history exists or management wants to fix cost
  -- Stored per usage_unit so recipe qty × cost_override = line cost directly
  cost_override          NUMERIC DEFAULT NULL,
  cost_override_note     TEXT DEFAULT NULL,
  cost_override_updated  TIMESTAMPTZ DEFAULT NULL,
  is_active              BOOLEAN DEFAULT TRUE,
  created_at             TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE suppliers (
  supplier_id    TEXT PRIMARY KEY,
  supplier_name  TEXT NOT NULL,
  contact        TEXT,
  category       TEXT,
  payment_terms  TEXT,
  is_active      BOOLEAN DEFAULT TRUE
);

-- Two-level BOM: Ingredient → Prep, or Ingredient/Prep → Dish
-- valid_to NULL means the line is currently active
-- Soft-delete by setting valid_to = today before inserting new version
CREATE TABLE recipes (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  output_item_id  TEXT NOT NULL REFERENCES items(item_id),
  input_item_id   TEXT NOT NULL REFERENCES items(item_id),
  qty             NUMERIC NOT NULL,
  unit            TEXT NOT NULL,
  valid_from      DATE DEFAULT CURRENT_DATE,
  valid_to        DATE
);

CREATE TABLE batch_standards (
  item_id              TEXT PRIMARY KEY REFERENCES items(item_id),
  standard_yield_gram  NUMERIC NOT NULL,
  portion_gram         NUMERIC NOT NULL,
  portions_per_batch   NUMERIC GENERATED ALWAYS AS (standard_yield_gram / portion_gram) STORED
);

-- Single source of truth for all stock movements
-- source enum: OPENING | PURCHASE | PROD_OUT | PROD_USE | ADJUSTMENT | WASTE
CREATE TABLE stock_ledger (
  tx_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  date        DATE NOT NULL DEFAULT CURRENT_DATE,
  item_id     TEXT NOT NULL REFERENCES items(item_id),
  in_qty      NUMERIC NOT NULL DEFAULT 0,
  out_qty     NUMERIC NOT NULL DEFAULT 0,
  source      TEXT NOT NULL CHECK (source IN ('OPENING','PURCHASE','PROD_OUT','PROD_USE','SALE','ADJUSTMENT','WASTE')),
  ref         TEXT,
  notes       TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  created_by  TEXT DEFAULT 'system'
);

CREATE TABLE production_logs (
  batch_no            TEXT PRIMARY KEY,
  date                DATE NOT NULL DEFAULT CURRENT_DATE,
  item_id             TEXT NOT NULL REFERENCES items(item_id),
  intended_batch      NUMERIC NOT NULL DEFAULT 1,
  actual_yield_gram   NUMERIC NOT NULL,
  std_yield_gram      NUMERIC NOT NULL,
  efficiency_pct      NUMERIC GENERATED ALWAYS AS (
                        ROUND((actual_yield_gram / NULLIF(std_yield_gram,0)) * 100, 1)
                      ) STORED,
  total_portions      NUMERIC,
  notes               TEXT,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  created_by          TEXT DEFAULT 'kitchen'
);

-- Purchase unit price = price per purchase_unit (e.g. per kg, per ltr, per pcs)
-- qty_usage_unit is auto-calculated at insert: qty_purchase_unit × items.conversion
CREATE TABLE purchase_orders (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  date              DATE NOT NULL DEFAULT CURRENT_DATE,
  supplier_id       TEXT REFERENCES suppliers(supplier_id),
  item_id           TEXT NOT NULL REFERENCES items(item_id),
  qty_purchase_unit NUMERIC NOT NULL,
  qty_usage_unit    NUMERIC NOT NULL,
  unit_price        NUMERIC NOT NULL,  -- per purchase_unit
  total_cost        NUMERIC GENERATED ALWAYS AS (qty_purchase_unit * unit_price) STORED,
  ref               TEXT,
  status            TEXT DEFAULT 'received' CHECK (status IN ('draft','received')),
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  created_by        TEXT DEFAULT 'purchasing'
);


-- ============================================================
-- 2. VIEWS
-- ============================================================

CREATE OR REPLACE VIEW current_stock AS
SELECT
  i.item_id,
  i.item_name,
  i.category,
  i.usage_unit,
  i.par_level,
  COALESCE(SUM(sl.in_qty) - SUM(sl.out_qty), 0) AS stock_qty,
  CASE
    WHEN COALESCE(SUM(sl.in_qty) - SUM(sl.out_qty), 0) <= 0           THEN 'critical'
    WHEN COALESCE(SUM(sl.in_qty) - SUM(sl.out_qty), 0) <= i.par_level THEN 'low'
    ELSE 'ok'
  END AS stock_status
FROM items i
LEFT JOIN stock_ledger sl ON sl.item_id = i.item_id
WHERE i.is_active = TRUE
GROUP BY i.item_id, i.item_name, i.category, i.usage_unit, i.par_level;

CREATE OR REPLACE VIEW portion_availability AS
SELECT
  cs.item_id,
  cs.item_name,
  cs.stock_qty,
  bs.portion_gram,
  bs.standard_yield_gram,
  FLOOR(cs.stock_qty / NULLIF(bs.portion_gram, 0)) AS portions_available,
  cs.stock_status
FROM current_stock cs
JOIN batch_standards bs ON bs.item_id = cs.item_id
WHERE cs.category IN ('Prep', 'Dish');

-- Latest purchase price per item — correctly derived per usage unit
-- cost per usage unit = unit_price / conversion
-- e.g. Rp 25,000/kg ÷ 1000 = Rp 25/gr
-- Resolved cost: cost_override wins over last purchase price
CREATE OR REPLACE VIEW ingredient_cost AS
SELECT
  i.item_id,
  i.item_name,
  i.category,
  i.usage_unit,
  i.purchase_unit,
  i.conversion,
  i.cost_override,
  i.cost_override_note,
  i.cost_override_updated,
  (
    SELECT po.unit_price / NULLIF(i.conversion, 0)
    FROM purchase_orders po
    WHERE po.item_id = i.item_id AND po.status = 'received'
    ORDER BY po.date DESC LIMIT 1
  ) AS last_purchase_cost,
  (
    SELECT po.date
    FROM purchase_orders po
    WHERE po.item_id = i.item_id AND po.status = 'received'
    ORDER BY po.date DESC LIMIT 1
  ) AS last_purchase_date,
  COALESCE(
    i.cost_override,
    (
      SELECT po.unit_price / NULLIF(i.conversion, 0)
      FROM purchase_orders po
      WHERE po.item_id = i.item_id AND po.status = 'received'
      ORDER BY po.date DESC LIMIT 1
    )
  ) AS resolved_cost,
  CASE
    WHEN i.cost_override IS NOT NULL THEN 'override'
    WHEN EXISTS (
      SELECT 1 FROM purchase_orders po
      WHERE po.item_id = i.item_id AND po.status = 'received'
    ) THEN 'purchase'
    ELSE 'uncosted'
  END AS cost_source
FROM items i
WHERE i.is_active = TRUE;

-- Sales log: one row per dish per end-of-day recording
CREATE TABLE IF NOT EXISTS sales_log (
  id          TEXT PRIMARY KEY,              -- SL-YYYYMMDD-NNN
  date        DATE NOT NULL DEFAULT CURRENT_DATE,
  dish_id     TEXT NOT NULL REFERENCES items(item_id),
  qty_sold    NUMERIC NOT NULL CHECK (qty_sold > 0),
  unit_price  NUMERIC,
  notes       TEXT,
  source      TEXT NOT NULL DEFAULT 'manual'
                CHECK (source IN ('manual', 'pos')),
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  created_by  TEXT DEFAULT 'service'
);

-- Adjustments log: physical count corrections
CREATE TABLE IF NOT EXISTS adjustments_log (
  id            TEXT PRIMARY KEY,            -- ADJ-YYYYMMDD-NNN
  date          DATE NOT NULL DEFAULT CURRENT_DATE,
  item_id       TEXT NOT NULL REFERENCES items(item_id),
  system_qty    NUMERIC NOT NULL,
  physical_qty  NUMERIC NOT NULL,
  delta         NUMERIC GENERATED ALWAYS AS (physical_qty - system_qty) STORED,
  reason        TEXT NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  created_by    TEXT DEFAULT 'admin'
);

-- Sales summary: last 30 days by dish
CREATE OR REPLACE VIEW sales_summary AS
SELECT
  i.item_id,
  i.item_name,
  SUM(sl.qty_sold)  AS total_sold,
  COUNT(*)          AS sale_entries,
  MIN(sl.date)      AS first_sale,
  MAX(sl.date)      AS last_sale
FROM sales_log sl
JOIN items i ON i.item_id = sl.dish_id
WHERE sl.date >= CURRENT_DATE - INTERVAL '30 days'
GROUP BY i.item_id, i.item_name
ORDER BY total_sold DESC;

-- Ledger history: full movement log with item details
CREATE OR REPLACE VIEW ledger_history AS
SELECT
  sl.tx_id, sl.date, sl.item_id,
  i.item_name, i.category, i.usage_unit,
  sl.in_qty, sl.out_qty,
  sl.in_qty - sl.out_qty AS net_qty,
  sl.source, sl.ref, sl.notes, sl.created_by, sl.created_at
FROM stock_ledger sl
JOIN items i ON i.item_id = sl.item_id
ORDER BY sl.date DESC, sl.created_at DESC;


-- ============================================================
-- 3. SUPPLIERS
-- [SOT] Sukanda Jaya is the only supplier in the Excel.
-- [BH-EXT] SUP002–SUP004 added for Blue Heron context.
-- ============================================================

INSERT INTO suppliers (supplier_id, supplier_name, contact, category, payment_terms) VALUES
  ('SUP001', 'Sukanda Jaya',     '021-5555-0101',  'Dry Goods', 'NET 30'),
  ('SUP002', 'Wagyu Indo Prima', '0812-9999-0202', 'Protein',   'COD'),
  ('SUP003', 'Fresh Market Jkt', '0821-8888-0303', 'Produce',   'NET 14'),
  ('SUP004', 'Anchor Dairy',     '021-5555-0404',  'Dairy',     'NET 30');


-- ============================================================
-- 4. ITEMS — INGREDIENTS
--
-- IDs ING001–ING029 match the Excel SOT exactly.
-- Conversion for Cheese Slice = 12 (1 pack = 12 slices) per Excel.
-- ING030–ING037 are [BH-EXT] additions not in the original Excel.
-- ============================================================

INSERT INTO items (item_id, item_name, category, purchase_unit, usage_unit, conversion, par_level) VALUES
-- [SOT] ING001–ING029 — exact IDs and names from Excel
('ING001', 'Whip Cream',      'Ingredient', 'ltr', 'ml',  1000,  500),
('ING002', 'Fresh Milk',      'Ingredient', 'ltr', 'ml',  1000,  500),
('ING003', 'Kentang',         'Ingredient', 'kg',  'gr',  1000, 3000),
('ING004', 'Beef Powder',     'Ingredient', 'kg',  'gr',  1000,  200),
('ING005', 'Lada Hitam',      'Ingredient', 'kg',  'gr',  1000,  100),
('ING006', 'Lada Putih',      'Ingredient', 'kg',  'gr',  1000,  100),
('ING007', 'Garlic Powder',   'Ingredient', 'kg',  'gr',  1000,  100),
('ING008', 'Pala Kupas',      'Ingredient', 'kg',  'gr',  1000,   50),
('ING009', 'Cheese Mild',     'Ingredient', 'kg',  'gr',  1000,  300),
('ING010', 'Garam',           'Ingredient', 'kg',  'gr',  1000,  200),
('ING011', 'Gula Pasir',      'Ingredient', 'kg',  'gr',  1000,  300),
('ING012', 'Tepung Panir',    'Ingredient', 'kg',  'gr',  1000,  500),
('ING013', 'Yellow Mustard',  'Ingredient', 'ltr', 'ml',  1000,  300),
('ING014', 'BBQ Sauce Can',   'Ingredient', 'ltr', 'ml',  1000,  300),
('ING015', 'Telur Ayam',      'Ingredient', 'kg',  'gr',  1000,  200),
('ING016', 'Daging Giling',   'Ingredient', 'kg',  'gr',  1000, 2000),
('ING017', 'Selada Hijau',    'Ingredient', 'kg',  'gr',  1000,  500),
('ING018', 'Selada Merah',    'Ingredient', 'kg',  'gr',  1000,  500),
('ING019', 'Frisee',          'Ingredient', 'kg',  'gr',  1000,  300),
('ING020', 'Jembak',          'Ingredient', 'kg',  'gr',  1000,  500),
('ING021', 'Tomat Chery',     'Ingredient', 'kg',  'gr',  1000,  200),
('ING022', 'Tomat Besar',     'Ingredient', 'kg',  'gr',  1000,  300),
('ING023', 'Timun',           'Ingredient', 'kg',  'gr',  1000,  300),
('ING024', 'Madu',            'Ingredient', 'kg',  'gr',  1000,  300),
('ING025', 'Jeruk Nipis',     'Ingredient', 'kg',  'gr',  1000,  200),
('ING026', 'Salad Oil',       'Ingredient', 'ltr', 'ml',  1000,  500),
('ING027', 'Acar Gerkien',    'Ingredient', 'kg',  'gr',  1000,  200),
('ING028', 'Mixed Cajun',     'Ingredient', 'kg',  'gr',  1000,  200),
-- ING029: conversion = 12 per Excel (1 pack = 12 slices)
('ING029', 'Cheese Slice',    'Ingredient', 'pcs', 'pcs',   12,   24),

-- [BH-EXT] Added for Blue Heron steak & burger menu — not in original Excel
('ING030', 'Wagyu Striploin', 'Ingredient', 'kg',  'gr',  1000, 2000),
('ING031', 'Butter',          'Ingredient', 'kg',  'gr',  1000,  300),
('ING032', 'Worcestershire',  'Ingredient', 'ltr', 'ml',  1000,  200),
('ING033', 'Burger Bun',      'Ingredient', 'pcs', 'pcs',    1,   20),
('ING034', 'Bawang Bombay',   'Ingredient', 'kg',  'gr',  1000,  300);


-- ============================================================
-- 5. ITEMS — PREP COMPONENTS
--
-- PREP001–PREP006: derived from the 6 Excel menu items.
-- PREP007 (Cajun Fries) is [BH-EXT].
-- Note: "Potato Wedges" and "Home FF" from Excel map to
--   PREP001 and PREP002 respectively.
--   "Steak Fries" (PREP003) is [BH-EXT] variant.
-- ============================================================

INSERT INTO items (item_id, item_name, category, usage_unit, par_level) VALUES
('PREP001', 'Potato Wedges',       'Prep', 'gr',   500),  -- [SOT]
('PREP002', 'Home FF',             'Prep', 'gr',   800),  -- [SOT]
('PREP003', 'Mashed Potato',       'Prep', 'gr',   500),  -- [SOT]
('PREP004', 'Mixed Salad',         'Prep', 'gr',   300),  -- [SOT]
('PREP005', 'Beef Patty',          'Prep', 'pcs',   10),  -- [SOT]
('PREP006', 'Honey Lime Dressing', 'Prep', 'ml',   200),  -- [SOT]
('PREP007', 'Cajun Fries',         'Prep', 'gr',   500);  -- [BH-EXT]


-- ============================================================
-- 6. ITEMS — FINAL DISHES [BH-EXT]
-- These do not exist in the Excel. Added for Blue Heron context.
-- ============================================================

INSERT INTO items (item_id, item_name, category, usage_unit, par_level) VALUES
('DISH001', 'Wagyu Striploin Steak', 'Dish', 'portion', 5),
('DISH002', 'Classic Beef Burger',   'Dish', 'portion', 5),
('DISH003', 'Cajun Burger',          'Dish', 'portion', 5);


-- ============================================================
-- 7. RECIPES (BOM)
-- All SOT recipes use exact ingredient IDs from the Excel.
-- ============================================================

-- PREP001: Potato Wedges [SOT] — yield 1050gr
INSERT INTO recipes (output_item_id, input_item_id, qty, unit) VALUES
('PREP001', 'ING003',  1000, 'gr'),   -- Kentang
('PREP001', 'ING005',    25, 'gr'),   -- Lada Hitam
('PREP001', 'ING004',    25, 'gr');   -- Beef Powder

-- PREP002: Home FF [SOT] — yield 8100gr
INSERT INTO recipes (output_item_id, input_item_id, qty, unit) VALUES
('PREP002', 'ING003',  8000, 'gr'),   -- Kentang
('PREP002', 'ING007',    40, 'gr'),   -- Garlic Powder
('PREP002', 'ING004',    40, 'gr'),   -- Beef Powder
('PREP002', 'ING006',    10, 'gr');   -- Lada Putih

-- PREP003: Mashed Potato [SOT] — yield 1500gr
INSERT INTO recipes (output_item_id, input_item_id, qty, unit) VALUES
('PREP003', 'ING003',  1000, 'gr'),   -- Kentang
('PREP003', 'ING002',   500, 'ml'),   -- Fresh Milk
('PREP003', 'ING001',   500, 'ml'),   -- Whip Cream
('PREP003', 'ING004',    20, 'gr'),   -- Beef Powder
('PREP003', 'ING005',    10, 'gr'),   -- Lada Hitam
('PREP003', 'ING008',     5, 'gr'),   -- Pala Kupas
('PREP003', 'ING009',   100, 'gr');   -- Cheese Mild
-- NOTE: Butter NOT in Excel recipe for Mashed Potato. Removed.

-- PREP004: Mixed Salad [SOT] — yield 4600gr
INSERT INTO recipes (output_item_id, input_item_id, qty, unit) VALUES
('PREP004', 'ING017',  1000, 'gr'),   -- Selada Hijau
('PREP004', 'ING018',  1000, 'gr'),   -- Selada Merah
('PREP004', 'ING019',   500, 'gr'),   -- Frisee
('PREP004', 'ING020',  2000, 'gr'),   -- Jembak
('PREP004', 'ING021',   100, 'gr');   -- Tomat Chery

-- PREP005: Beef Patty [SOT] — yield 4430gr
-- Telur Ayam (ING015) was missing from previous build. Fixed.
INSERT INTO recipes (output_item_id, input_item_id, qty, unit) VALUES
('PREP005', 'ING016',  3000, 'gr'),   -- Daging Giling
('PREP005', 'ING013',   100, 'ml'),   -- Yellow Mustard
('PREP005', 'ING005',    15, 'gr'),   -- Lada Hitam
('PREP005', 'ING004',   100, 'gr'),   -- Beef Powder
('PREP005', 'ING015',    50, 'gr'),   -- Telur Ayam [was missing]
('PREP005', 'ING012',   500, 'gr'),   -- Tepung Panir
('PREP005', 'ING014',   200, 'ml'),   -- BBQ Sauce Can
('PREP005', 'ING011',    15, 'gr');   -- Gula Pasir

-- PREP006: Honey Lime Dressing [SOT] — yield 3800ml
INSERT INTO recipes (output_item_id, input_item_id, qty, unit) VALUES
('PREP006', 'ING013',   550, 'ml'),   -- Yellow Mustard
('PREP006', 'ING024',   600, 'gr'),   -- Madu
('PREP006', 'ING025',   250, 'gr'),   -- Jeruk Nipis
('PREP006', 'ING026',  3000, 'ml');   -- Salad Oil

-- PREP007: Cajun Fries [BH-EXT] — yield 1050gr
INSERT INTO recipes (output_item_id, input_item_id, qty, unit) VALUES
('PREP007', 'ING003',  1000, 'gr'),   -- Kentang
('PREP007', 'ING028',    50, 'gr');   -- Mixed Cajun

-- DISH001: Wagyu Striploin Steak [BH-EXT] — 1 portion
INSERT INTO recipes (output_item_id, input_item_id, qty, unit) VALUES
('DISH001', 'ING030',   200, 'gr'),   -- Wagyu Striploin
('DISH001', 'ING031',    20, 'gr'),   -- Butter
('DISH001', 'ING010',     3, 'gr'),   -- Garam
('DISH001', 'ING005',     2, 'gr'),   -- Lada Hitam
('DISH001', 'ING032',    10, 'ml'),   -- Worcestershire
('DISH001', 'PREP003',  100, 'gr'),   -- Mashed Potato
('DISH001', 'PREP001',  105, 'gr'),   -- Potato Wedges
('DISH001', 'PREP004',   92, 'gr');   -- Mixed Salad

-- DISH002: Classic Beef Burger [BH-EXT] — 1 portion
INSERT INTO recipes (output_item_id, input_item_id, qty, unit) VALUES
('DISH002', 'PREP005',    1, 'pcs'),  -- Beef Patty
('DISH002', 'ING033',     1, 'pcs'),  -- Burger Bun
('DISH002', 'ING029',     2, 'pcs'),  -- Cheese Slice
('DISH002', 'ING017',    30, 'gr'),   -- Selada Hijau
('DISH002', 'ING022',    40, 'gr'),   -- Tomat Besar
('DISH002', 'ING023',    30, 'gr'),   -- Timun
('DISH002', 'ING027',    20, 'gr'),   -- Acar Gerkien
('DISH002', 'ING013',    15, 'ml'),   -- Yellow Mustard
('DISH002', 'PREP001',  105, 'gr'),   -- Potato Wedges
('DISH002', 'PREP004',   92, 'gr');   -- Mixed Salad

-- DISH003: Cajun Burger [BH-EXT] — 1 portion
INSERT INTO recipes (output_item_id, input_item_id, qty, unit) VALUES
('DISH003', 'PREP005',    1, 'pcs'),  -- Beef Patty
('DISH003', 'ING033',     1, 'pcs'),  -- Burger Bun
('DISH003', 'ING029',     1, 'pcs'),  -- Cheese Slice
('DISH003', 'ING017',    30, 'gr'),   -- Selada Hijau
('DISH003', 'ING022',    40, 'gr'),   -- Tomat Besar
('DISH003', 'ING027',    20, 'gr'),   -- Acar Gerkien
('DISH003', 'ING028',    10, 'gr'),   -- Mixed Cajun
('DISH003', 'PREP007',  105, 'gr'),   -- Cajun Fries
('DISH003', 'PREP004',   92, 'gr');   -- Mixed Salad


-- ============================================================
-- 8. BATCH STANDARDS
-- Yields from Excel Sheet 6.
-- Beef Patty corrected to 4430gr (was 4400 in previous build).
-- Home FF added (was missing in previous build).
-- ============================================================

INSERT INTO batch_standards (item_id, standard_yield_gram, portion_gram) VALUES
('PREP001',  1050,  105),   -- Potato Wedges:       10 portions  [SOT]
('PREP002',  8100,  150),   -- Home FF:             54 portions  [SOT] — was missing
('PREP003',  1500,  100),   -- Mashed Potato:       15 portions  [SOT]
('PREP004',  4600,   92),   -- Mixed Salad:         50 portions  [SOT]
('PREP005',  4430,  100),   -- Beef Patty:       44.3 pcs        [SOT] corrected from 4400
('PREP006',  3800,  190),   -- Honey Lime Dressing: 20 portions  [SOT]
('PREP007',  1050,  105);   -- Cajun Fries:         10 portions  [BH-EXT]


-- ============================================================
-- 9. OPENING STOCK (Feb 1)
-- Quantities from Excel Sheet 3 (all 1000gr except
-- Kentang 5000gr, Tepung Panir 5000gr, Daging Giling 5000gr).
-- IDs now match corrected item master above.
-- ============================================================

INSERT INTO stock_ledger (date, item_id, in_qty, out_qty, source, ref, notes) VALUES
('2025-02-01', 'ING001',  1000, 0, 'OPENING', 'OPEN-FEB', NULL),  -- Whip Cream (ml)
('2025-02-01', 'ING002',  1000, 0, 'OPENING', 'OPEN-FEB', NULL),  -- Fresh Milk (ml)
('2025-02-01', 'ING003',  5000, 0, 'OPENING', 'OPEN-FEB', NULL),  -- Kentang (gr)
('2025-02-01', 'ING004',  1000, 0, 'OPENING', 'OPEN-FEB', NULL),  -- Beef Powder (gr)
('2025-02-01', 'ING005',  1000, 0, 'OPENING', 'OPEN-FEB', NULL),  -- Lada Hitam (gr)
('2025-02-01', 'ING006',  1000, 0, 'OPENING', 'OPEN-FEB', NULL),  -- Lada Putih (gr)
('2025-02-01', 'ING007',  1000, 0, 'OPENING', 'OPEN-FEB', NULL),  -- Garlic Powder (gr)
('2025-02-01', 'ING008',  1000, 0, 'OPENING', 'OPEN-FEB', NULL),  -- Pala Kupas (gr)
('2025-02-01', 'ING009',  1000, 0, 'OPENING', 'OPEN-FEB', NULL),  -- Cheese Mild (gr)
('2025-02-01', 'ING010',  1000, 0, 'OPENING', 'OPEN-FEB', NULL),  -- Garam (gr)
('2025-02-01', 'ING011',  1000, 0, 'OPENING', 'OPEN-FEB', NULL),  -- Gula Pasir (gr)
('2025-02-01', 'ING012',  5000, 0, 'OPENING', 'OPEN-FEB', NULL),  -- Tepung Panir (gr)
('2025-02-01', 'ING013',  1000, 0, 'OPENING', 'OPEN-FEB', NULL),  -- Yellow Mustard (ml)
('2025-02-01', 'ING014',  1000, 0, 'OPENING', 'OPEN-FEB', NULL),  -- BBQ Sauce Can (ml)
('2025-02-01', 'ING015',  1000, 0, 'OPENING', 'OPEN-FEB', NULL),  -- Telur Ayam (gr)
('2025-02-01', 'ING016',  5000, 0, 'OPENING', 'OPEN-FEB', NULL),  -- Daging Giling (gr)
('2025-02-01', 'ING017',  1000, 0, 'OPENING', 'OPEN-FEB', NULL),  -- Selada Hijau (gr)
('2025-02-01', 'ING018',  1000, 0, 'OPENING', 'OPEN-FEB', NULL),  -- Selada Merah (gr)
('2025-02-01', 'ING019',  1000, 0, 'OPENING', 'OPEN-FEB', NULL),  -- Frisee (gr)
('2025-02-01', 'ING020',  1000, 0, 'OPENING', 'OPEN-FEB', NULL),  -- Jembak (gr)
('2025-02-01', 'ING021',  1000, 0, 'OPENING', 'OPEN-FEB', NULL),  -- Tomat Chery (gr)
('2025-02-01', 'ING022',  1000, 0, 'OPENING', 'OPEN-FEB', NULL),  -- Tomat Besar (gr)
('2025-02-01', 'ING023',  1000, 0, 'OPENING', 'OPEN-FEB', NULL),  -- Timun (gr)
('2025-02-01', 'ING024',  1000, 0, 'OPENING', 'OPEN-FEB', NULL),  -- Madu (gr)
('2025-02-01', 'ING025',  1000, 0, 'OPENING', 'OPEN-FEB', NULL),  -- Jeruk Nipis (gr)
('2025-02-01', 'ING026',  1000, 0, 'OPENING', 'OPEN-FEB', NULL),  -- Salad Oil (ml)
('2025-02-01', 'ING027',  1000, 0, 'OPENING', 'OPEN-FEB', NULL),  -- Acar Gerkien (gr)
('2025-02-01', 'ING028',  1000, 0, 'OPENING', 'OPEN-FEB', NULL),  -- Mixed Cajun (gr)
('2025-02-01', 'ING029',  1000, 0, 'OPENING', 'OPEN-FEB', NULL),  -- Cheese Slice (pcs)
-- [BH-EXT] items — opening stock estimated
('2025-02-01', 'ING030',  2000, 0, 'OPENING', 'OPEN-FEB', 'Wagyu Striploin — estimated'),
('2025-02-01', 'ING031',  1000, 0, 'OPENING', 'OPEN-FEB', NULL),
('2025-02-01', 'ING032',   500, 0, 'OPENING', 'OPEN-FEB', NULL),
('2025-02-01', 'ING033',    30, 0, 'OPENING', 'OPEN-FEB', NULL),
('2025-02-01', 'ING034',   800, 0, 'OPENING', 'OPEN-FEB', NULL);

-- Prep stock at opening (estimated)
INSERT INTO stock_ledger (date, item_id, in_qty, out_qty, source, ref) VALUES
('2025-02-01', 'PREP001',  840, 0, 'OPENING', 'OPEN-FEB'),
('2025-02-01', 'PREP002',  600, 0, 'OPENING', 'OPEN-FEB'),
('2025-02-01', 'PREP003',  600, 0, 'OPENING', 'OPEN-FEB'),
('2025-02-01', 'PREP004',  460, 0, 'OPENING', 'OPEN-FEB'),
('2025-02-01', 'PREP005',   12, 0, 'OPENING', 'OPEN-FEB'),
('2025-02-01', 'PREP006',  380, 0, 'OPENING', 'OPEN-FEB'),
('2025-02-01', 'PREP007',  315, 0, 'OPENING', 'OPEN-FEB');


-- ============================================================
-- 10. PURCHASE ORDERS
-- [SOT] Only one PO exists in Excel: Feb 27, Sukanda Jaya (SUP001),
-- Daging Giling (ING016), 3kg, unit_price 270,000/kg, total 810,000.
-- Previous build had wrong supplier (SUP002). Fixed.
-- [BH-EXT] Additional POs added for realistic demo data.
-- ============================================================

INSERT INTO purchase_orders (date, supplier_id, item_id, qty_purchase_unit, qty_usage_unit, unit_price, ref, status) VALUES
-- [SOT] The one real PO from the Excel
('2025-02-27', 'SUP001', 'ING016', 3,     3000,  270000, 'PO-FEB-001', 'received'),
-- [BH-EXT] Demo POs
('2025-03-01', 'SUP002', 'ING030', 2,     2000,  450000, 'PO-MAR-001', 'received'),
('2025-03-01', 'SUP003', 'ING003', 10,   10000,   15000, 'PO-MAR-002', 'received'),
('2025-03-01', 'SUP004', 'ING001', 2,     2000,   45000, 'PO-MAR-003', 'received'),
('2025-03-01', 'SUP004', 'ING002', 2,     2000,   22000, 'PO-MAR-003', 'received'),
('2025-03-05', 'SUP001', 'ING012', 2,     2000,   28000, 'PO-MAR-004', 'received'),
('2025-03-10', 'SUP001', 'ING016', 5,     5000,   88000, 'PO-MAR-005', 'received'),
('2025-03-10', 'SUP003', 'ING017', 2,     2000,   35000, 'PO-MAR-006', 'received'),
('2025-03-10', 'SUP003', 'ING018', 2,     2000,   35000, 'PO-MAR-006', 'received');

INSERT INTO stock_ledger (date, item_id, in_qty, out_qty, source, ref) VALUES
('2025-02-27', 'ING016',  3000, 0, 'PURCHASE', 'PO-FEB-001'),
('2025-03-01', 'ING030',  2000, 0, 'PURCHASE', 'PO-MAR-001'),
('2025-03-01', 'ING003', 10000, 0, 'PURCHASE', 'PO-MAR-002'),
('2025-03-01', 'ING001',  2000, 0, 'PURCHASE', 'PO-MAR-003'),
('2025-03-01', 'ING002',  2000, 0, 'PURCHASE', 'PO-MAR-003'),
('2025-03-05', 'ING012',  2000, 0, 'PURCHASE', 'PO-MAR-004'),
('2025-03-10', 'ING016',  5000, 0, 'PURCHASE', 'PO-MAR-005'),
('2025-03-10', 'ING017',  2000, 0, 'PURCHASE', 'PO-MAR-006'),
('2025-03-10', 'ING018',  2000, 0, 'PURCHASE', 'PO-MAR-006');


-- ============================================================
-- 11. PRODUCTION LOGS
-- BK001–BK002 from Excel Sheet 8/11 (SOT).
-- BK003–BK008 are [BH-EXT] demo data.
-- Batch references updated to match corrected PREP IDs.
-- ============================================================

INSERT INTO production_logs (batch_no, date, item_id, intended_batch, actual_yield_gram, std_yield_gram, total_portions, notes, created_by) VALUES
('BK001', '2025-03-15', 'PREP003', 1,   525,  1500,   5.25, 'Low yield — milk ran short', 'kitchen'),  -- [SOT]
('BK002', '2025-03-15', 'PREP005', 2,  4400,  8860,  44,    NULL,                          'kitchen'),  -- [SOT] std = 4430×2
('BK003', '2025-03-16', 'PREP003', 2,  2950,  3000,  29.5,  NULL,                          'kitchen'),
('BK004', '2025-03-16', 'PREP001', 3,  3100,  3150,  29.5,  NULL,                          'kitchen'),
('BK005', '2025-03-17', 'PREP004', 1,  4500,  4600,  48.9,  'Slight jembak shortage',      'kitchen'),
('BK006', '2025-03-18', 'PREP005', 2,  8600,  8860,  86,    NULL,                          'kitchen'),
('BK007', '2025-03-19', 'PREP003', 1,  1480,  1500,  14.8,  NULL,                          'kitchen'),
('BK008', '2025-03-19', 'PREP001', 2,  2050,  2100,  19.5,  NULL,                          'kitchen');

-- BK001: Mashed Potato [SOT] — 35% yield
-- Ingredient usage scaled to actual/std ratio (525/1500 = 0.35)
INSERT INTO stock_ledger (date, item_id, in_qty, out_qty, source, ref) VALUES
('2025-03-15', 'PREP003',   525,    0, 'PROD_OUT', 'BK001'),
('2025-03-15', 'ING003',      0,  350, 'PROD_USE',  'BK001'),  -- Kentang 1000×0.35
('2025-03-15', 'ING002',      0,  175, 'PROD_USE',  'BK001'),  -- Fresh Milk 500×0.35
('2025-03-15', 'ING001',      0,  175, 'PROD_USE',  'BK001'),  -- Whip Cream 500×0.35
('2025-03-15', 'ING004',      0,    7, 'PROD_USE',  'BK001'),  -- Beef Powder 20×0.35
('2025-03-15', 'ING005',      0,  3.5, 'PROD_USE',  'BK001'),  -- Lada Hitam 10×0.35
('2025-03-15', 'ING008',      0, 1.75, 'PROD_USE',  'BK001'),  -- Pala Kupas 5×0.35
('2025-03-15', 'ING009',      0,   35, 'PROD_USE',  'BK001');  -- Cheese Mild 100×0.35

-- BK002: Beef Patty [SOT] — 2 batches intended, actual 4400gr out of 8860 std
-- Ratio = 4400/8860 = 0.4966
INSERT INTO stock_ledger (date, item_id, in_qty, out_qty, source, ref) VALUES
('2025-03-15', 'PREP005',    44,       0, 'PROD_OUT', 'BK002'),
('2025-03-15', 'ING016',      0,  2979.6, 'PROD_USE',  'BK002'),  -- Daging Giling 3000×2×0.4966
('2025-03-15', 'ING013',      0,    99.3, 'PROD_USE',  'BK002'),  -- Yellow Mustard 100×2×0.4966
('2025-03-15', 'ING005',      0,    14.9, 'PROD_USE',  'BK002'),  -- Lada Hitam 15×2×0.4966
('2025-03-15', 'ING004',      0,    99.3, 'PROD_USE',  'BK002'),  -- Beef Powder 100×2×0.4966
('2025-03-15', 'ING015',      0,    49.7, 'PROD_USE',  'BK002'),  -- Telur Ayam 50×2×0.4966 [was missing]
('2025-03-15', 'ING012',      0,   496.6, 'PROD_USE',  'BK002'),  -- Tepung Panir 500×2×0.4966
('2025-03-15', 'ING014',      0,   198.6, 'PROD_USE',  'BK002'),  -- BBQ Sauce 200×2×0.4966
('2025-03-15', 'ING011',      0,    14.9, 'PROD_USE',  'BK002');  -- Gula Pasir 15×2×0.4966

-- BK003–BK008 simplified ledger entries [BH-EXT demo]
INSERT INTO stock_ledger (date, item_id, in_qty, out_qty, source, ref) VALUES
('2025-03-16', 'PREP003',  2950,    0, 'PROD_OUT', 'BK003'),
('2025-03-16', 'ING003',      0, 1967, 'PROD_USE',  'BK003'),
('2025-03-16', 'ING002',      0,  983, 'PROD_USE',  'BK003'),
('2025-03-16', 'ING001',      0,  983, 'PROD_USE',  'BK003'),
('2025-03-16', 'PREP001',  3100,    0, 'PROD_OUT', 'BK004'),
('2025-03-16', 'ING003',      0, 3000, 'PROD_USE',  'BK004'),
('2025-03-17', 'PREP004',  4500,    0, 'PROD_OUT', 'BK005'),
('2025-03-17', 'ING017',      0, 1000, 'PROD_USE',  'BK005'),
('2025-03-17', 'ING018',      0, 1000, 'PROD_USE',  'BK005'),
('2025-03-17', 'ING019',      0,  500, 'PROD_USE',  'BK005'),
('2025-03-17', 'ING020',      0, 2000, 'PROD_USE',  'BK005'),
('2025-03-18', 'PREP005',    86,    0, 'PROD_OUT', 'BK006'),
('2025-03-18', 'ING016',      0, 5805, 'PROD_USE',  'BK006'),
('2025-03-19', 'PREP003',  1480,    0, 'PROD_OUT', 'BK007'),
('2025-03-19', 'ING003',      0, 1000, 'PROD_USE',  'BK007'),
('2025-03-19', 'PREP001',  2050,    0, 'PROD_OUT', 'BK008'),
('2025-03-19', 'ING003',      0, 2000, 'PROD_USE',  'BK008');


-- ============================================================
-- 12. ROW LEVEL SECURITY (enable after Supabase Auth is set up)
-- ============================================================

-- ALTER TABLE stock_ledger      ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE production_logs   ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE purchase_orders   ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE items              ENABLE ROW LEVEL SECURITY;

-- Example policies:
-- CREATE POLICY "kitchen_read_items"
--   ON items FOR SELECT USING (true);
-- CREATE POLICY "kitchen_insert_production"
--   ON production_logs FOR INSERT
--   WITH CHECK (auth.jwt() ->> 'role' = 'kitchen');
-- CREATE POLICY "purchasing_insert_po"
--   ON purchase_orders FOR INSERT
--   WITH CHECK (auth.jwt() ->> 'role' IN ('purchasing','admin'));
-- CREATE POLICY "admin_all"
--   ON items FOR ALL
--   USING (auth.jwt() ->> 'role' = 'admin');

-- ============================================================
-- VERIFY after running:
--   SELECT * FROM current_stock ORDER BY stock_status, item_name;
--   SELECT * FROM portion_availability ORDER BY item_name;
--   SELECT item_id, item_name, conversion FROM items WHERE item_id = 'ING029';
--   -- Should show Cheese Slice with conversion = 12
-- ============================================================
