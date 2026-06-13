-- ============================================================
-- BLUE HERON — DATABASE RESET (FULL NUKE)
--
-- Wipes ALL data from the application tables while preserving:
--   - Table schemas
--   - Views (current_stock, ingredient_cost, recipe_cost, etc.)
--   - RLS policies (if enabled)
--   - Functions / triggers
--
-- After running this, the database is structurally identical to a
-- fresh `schema_and_seed.sql` run, but with zero rows in every table.
--
-- HOW TO RUN:
--   1. Open Supabase SQL Editor.
--   2. Remove the safety guard below (delete the RAISE EXCEPTION line).
--   3. Run the whole file.
--   4. Verify with the SELECT statements at the bottom.
--
-- TO RECOVER:
--   This is destructive. There is no undo. Take a Supabase backup
--   before running if you might want the data back.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- SAFETY GUARD
-- Delete or comment out this block to arm the script.
-- ------------------------------------------------------------
DO $$
BEGIN
  RAISE EXCEPTION
    'Safety guard active. Remove the RAISE EXCEPTION in reset_database.sql to run.';
END $$;


-- ------------------------------------------------------------
-- MODE FLAG
--   full_nuke = TRUE  -> wipe everything (masters + movements)
--   full_nuke = FALSE -> wipe only movement/transaction data,
--                        keep items / recipes / suppliers / standards / overrides
-- ------------------------------------------------------------
DO $$
DECLARE
  full_nuke BOOLEAN := TRUE;
BEGIN
  -- --------------------------------------------------------
  -- 1. MOVEMENT / TRANSACTION DATA (always wiped)
  --    Order: children before parents.
  -- --------------------------------------------------------
  TRUNCATE TABLE
    stock_ledger,
    production_logs,
    purchase_orders,
    sales_log,
    adjustments_log
  RESTART IDENTITY CASCADE;

  -- Optional tables used by the Calculator page.
  -- Guarded because they may not exist in every environment.
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_name = 'calculator_lines') THEN
    EXECUTE 'TRUNCATE TABLE calculator_lines RESTART IDENTITY CASCADE';
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_name = 'calculator_sessions') THEN
    EXECUTE 'TRUNCATE TABLE calculator_sessions RESTART IDENTITY CASCADE';
  END IF;

  RAISE NOTICE 'Movement data wiped.';

  -- --------------------------------------------------------
  -- 2. MASTER DATA (only if full_nuke = TRUE)
  --    Order: dependents (recipes, batch_standards) before items.
  -- --------------------------------------------------------
  IF full_nuke THEN
    TRUNCATE TABLE
      recipes,
      batch_standards,
      items,
      suppliers
    RESTART IDENTITY CASCADE;

    RAISE NOTICE 'Master data wiped. Database is now empty.';
  ELSE
    -- Movements-only mode: also clear cost overrides on items
    -- so the costing page does not show stale Rp values.
    UPDATE items
       SET cost_override = NULL,
           cost_override_note = NULL,
           cost_override_updated = NULL;

    RAISE NOTICE 'Master data preserved. Cost overrides cleared.';
  END IF;
END $$;

COMMIT;


-- ============================================================
-- VERIFY
-- Run these after the transaction commits.
-- All counts should be 0 (full nuke) or only masters non-zero
-- (movements-only mode).
-- ============================================================

SELECT 'items'            AS table_name, COUNT(*) AS row_count FROM items
UNION ALL SELECT 'suppliers',          COUNT(*) FROM suppliers
UNION ALL SELECT 'recipes',            COUNT(*) FROM recipes
UNION ALL SELECT 'batch_standards',    COUNT(*) FROM batch_standards
UNION ALL SELECT 'stock_ledger',       COUNT(*) FROM stock_ledger
UNION ALL SELECT 'production_logs',    COUNT(*) FROM production_logs
UNION ALL SELECT 'purchase_orders',    COUNT(*) FROM purchase_orders
UNION ALL SELECT 'sales_log',          COUNT(*) FROM sales_log
UNION ALL SELECT 'adjustments_log',    COUNT(*) FROM adjustments_log
ORDER BY table_name;

-- Confirm views still resolve (should return 0 rows, not error):
-- SELECT * FROM current_stock;
-- SELECT * FROM ingredient_cost;
