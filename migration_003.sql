-- ============================================================
-- BLUE HERON JOGJA — Migration 003
-- Cost Management & Recipe Costing
--
-- FRESH INSTALL: run schema_and_seed.sql first, then this file.
--   schema_and_seed.sql already includes cost_override columns,
--   SALE source, corrected ingredient_cost view, sales_log,
--   adjustments_log, and ledger_history view.
--   This file adds: recipe_cost views + calculator tables + cost seeds.
--
-- UPGRADING from migration_002:
--   Uncomment the ALTER TABLE blocks in sections 1 and 2 below.
-- ============================================================


-- ============================================================
-- 1. cost_override columns on items
--    FRESH INSTALL: already in schema_and_seed.sql — skip.
--    UPGRADING: uncomment below.
-- ============================================================

-- ALTER TABLE items
--   ADD COLUMN IF NOT EXISTS cost_override         NUMERIC DEFAULT NULL,
--   ADD COLUMN IF NOT EXISTS cost_override_note    TEXT DEFAULT NULL,
--   ADD COLUMN IF NOT EXISTS cost_override_updated TIMESTAMPTZ DEFAULT NULL;


-- ============================================================
-- 2. ingredient_cost VIEW
--    FRESH INSTALL: already correct in schema_and_seed.sql — skip.
--    UPGRADING: uncomment DROP + re-paste the view from schema_and_seed.sql.
-- ============================================================

-- DROP VIEW IF EXISTS ingredient_cost;
-- (then paste the ingredient_cost view from schema_and_seed.sql)


-- ============================================================
-- 3. recipe_cost VIEW
--    Computes cost per batch and cost per portion.
--    Handles Prep items inside Dish recipes via CTE (no recursion).
--    Dish items default to portions_per_batch = 1.
-- ============================================================

CREATE OR REPLACE VIEW recipe_cost AS
WITH prep_unit_cost AS (
  SELECT
    r.output_item_id                                          AS item_id,
    SUM(r.qty * COALESCE(ic.resolved_cost, 0))
      / NULLIF(bs.standard_yield_gram, 0)                    AS cost_per_usage_unit,
    BOOL_OR(ic.resolved_cost IS NULL)                        AS has_uncosted
  FROM recipes r
  JOIN ingredient_cost ic ON ic.item_id = r.input_item_id
  JOIN batch_standards bs ON bs.item_id = r.output_item_id
  WHERE r.valid_to IS NULL
    AND ic.category = 'Ingredient'
  GROUP BY r.output_item_id, bs.standard_yield_gram
),
resolved_line_cost AS (
  SELECT
    r.id                                                      AS line_id,
    r.output_item_id,
    r.input_item_id,
    r.qty,
    r.unit,
    ic_in.item_name                                           AS input_name,
    ic_in.category                                            AS input_category,
    CASE
      WHEN ic_in.category = 'Prep'
        THEN COALESCE(puc.cost_per_usage_unit, 0)
      ELSE
        COALESCE(ic_in.resolved_cost, 0)
    END                                                       AS unit_cost,
    CASE
      WHEN ic_in.category = 'Prep'
        THEN puc.cost_per_usage_unit IS NULL
      ELSE
        ic_in.resolved_cost IS NULL
    END                                                       AS is_uncosted
  FROM recipes r
  JOIN ingredient_cost ic_in ON ic_in.item_id = r.input_item_id
  LEFT JOIN prep_unit_cost puc ON puc.item_id  = r.input_item_id
  WHERE r.valid_to IS NULL
)
SELECT
  rlc.output_item_id,
  i_out.item_name                                             AS recipe_name,
  i_out.category,
  COALESCE(bs.standard_yield_gram, 1)                        AS standard_yield_gram,
  COALESCE(bs.portion_gram, 1)                               AS portion_gram,
  COALESCE(bs.portions_per_batch, 1)                         AS portions_per_batch,
  SUM(rlc.qty * rlc.unit_cost)                               AS total_batch_cost,
  SUM(rlc.qty * rlc.unit_cost)
    / NULLIF(COALESCE(bs.portions_per_batch, 1), 0)          AS cost_per_portion,
  BOOL_OR(rlc.is_uncosted)                                   AS has_uncosted_ingredients,
  COUNT(*) FILTER (WHERE rlc.is_uncosted)                    AS uncosted_line_count,
  COUNT(*)                                                    AS total_line_count
FROM resolved_line_cost rlc
JOIN items i_out       ON i_out.item_id = rlc.output_item_id
LEFT JOIN batch_standards bs ON bs.item_id = rlc.output_item_id
GROUP BY
  rlc.output_item_id, i_out.item_name, i_out.category,
  bs.standard_yield_gram, bs.portion_gram, bs.portions_per_batch;


-- ============================================================
-- 4. recipe_cost_lines VIEW
--    Line-by-line cost breakdown for a single recipe.
--    Used by the UI recipe detail / cost breakdown panel.
-- ============================================================

CREATE OR REPLACE VIEW recipe_cost_lines AS
WITH prep_unit_cost AS (
  SELECT
    r.output_item_id                                        AS item_id,
    SUM(r.qty * COALESCE(ic.resolved_cost, 0))
      / NULLIF(bs.standard_yield_gram, 0)                  AS cost_per_usage_unit
  FROM recipes r
  JOIN ingredient_cost ic ON ic.item_id = r.input_item_id
  JOIN batch_standards bs ON bs.item_id = r.output_item_id
  WHERE r.valid_to IS NULL AND ic.category = 'Ingredient'
  GROUP BY r.output_item_id, bs.standard_yield_gram
)
SELECT
  r.output_item_id,
  r.input_item_id,
  ic_in.item_name                                           AS input_name,
  ic_in.category                                            AS input_category,
  ic_in.cost_source,
  r.qty,
  r.unit,
  CASE
    WHEN ic_in.category = 'Prep' THEN COALESCE(puc.cost_per_usage_unit, 0)
    ELSE COALESCE(ic_in.resolved_cost, 0)
  END                                                       AS unit_cost,
  r.qty * CASE
    WHEN ic_in.category = 'Prep' THEN COALESCE(puc.cost_per_usage_unit, 0)
    ELSE COALESCE(ic_in.resolved_cost, 0)
  END                                                       AS line_total,
  CASE
    WHEN ic_in.category = 'Prep' THEN puc.cost_per_usage_unit IS NULL
    ELSE ic_in.resolved_cost IS NULL
  END                                                       AS is_uncosted
FROM recipes r
JOIN ingredient_cost ic_in ON ic_in.item_id = r.input_item_id
LEFT JOIN prep_unit_cost puc ON puc.item_id  = r.input_item_id
WHERE r.valid_to IS NULL;


-- ============================================================
-- 5. CALCULATOR TABLES
--    Saved sessions — persistent, deletable.
--    item_id nullable for custom/hypothetical ingredients.
-- ============================================================

CREATE TABLE IF NOT EXISTS calculator_sessions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  notes       TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW(),
  created_by  TEXT DEFAULT 'admin'
);

CREATE TABLE IF NOT EXISTS calculator_lines (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id   UUID NOT NULL REFERENCES calculator_sessions(id) ON DELETE CASCADE,
  item_id      TEXT REFERENCES items(item_id),   -- NULL = custom ingredient
  custom_name  TEXT,                              -- used when item_id is NULL
  qty          NUMERIC NOT NULL,
  unit         TEXT NOT NULL,
  manual_cost  NUMERIC NOT NULL,                  -- Rp per usage unit, always explicit
  line_total   NUMERIC GENERATED ALWAYS AS (qty * manual_cost) STORED,
  sort_order   INT DEFAULT 0
);


-- ============================================================
-- 6. SEED cost_override for dry goods with no PO history
--    Management should update these with real prices.
-- ============================================================

UPDATE items SET
  cost_override         = 15,
  cost_override_note    = 'Estimated — no purchase history. Update with real price.',
  cost_override_updated = NOW()
WHERE item_id IN ('ING005','ING006','ING007','ING008','ING010','ING011')
  AND cost_override IS NULL;
-- ING005 Lada Hitam, ING006 Lada Putih, ING007 Garlic Powder,
-- ING008 Pala Kupas, ING010 Garam, ING011 Gula Pasir
-- All estimated at Rp 15/gr as placeholder.


-- ============================================================
-- VERIFY after running:
--   SELECT item_id, item_name, resolved_cost, cost_source
--   FROM ingredient_cost ORDER BY cost_source, item_name;
--
--   SELECT recipe_name, cost_per_portion, has_uncosted_ingredients
--   FROM recipe_cost ORDER BY category, recipe_name;
-- ============================================================
