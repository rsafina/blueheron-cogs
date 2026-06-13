// ============================================================
// BLUE HERON — Supabase client + data layer
// All DB calls live here so app.js stays clean
// ============================================================

// Load Supabase from CDN (injected via script tag or imported)
// We do a dynamic load so the page doesn't break without credentials

let _supabase = null;

async function initSupabase() {
  if (!SUPABASE_CONFIGURED) return null;
  if (_supabase) return _supabase;

  // Dynamically load the Supabase JS SDK
  if (!window.supabase) {
    await new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src =
        "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js";
      s.onload = resolve;
      s.onerror = reject;
      document.head.appendChild(s);
    });
  }

  _supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON);
  return _supabase;
}

// ── DATA FUNCTIONS ──────────────────────────────────────────

async function fetchCurrentStock() {
  const db = await initSupabase();
  if (!db) return getMockStock();

  const { data, error } = await db
    .from("current_stock")
    .select("*")
    .order("stock_status")
    .order("item_name");

  if (error) {
    console.error(error);
    return getMockStock();
  }
  return data;
}

async function fetchPortionAvailability() {
  const db = await initSupabase();
  if (!db) return getMockPortions();

  const { data, error } = await db
    .from("portion_availability")
    .select("*")
    .order("item_name");

  if (error) {
    console.error(error);
    return getMockPortions();
  }
  return data;
}

async function fetchProductionLogs() {
  const db = await initSupabase();
  if (!db) return getMockProduction();

  const { data, error } = await db
    .from("production_logs")
    .select("*, items(item_name)")
    .order("date", { ascending: false })
    .limit(30);

  if (error) {
    console.error(error);
    return getMockProduction();
  }
  return data;
}

async function fetchPrepItems() {
  const db = await initSupabase();
  if (!db) return getMockPrepItems();

  const { data, error } = await db
    .from("items")
    .select("item_id, item_name, category")
    .in("category", ["Prep"])
    .eq("is_active", true)
    .order("item_name");

  if (error) {
    console.error(error);
    return getMockPrepItems();
  }
  return data;
}

async function fetchIngredientItems() {
  const db = await initSupabase();
  if (!db) return getMockIngredients();

  const { data, error } = await db
    .from("items")
    .select("item_id, item_name, purchase_unit, usage_unit, conversion")
    .eq("category", "Ingredient")
    .eq("is_active", true)
    .order("item_name");

  if (error) {
    console.error(error);
    return getMockIngredients();
  }
  return data;
}

async function fetchSuppliers() {
  const db = await initSupabase();
  if (!db) return getMockSuppliers();

  const { data, error } = await db
    .from("suppliers")
    .select("supplier_id, supplier_name")
    .eq("is_active", true)
    .order("supplier_name");

  if (error) {
    console.error(error);
    return getMockSuppliers();
  }
  return data;
}

async function fetchBatchStandard(itemId) {
  const db = await initSupabase();
  if (!db) {
    const mock = getMockBatchStandards();
    return mock.find((b) => b.item_id === itemId) || null;
  }

  const { data, error } = await db
    .from("batch_standards")
    .select("*")
    .eq("item_id", itemId)
    .single();

  if (error) return null;
  return data;
}

async function fetchPurchaseHistory() {
  const db = await initSupabase();
  if (!db) return getMockPurchases();

  const { data, error } = await db
    .from("purchase_orders")
    .select("*, items(item_name, purchase_unit), suppliers(supplier_name)")
    .order("date", { ascending: false })
    .limit(30);

  if (error) {
    console.error(error);
    return getMockPurchases();
  }
  return data;
}

async function insertProductionLog(log) {
  const db = await initSupabase();
  if (!db) return { error: "Supabase not configured" };

  // 1. Insert production log
  const { data: logData, error: logErr } = await db
    .from("production_logs")
    .insert(log)
    .select()
    .single();

  if (logErr) return { error: logErr.message };

  // 2. Fetch item to determine usage_unit
  const { data: itemData } = await db
    .from("items")
    .select("usage_unit")
    .eq("item_id", log.item_id)
    .single();

  const usageUnit = itemData?.usage_unit || "gr";

  // 3. PROD_OUT: write in the item's usage unit
  //    For gram-based preps: in_qty = actual_yield_gram
  //    For pcs-based preps (Beef Patty): in_qty = total_portions (pcs produced)
  const prodOutQty =
    usageUnit === "pcs" ? log.total_portions : log.actual_yield_gram;

  const ratio = log.actual_yield_gram / log.std_yield_gram;

  const ledgerRows = [
    {
      date: log.date,
      item_id: log.item_id,
      in_qty: prodOutQty,
      out_qty: 0,
      source: "PROD_OUT",
      ref: log.batch_no,
      notes: `${log.total_portions} ${usageUnit} produced`,
      created_by: log.created_by || "kitchen",
    },
  ];

  // 4. Fetch active recipe lines and build PROD_USE rows
  //    Deduct exactly one level: ingredients in this recipe only.
  //    (Prep items in a dish recipe are deducted at service time, not here.)
  const { data: recipe } = await db
    .from("recipes")
    .select(
      "input_item_id, qty, unit, items!recipes_input_item_id_fkey(item_name)",
    )
    .eq("output_item_id", log.item_id)
    .is("valid_to", null);

  if (recipe) {
    for (const r of recipe) {
      const deductQty = parseFloat(
        (r.qty * log.intended_batch * ratio).toFixed(2),
      );
      ledgerRows.push({
        date: log.date,
        item_id: r.input_item_id,
        in_qty: 0,
        out_qty: deductQty,
        source: "PROD_USE",
        ref: log.batch_no,
        notes: `${r.items?.item_name || r.input_item_id} ${r.qty}${r.unit} × ${log.intended_batch} batch × ${ratio.toFixed(3)} ratio`,
        created_by: log.created_by || "kitchen",
      });
    }
  }

  const { error: ledgerErr } = await db.from("stock_ledger").insert(ledgerRows);
  if (ledgerErr) return { error: ledgerErr.message };

  return { data: logData };
}

async function getBatchPortionGram(itemId) {
  const db = await initSupabase();
  if (!db) return 100;
  const { data } = await db
    .from("batch_standards")
    .select("portion_gram")
    .eq("item_id", itemId)
    .single();
  return data?.portion_gram || 100;
}

async function insertPurchaseOrder(po) {
  const db = await initSupabase();
  if (!db) return { error: "Supabase not configured" };

  // 1. Insert PO
  const { data: poData, error: poErr } = await db
    .from("purchase_orders")
    .insert(po)
    .select()
    .single();

  if (poErr) return { error: poErr.message };

  // 2. Insert stock ledger PURCHASE entry
  const { error: ledgerErr } = await db.from("stock_ledger").insert({
    date: po.date,
    item_id: po.item_id,
    in_qty: po.qty_usage_unit,
    out_qty: 0,
    source: "PURCHASE",
    ref: po.ref || poData.id,
  });

  if (ledgerErr) return { error: ledgerErr.message };
  return { data: poData };
}

// ============================================================
// MOCK DATA — mirrors schema_and_seed.sql exactly
// IDs and names are SOT-aligned after cross-check pass.
// ============================================================

function getMockStock() {
  // Stock quantities are opening + purchases - production usage, approximated
  return [
    // [SOT] Ingredients ING001–ING029
    {
      item_id: "ING001",
      item_name: "Whip Cream",
      category: "Ingredient",
      usage_unit: "ml",
      stock_qty: 842,
      par_level: 500,
      stock_status: "ok",
    },
    {
      item_id: "ING002",
      item_name: "Fresh Milk",
      category: "Ingredient",
      usage_unit: "ml",
      stock_qty: 842,
      par_level: 500,
      stock_status: "ok",
    },
    {
      item_id: "ING003",
      item_name: "Kentang",
      category: "Ingredient",
      usage_unit: "gr",
      stock_qty: 1033,
      par_level: 3000,
      stock_status: "critical",
    },
    {
      item_id: "ING004",
      item_name: "Beef Powder",
      category: "Ingredient",
      usage_unit: "gr",
      stock_qty: 793,
      par_level: 200,
      stock_status: "ok",
    },
    {
      item_id: "ING005",
      item_name: "Lada Hitam",
      category: "Ingredient",
      usage_unit: "gr",
      stock_qty: 967,
      par_level: 100,
      stock_status: "ok",
    },
    {
      item_id: "ING006",
      item_name: "Lada Putih",
      category: "Ingredient",
      usage_unit: "gr",
      stock_qty: 990,
      par_level: 100,
      stock_status: "ok",
    },
    {
      item_id: "ING007",
      item_name: "Garlic Powder",
      category: "Ingredient",
      usage_unit: "gr",
      stock_qty: 1000,
      par_level: 100,
      stock_status: "ok",
    },
    {
      item_id: "ING008",
      item_name: "Pala Kupas",
      category: "Ingredient",
      usage_unit: "gr",
      stock_qty: 997,
      par_level: 50,
      stock_status: "ok",
    },
    {
      item_id: "ING009",
      item_name: "Cheese Mild",
      category: "Ingredient",
      usage_unit: "gr",
      stock_qty: 965,
      par_level: 300,
      stock_status: "ok",
    },
    {
      item_id: "ING010",
      item_name: "Garam",
      category: "Ingredient",
      usage_unit: "gr",
      stock_qty: 1000,
      par_level: 200,
      stock_status: "ok",
    },
    {
      item_id: "ING011",
      item_name: "Gula Pasir",
      category: "Ingredient",
      usage_unit: "gr",
      stock_qty: 970,
      par_level: 300,
      stock_status: "ok",
    },
    {
      item_id: "ING012",
      item_name: "Tepung Panir",
      category: "Ingredient",
      usage_unit: "gr",
      stock_qty: 6503,
      par_level: 500,
      stock_status: "ok",
    },
    {
      item_id: "ING013",
      item_name: "Yellow Mustard",
      category: "Ingredient",
      usage_unit: "ml",
      stock_qty: 335,
      par_level: 300,
      stock_status: "ok",
    },
    {
      item_id: "ING014",
      item_name: "BBQ Sauce Can",
      category: "Ingredient",
      usage_unit: "ml",
      stock_qty: 601,
      par_level: 300,
      stock_status: "ok",
    },
    {
      item_id: "ING015",
      item_name: "Telur Ayam",
      category: "Ingredient",
      usage_unit: "gr",
      stock_qty: 900,
      par_level: 200,
      stock_status: "ok",
    },
    {
      item_id: "ING016",
      item_name: "Daging Giling",
      category: "Ingredient",
      usage_unit: "gr",
      stock_qty: 215,
      par_level: 2000,
      stock_status: "critical",
    },
    {
      item_id: "ING017",
      item_name: "Selada Hijau",
      category: "Ingredient",
      usage_unit: "gr",
      stock_qty: 3000,
      par_level: 500,
      stock_status: "ok",
    },
    {
      item_id: "ING018",
      item_name: "Selada Merah",
      category: "Ingredient",
      usage_unit: "gr",
      stock_qty: 3000,
      par_level: 500,
      stock_status: "ok",
    },
    {
      item_id: "ING019",
      item_name: "Frisee",
      category: "Ingredient",
      usage_unit: "gr",
      stock_qty: 500,
      par_level: 300,
      stock_status: "ok",
    },
    {
      item_id: "ING020",
      item_name: "Jembak",
      category: "Ingredient",
      usage_unit: "gr",
      stock_qty: 0,
      par_level: 500,
      stock_status: "critical",
    },
    {
      item_id: "ING021",
      item_name: "Tomat Chery",
      category: "Ingredient",
      usage_unit: "gr",
      stock_qty: 900,
      par_level: 200,
      stock_status: "ok",
    },
    {
      item_id: "ING022",
      item_name: "Tomat Besar",
      category: "Ingredient",
      usage_unit: "gr",
      stock_qty: 1000,
      par_level: 300,
      stock_status: "ok",
    },
    {
      item_id: "ING023",
      item_name: "Timun",
      category: "Ingredient",
      usage_unit: "gr",
      stock_qty: 1000,
      par_level: 300,
      stock_status: "ok",
    },
    {
      item_id: "ING024",
      item_name: "Madu",
      category: "Ingredient",
      usage_unit: "gr",
      stock_qty: 1000,
      par_level: 300,
      stock_status: "ok",
    },
    {
      item_id: "ING025",
      item_name: "Jeruk Nipis",
      category: "Ingredient",
      usage_unit: "gr",
      stock_qty: 1000,
      par_level: 200,
      stock_status: "ok",
    },
    {
      item_id: "ING026",
      item_name: "Salad Oil",
      category: "Ingredient",
      usage_unit: "ml",
      stock_qty: 1000,
      par_level: 500,
      stock_status: "ok",
    },
    {
      item_id: "ING027",
      item_name: "Acar Gerkien",
      category: "Ingredient",
      usage_unit: "gr",
      stock_qty: 1000,
      par_level: 200,
      stock_status: "ok",
    },
    {
      item_id: "ING028",
      item_name: "Mixed Cajun",
      category: "Ingredient",
      usage_unit: "gr",
      stock_qty: 1000,
      par_level: 200,
      stock_status: "ok",
    },
    {
      item_id: "ING029",
      item_name: "Cheese Slice",
      category: "Ingredient",
      usage_unit: "pcs",
      stock_qty: 994,
      par_level: 24,
      stock_status: "ok",
    },
    // [BH-EXT] Ingredients
    {
      item_id: "ING030",
      item_name: "Wagyu Striploin",
      category: "Ingredient",
      usage_unit: "gr",
      stock_qty: 4000,
      par_level: 2000,
      stock_status: "ok",
    },
    {
      item_id: "ING031",
      item_name: "Butter",
      category: "Ingredient",
      usage_unit: "gr",
      stock_qty: 1000,
      par_level: 300,
      stock_status: "ok",
    },
    {
      item_id: "ING032",
      item_name: "Worcestershire",
      category: "Ingredient",
      usage_unit: "ml",
      stock_qty: 500,
      par_level: 200,
      stock_status: "ok",
    },
    {
      item_id: "ING033",
      item_name: "Burger Bun",
      category: "Ingredient",
      usage_unit: "pcs",
      stock_qty: 29,
      par_level: 20,
      stock_status: "ok",
    },
    {
      item_id: "ING034",
      item_name: "Bawang Bombay",
      category: "Ingredient",
      usage_unit: "gr",
      stock_qty: 800,
      par_level: 300,
      stock_status: "ok",
    },
    // Prep items
    {
      item_id: "PREP001",
      item_name: "Potato Wedges",
      category: "Prep",
      usage_unit: "gr",
      stock_qty: 3990,
      par_level: 500,
      stock_status: "ok",
    },
    {
      item_id: "PREP002",
      item_name: "Home FF",
      category: "Prep",
      usage_unit: "gr",
      stock_qty: 600,
      par_level: 800,
      stock_status: "low",
    },
    {
      item_id: "PREP003",
      item_name: "Mashed Potato",
      category: "Prep",
      usage_unit: "gr",
      stock_qty: 5555,
      par_level: 500,
      stock_status: "ok",
    },
    {
      item_id: "PREP004",
      item_name: "Mixed Salad",
      category: "Prep",
      usage_unit: "gr",
      stock_qty: 5420,
      par_level: 300,
      stock_status: "ok",
    },
    {
      item_id: "PREP005",
      item_name: "Beef Patty",
      category: "Prep",
      usage_unit: "pcs",
      stock_qty: 142,
      par_level: 10,
      stock_status: "ok",
    },
    {
      item_id: "PREP006",
      item_name: "Honey Lime Dressing",
      category: "Prep",
      usage_unit: "ml",
      stock_qty: 380,
      par_level: 200,
      stock_status: "ok",
    },
    {
      item_id: "PREP007",
      item_name: "Cajun Fries",
      category: "Prep",
      usage_unit: "gr",
      stock_qty: 315,
      par_level: 500,
      stock_status: "low",
    },
  ];
}

function getMockPortions() {
  return [
    {
      item_id: "PREP001",
      item_name: "Potato Wedges",
      stock_qty: 3990,
      portion_gram: 105,
      portions_available: 38,
      stock_status: "ok",
    },
    {
      item_id: "PREP002",
      item_name: "Home FF",
      stock_qty: 600,
      portion_gram: 150,
      portions_available: 4,
      stock_status: "low",
    },
    {
      item_id: "PREP003",
      item_name: "Mashed Potato",
      stock_qty: 5555,
      portion_gram: 100,
      portions_available: 55,
      stock_status: "ok",
    },
    {
      item_id: "PREP004",
      item_name: "Mixed Salad",
      stock_qty: 5420,
      portion_gram: 92,
      portions_available: 58,
      stock_status: "ok",
    },
    {
      item_id: "PREP005",
      item_name: "Beef Patty",
      stock_qty: 142,
      portion_gram: 100,
      portions_available: 142,
      stock_status: "ok",
    },
    {
      item_id: "PREP006",
      item_name: "Honey Lime Dressing",
      stock_qty: 380,
      portion_gram: 190,
      portions_available: 2,
      stock_status: "ok",
    },
    {
      item_id: "PREP007",
      item_name: "Cajun Fries",
      stock_qty: 315,
      portion_gram: 105,
      portions_available: 3,
      stock_status: "low",
    },
  ];
}

function getMockProduction() {
  // PREP IDs corrected: PREP003=Mashed Potato, PREP005=Beef Patty, PREP001=Potato Wedges
  return [
    {
      batch_no: "BK008",
      date: "2025-03-19",
      item_id: "PREP001",
      items: { item_name: "Potato Wedges" },
      std_yield_gram: 2100,
      actual_yield_gram: 2050,
      efficiency_pct: 97.6,
      total_portions: 19.5,
      notes: null,
    },
    {
      batch_no: "BK007",
      date: "2025-03-19",
      item_id: "PREP003",
      items: { item_name: "Mashed Potato" },
      std_yield_gram: 1500,
      actual_yield_gram: 1480,
      efficiency_pct: 98.7,
      total_portions: 14.8,
      notes: null,
    },
    {
      batch_no: "BK006",
      date: "2025-03-18",
      item_id: "PREP005",
      items: { item_name: "Beef Patty" },
      std_yield_gram: 8860,
      actual_yield_gram: 8600,
      efficiency_pct: 97.1,
      total_portions: 86,
      notes: null,
    },
    {
      batch_no: "BK005",
      date: "2025-03-17",
      item_id: "PREP004",
      items: { item_name: "Mixed Salad" },
      std_yield_gram: 4600,
      actual_yield_gram: 4500,
      efficiency_pct: 97.8,
      total_portions: 48.9,
      notes: "Slight jembak shortage",
    },
    {
      batch_no: "BK004",
      date: "2025-03-16",
      item_id: "PREP001",
      items: { item_name: "Potato Wedges" },
      std_yield_gram: 3150,
      actual_yield_gram: 3100,
      efficiency_pct: 98.4,
      total_portions: 29.5,
      notes: null,
    },
    {
      batch_no: "BK003",
      date: "2025-03-16",
      item_id: "PREP003",
      items: { item_name: "Mashed Potato" },
      std_yield_gram: 3000,
      actual_yield_gram: 2950,
      efficiency_pct: 98.3,
      total_portions: 29.5,
      notes: null,
    },
    {
      batch_no: "BK002",
      date: "2025-03-15",
      item_id: "PREP005",
      items: { item_name: "Beef Patty" },
      std_yield_gram: 8860,
      actual_yield_gram: 4400,
      efficiency_pct: 49.7,
      total_portions: 44,
      notes: null,
    },
    {
      batch_no: "BK001",
      date: "2025-03-15",
      item_id: "PREP003",
      items: { item_name: "Mashed Potato" },
      std_yield_gram: 1500,
      actual_yield_gram: 525,
      efficiency_pct: 35.0,
      total_portions: 5.25,
      notes: "Low yield — milk ran short",
    },
  ];
}

function getMockPrepItems() {
  return [
    { item_id: "PREP001", item_name: "Potato Wedges", category: "Prep" },
    { item_id: "PREP002", item_name: "Home FF", category: "Prep" },
    { item_id: "PREP003", item_name: "Mashed Potato", category: "Prep" },
    { item_id: "PREP004", item_name: "Mixed Salad", category: "Prep" },
    { item_id: "PREP005", item_name: "Beef Patty", category: "Prep" },
    { item_id: "PREP006", item_name: "Honey Lime Dressing", category: "Prep" },
    { item_id: "PREP007", item_name: "Cajun Fries", category: "Prep" },
  ];
}

function getMockIngredients() {
  return [
    // [SOT] ING001–ING029
    {
      item_id: "ING001",
      item_name: "Whip Cream",
      purchase_unit: "ltr",
      usage_unit: "ml",
      conversion: 1000,
    },
    {
      item_id: "ING002",
      item_name: "Fresh Milk",
      purchase_unit: "ltr",
      usage_unit: "ml",
      conversion: 1000,
    },
    {
      item_id: "ING003",
      item_name: "Kentang",
      purchase_unit: "kg",
      usage_unit: "gr",
      conversion: 1000,
    },
    {
      item_id: "ING004",
      item_name: "Beef Powder",
      purchase_unit: "kg",
      usage_unit: "gr",
      conversion: 1000,
    },
    {
      item_id: "ING005",
      item_name: "Lada Hitam",
      purchase_unit: "kg",
      usage_unit: "gr",
      conversion: 1000,
    },
    {
      item_id: "ING006",
      item_name: "Lada Putih",
      purchase_unit: "kg",
      usage_unit: "gr",
      conversion: 1000,
    },
    {
      item_id: "ING007",
      item_name: "Garlic Powder",
      purchase_unit: "kg",
      usage_unit: "gr",
      conversion: 1000,
    },
    {
      item_id: "ING008",
      item_name: "Pala Kupas",
      purchase_unit: "kg",
      usage_unit: "gr",
      conversion: 1000,
    },
    {
      item_id: "ING009",
      item_name: "Cheese Mild",
      purchase_unit: "kg",
      usage_unit: "gr",
      conversion: 1000,
    },
    {
      item_id: "ING010",
      item_name: "Garam",
      purchase_unit: "kg",
      usage_unit: "gr",
      conversion: 1000,
    },
    {
      item_id: "ING011",
      item_name: "Gula Pasir",
      purchase_unit: "kg",
      usage_unit: "gr",
      conversion: 1000,
    },
    {
      item_id: "ING012",
      item_name: "Tepung Panir",
      purchase_unit: "kg",
      usage_unit: "gr",
      conversion: 1000,
    },
    {
      item_id: "ING013",
      item_name: "Yellow Mustard",
      purchase_unit: "ltr",
      usage_unit: "ml",
      conversion: 1000,
    },
    {
      item_id: "ING014",
      item_name: "BBQ Sauce Can",
      purchase_unit: "ltr",
      usage_unit: "ml",
      conversion: 1000,
    },
    {
      item_id: "ING015",
      item_name: "Telur Ayam",
      purchase_unit: "kg",
      usage_unit: "gr",
      conversion: 1000,
    },
    {
      item_id: "ING016",
      item_name: "Daging Giling",
      purchase_unit: "kg",
      usage_unit: "gr",
      conversion: 1000,
    },
    {
      item_id: "ING017",
      item_name: "Selada Hijau",
      purchase_unit: "kg",
      usage_unit: "gr",
      conversion: 1000,
    },
    {
      item_id: "ING018",
      item_name: "Selada Merah",
      purchase_unit: "kg",
      usage_unit: "gr",
      conversion: 1000,
    },
    {
      item_id: "ING019",
      item_name: "Frisee",
      purchase_unit: "kg",
      usage_unit: "gr",
      conversion: 1000,
    },
    {
      item_id: "ING020",
      item_name: "Jembak",
      purchase_unit: "kg",
      usage_unit: "gr",
      conversion: 1000,
    },
    {
      item_id: "ING021",
      item_name: "Tomat Chery",
      purchase_unit: "kg",
      usage_unit: "gr",
      conversion: 1000,
    },
    {
      item_id: "ING022",
      item_name: "Tomat Besar",
      purchase_unit: "kg",
      usage_unit: "gr",
      conversion: 1000,
    },
    {
      item_id: "ING023",
      item_name: "Timun",
      purchase_unit: "kg",
      usage_unit: "gr",
      conversion: 1000,
    },
    {
      item_id: "ING024",
      item_name: "Madu",
      purchase_unit: "kg",
      usage_unit: "gr",
      conversion: 1000,
    },
    {
      item_id: "ING025",
      item_name: "Jeruk Nipis",
      purchase_unit: "kg",
      usage_unit: "gr",
      conversion: 1000,
    },
    {
      item_id: "ING026",
      item_name: "Salad Oil",
      purchase_unit: "ltr",
      usage_unit: "ml",
      conversion: 1000,
    },
    {
      item_id: "ING027",
      item_name: "Acar Gerkien",
      purchase_unit: "kg",
      usage_unit: "gr",
      conversion: 1000,
    },
    {
      item_id: "ING028",
      item_name: "Mixed Cajun",
      purchase_unit: "kg",
      usage_unit: "gr",
      conversion: 1000,
    },
    {
      item_id: "ING029",
      item_name: "Cheese Slice",
      purchase_unit: "pcs",
      usage_unit: "pcs",
      conversion: 12,
    }, // 1 pack = 12 slices
    // [BH-EXT]
    {
      item_id: "ING030",
      item_name: "Wagyu Striploin",
      purchase_unit: "kg",
      usage_unit: "gr",
      conversion: 1000,
    },
    {
      item_id: "ING031",
      item_name: "Butter",
      purchase_unit: "kg",
      usage_unit: "gr",
      conversion: 1000,
    },
    {
      item_id: "ING032",
      item_name: "Worcestershire",
      purchase_unit: "ltr",
      usage_unit: "ml",
      conversion: 1000,
    },
    {
      item_id: "ING033",
      item_name: "Burger Bun",
      purchase_unit: "pcs",
      usage_unit: "pcs",
      conversion: 1,
    },
    {
      item_id: "ING034",
      item_name: "Bawang Bombay",
      purchase_unit: "kg",
      usage_unit: "gr",
      conversion: 1000,
    },
  ];
}

function getMockSuppliers() {
  return [
    { supplier_id: "SUP001", supplier_name: "Sukanda Jaya" }, // [SOT]
    { supplier_id: "SUP002", supplier_name: "Wagyu Indo Prima" }, // [BH-EXT]
    { supplier_id: "SUP003", supplier_name: "Fresh Market Jkt" }, // [BH-EXT]
    { supplier_id: "SUP004", supplier_name: "Anchor Dairy" }, // [BH-EXT]
  ];
}

function getMockBatchStandards() {
  // Yields from Excel Sheet 6 — corrected Beef Patty to 4430, added Home FF
  return [
    {
      item_id: "PREP001",
      standard_yield_gram: 1050,
      portion_gram: 105,
      portions_per_batch: 10,
    }, // Potato Wedges [SOT]
    {
      item_id: "PREP002",
      standard_yield_gram: 8100,
      portion_gram: 150,
      portions_per_batch: 54,
    }, // Home FF [SOT] — was missing
    {
      item_id: "PREP003",
      standard_yield_gram: 1500,
      portion_gram: 100,
      portions_per_batch: 15,
    }, // Mashed Potato [SOT]
    {
      item_id: "PREP004",
      standard_yield_gram: 4600,
      portion_gram: 92,
      portions_per_batch: 50,
    }, // Mixed Salad [SOT]
    {
      item_id: "PREP005",
      standard_yield_gram: 4430,
      portion_gram: 100,
      portions_per_batch: 44.3,
    }, // Beef Patty [SOT] corrected
    {
      item_id: "PREP006",
      standard_yield_gram: 3800,
      portion_gram: 190,
      portions_per_batch: 20,
    }, // Dressing [SOT]
    {
      item_id: "PREP007",
      standard_yield_gram: 1050,
      portion_gram: 105,
      portions_per_batch: 10,
    }, // Cajun Fries [BH-EXT]
  ];
}

function getMockPurchases() {
  // [SOT] PO-FEB-001: Sukanda Jaya, Daging Giling, 3kg @ 270,000/kg = 810,000
  return [
    {
      id: "1",
      date: "2025-03-10",
      item_id: "ING018",
      items: { item_name: "Selada Merah", purchase_unit: "kg" },
      suppliers: { supplier_name: "Fresh Market Jkt" },
      qty_purchase_unit: 2,
      qty_usage_unit: 2000,
      unit_price: 35000,
      total_cost: 70000,
      ref: "PO-MAR-006",
      status: "received",
    },
    {
      id: "2",
      date: "2025-03-10",
      item_id: "ING017",
      items: { item_name: "Selada Hijau", purchase_unit: "kg" },
      suppliers: { supplier_name: "Fresh Market Jkt" },
      qty_purchase_unit: 2,
      qty_usage_unit: 2000,
      unit_price: 35000,
      total_cost: 70000,
      ref: "PO-MAR-006",
      status: "received",
    },
    {
      id: "3",
      date: "2025-03-10",
      item_id: "ING016",
      items: { item_name: "Daging Giling", purchase_unit: "kg" },
      suppliers: { supplier_name: "Sukanda Jaya" },
      qty_purchase_unit: 5,
      qty_usage_unit: 5000,
      unit_price: 88000,
      total_cost: 440000,
      ref: "PO-MAR-005",
      status: "received",
    },
    {
      id: "4",
      date: "2025-03-05",
      item_id: "ING012",
      items: { item_name: "Tepung Panir", purchase_unit: "kg" },
      suppliers: { supplier_name: "Sukanda Jaya" },
      qty_purchase_unit: 2,
      qty_usage_unit: 2000,
      unit_price: 28000,
      total_cost: 56000,
      ref: "PO-MAR-004",
      status: "received",
    },
    {
      id: "5",
      date: "2025-03-01",
      item_id: "ING030",
      items: { item_name: "Wagyu Striploin", purchase_unit: "kg" },
      suppliers: { supplier_name: "Wagyu Indo Prima" },
      qty_purchase_unit: 2,
      qty_usage_unit: 2000,
      unit_price: 450000,
      total_cost: 900000,
      ref: "PO-MAR-001",
      status: "received",
    },
    {
      id: "6",
      date: "2025-02-27",
      item_id: "ING016",
      items: { item_name: "Daging Giling", purchase_unit: "kg" },
      suppliers: { supplier_name: "Sukanda Jaya" },
      qty_purchase_unit: 3,
      qty_usage_unit: 3000,
      unit_price: 270000,
      total_cost: 810000,
      ref: "PO-FEB-001",
      status: "received",
    },
  ];
}

// ── RECIPE DATA FUNCTIONS ────────────────────────────────────

async function fetchAllPrepAndDishItems() {
  const db = await initSupabase();
  if (!db) return getMockPrepAndDish();

  const { data, error } = await db
    .from("items")
    .select("item_id, item_name, category, usage_unit, par_level")
    .in("category", ["Prep", "Dish"])
    .eq("is_active", true)
    .order("category")
    .order("item_name");

  if (error) {
    console.error(error);
    return getMockPrepAndDish();
  }
  return data;
}

async function fetchAllIngredientAndPrepItems() {
  const db = await initSupabase();
  if (!db) return getMockAllInputItems();

  const { data, error } = await db
    .from("items")
    .select("item_id, item_name, category, usage_unit")
    .in("category", ["Ingredient", "Prep"])
    .eq("is_active", true)
    .order("category")
    .order("item_name");

  if (error) {
    console.error(error);
    return getMockAllInputItems();
  }
  return data;
}

async function fetchRecipeLibrary() {
  const db = await initSupabase();
  if (!db) return getMockRecipeLibrary();

  // Fetch all prep/dish items with their recipes and batch standards
  const { data: items, error: itemErr } = await db
    .from("items")
    .select("item_id, item_name, category, usage_unit")
    .in("category", ["Prep", "Dish"])
    .eq("is_active", true)
    .order("category")
    .order("item_name");

  if (itemErr) {
    console.error(itemErr);
    return getMockRecipeLibrary();
  }

  const { data: recipes, error: recErr } = await db
    .from("recipes")
    .select(
      "output_item_id, input_item_id, qty, unit, items!recipes_input_item_id_fkey(item_name)",
    )
    .is("valid_to", null);

  const { data: standards } = await db.from("batch_standards").select("*");

  if (recErr) {
    console.error(recErr);
  }

  // Group recipes by output item
  const recipeMap = {};
  (recipes || []).forEach((r) => {
    if (!recipeMap[r.output_item_id]) recipeMap[r.output_item_id] = [];
    recipeMap[r.output_item_id].push(r);
  });

  const stdMap = {};
  (standards || []).forEach((s) => {
    stdMap[s.item_id] = s;
  });

  return items.map((item) => ({
    ...item,
    lines: recipeMap[item.item_id] || [],
    standard: stdMap[item.item_id] || null,
  }));
}

async function fetchRecipeLinesForItem(itemId) {
  const db = await initSupabase();
  if (!db) {
    const lib = getMockRecipeLibrary();
    const found = lib.find((r) => r.item_id === itemId);
    return found ? found.lines : [];
  }

  const { data, error } = await db
    .from("recipes")
    .select(
      "id, input_item_id, qty, unit, items!recipes_input_item_id_fkey(item_name, usage_unit)",
    )
    .eq("output_item_id", itemId)
    .is("valid_to", null);

  if (error) {
    console.error(error);
    return [];
  }
  return data;
}

async function createItem(item) {
  const db = await initSupabase();
  if (!db) {
    // Mock: just return a fake id so the flow continues in demo mode
    return { data: { ...item, item_id: item.item_id }, error: null };
  }

  const { data, error } = await db.from("items").insert(item).select().single();

  return { data, error };
}

async function saveRecipeLines(outputItemId, lines) {
  // lines = [{ input_item_id, qty, unit }]
  const db = await initSupabase();
  if (!db) return { error: null }; // mock: silently succeed

  // Soft-delete existing lines (set valid_to = today)
  await db
    .from("recipes")
    .update({ valid_to: new Date().toISOString().split("T")[0] })
    .eq("output_item_id", outputItemId)
    .is("valid_to", null);

  // Insert new lines
  const rows = lines.map((l) => ({
    output_item_id: outputItemId,
    input_item_id: l.input_item_id,
    qty: l.qty,
    unit: l.unit,
    valid_from: new Date().toISOString().split("T")[0],
  }));

  const { error } = await db.from("recipes").insert(rows);
  return { error: error?.message || null };
}

async function saveBatchStandard(itemId, stdYield, portionGram) {
  const db = await initSupabase();
  if (!db) return { error: null }; // mock: silently succeed

  // Upsert
  const { error } = await db.from("batch_standards").upsert(
    {
      item_id: itemId,
      standard_yield_gram: stdYield,
      portion_gram: portionGram,
    },
    { onConflict: "item_id" },
  );

  return { error: error?.message || null };
}

// ── MOCK DATA ────────────────────────────────────────────────

function getMockPrepAndDish() {
  return [
    {
      item_id: "PREP001",
      item_name: "Potato Wedges",
      category: "Prep",
      usage_unit: "gr",
      par_level: 500,
    },
    {
      item_id: "PREP002",
      item_name: "Home FF",
      category: "Prep",
      usage_unit: "gr",
      par_level: 800,
    },
    {
      item_id: "PREP003",
      item_name: "Mashed Potato",
      category: "Prep",
      usage_unit: "gr",
      par_level: 500,
    },
    {
      item_id: "PREP004",
      item_name: "Mixed Salad",
      category: "Prep",
      usage_unit: "gr",
      par_level: 300,
    },
    {
      item_id: "PREP005",
      item_name: "Beef Patty",
      category: "Prep",
      usage_unit: "pcs",
      par_level: 10,
    },
    {
      item_id: "PREP006",
      item_name: "Honey Lime Dressing",
      category: "Prep",
      usage_unit: "ml",
      par_level: 200,
    },
    {
      item_id: "PREP007",
      item_name: "Cajun Fries",
      category: "Prep",
      usage_unit: "gr",
      par_level: 500,
    },
    {
      item_id: "DISH001",
      item_name: "Wagyu Striploin Steak",
      category: "Dish",
      usage_unit: "portion",
      par_level: 5,
    },
    {
      item_id: "DISH002",
      item_name: "Classic Beef Burger",
      category: "Dish",
      usage_unit: "portion",
      par_level: 5,
    },
    {
      item_id: "DISH003",
      item_name: "Cajun Burger",
      category: "Dish",
      usage_unit: "portion",
      par_level: 5,
    },
  ];
}

function getMockAllInputItems() {
  // All ingredients + prep items (valid recipe inputs)
  return [
    {
      item_id: "ING001",
      item_name: "Whip Cream",
      category: "Ingredient",
      usage_unit: "ml",
    },
    {
      item_id: "ING002",
      item_name: "Fresh Milk",
      category: "Ingredient",
      usage_unit: "ml",
    },
    {
      item_id: "ING003",
      item_name: "Kentang",
      category: "Ingredient",
      usage_unit: "gr",
    },
    {
      item_id: "ING004",
      item_name: "Beef Powder",
      category: "Ingredient",
      usage_unit: "gr",
    },
    {
      item_id: "ING005",
      item_name: "Lada Hitam",
      category: "Ingredient",
      usage_unit: "gr",
    },
    {
      item_id: "ING006",
      item_name: "Lada Putih",
      category: "Ingredient",
      usage_unit: "gr",
    },
    {
      item_id: "ING007",
      item_name: "Garlic Powder",
      category: "Ingredient",
      usage_unit: "gr",
    },
    {
      item_id: "ING008",
      item_name: "Pala Kupas",
      category: "Ingredient",
      usage_unit: "gr",
    },
    {
      item_id: "ING009",
      item_name: "Cheese Mild",
      category: "Ingredient",
      usage_unit: "gr",
    },
    {
      item_id: "ING010",
      item_name: "Garam",
      category: "Ingredient",
      usage_unit: "gr",
    },
    {
      item_id: "ING011",
      item_name: "Gula Pasir",
      category: "Ingredient",
      usage_unit: "gr",
    },
    {
      item_id: "ING012",
      item_name: "Tepung Panir",
      category: "Ingredient",
      usage_unit: "gr",
    },
    {
      item_id: "ING013",
      item_name: "Yellow Mustard",
      category: "Ingredient",
      usage_unit: "ml",
    },
    {
      item_id: "ING014",
      item_name: "BBQ Sauce Can",
      category: "Ingredient",
      usage_unit: "ml",
    },
    {
      item_id: "ING015",
      item_name: "Telur Ayam",
      category: "Ingredient",
      usage_unit: "gr",
    },
    {
      item_id: "ING016",
      item_name: "Daging Giling",
      category: "Ingredient",
      usage_unit: "gr",
    },
    {
      item_id: "ING017",
      item_name: "Selada Hijau",
      category: "Ingredient",
      usage_unit: "gr",
    },
    {
      item_id: "ING018",
      item_name: "Selada Merah",
      category: "Ingredient",
      usage_unit: "gr",
    },
    {
      item_id: "ING019",
      item_name: "Frisee",
      category: "Ingredient",
      usage_unit: "gr",
    },
    {
      item_id: "ING020",
      item_name: "Jembak",
      category: "Ingredient",
      usage_unit: "gr",
    },
    {
      item_id: "ING021",
      item_name: "Tomat Chery",
      category: "Ingredient",
      usage_unit: "gr",
    },
    {
      item_id: "ING022",
      item_name: "Tomat Besar",
      category: "Ingredient",
      usage_unit: "gr",
    },
    {
      item_id: "ING023",
      item_name: "Timun",
      category: "Ingredient",
      usage_unit: "gr",
    },
    {
      item_id: "ING024",
      item_name: "Madu",
      category: "Ingredient",
      usage_unit: "gr",
    },
    {
      item_id: "ING025",
      item_name: "Jeruk Nipis",
      category: "Ingredient",
      usage_unit: "gr",
    },
    {
      item_id: "ING026",
      item_name: "Salad Oil",
      category: "Ingredient",
      usage_unit: "ml",
    },
    {
      item_id: "ING027",
      item_name: "Acar Gerkien",
      category: "Ingredient",
      usage_unit: "gr",
    },
    {
      item_id: "ING028",
      item_name: "Mixed Cajun",
      category: "Ingredient",
      usage_unit: "gr",
    },
    {
      item_id: "ING029",
      item_name: "Cheese Slice",
      category: "Ingredient",
      usage_unit: "pcs",
    },
    {
      item_id: "ING030",
      item_name: "Wagyu Striploin",
      category: "Ingredient",
      usage_unit: "gr",
    },
    {
      item_id: "ING031",
      item_name: "Butter",
      category: "Ingredient",
      usage_unit: "gr",
    },
    {
      item_id: "ING032",
      item_name: "Worcestershire",
      category: "Ingredient",
      usage_unit: "ml",
    },
    {
      item_id: "ING033",
      item_name: "Burger Bun",
      category: "Ingredient",
      usage_unit: "pcs",
    },
    {
      item_id: "ING034",
      item_name: "Bawang Bombay",
      category: "Ingredient",
      usage_unit: "gr",
    },
    {
      item_id: "PREP001",
      item_name: "Potato Wedges",
      category: "Prep",
      usage_unit: "gr",
    },
    {
      item_id: "PREP002",
      item_name: "Home FF",
      category: "Prep",
      usage_unit: "gr",
    },
    {
      item_id: "PREP003",
      item_name: "Mashed Potato",
      category: "Prep",
      usage_unit: "gr",
    },
    {
      item_id: "PREP004",
      item_name: "Mixed Salad",
      category: "Prep",
      usage_unit: "gr",
    },
    {
      item_id: "PREP005",
      item_name: "Beef Patty",
      category: "Prep",
      usage_unit: "pcs",
    },
    {
      item_id: "PREP006",
      item_name: "Honey Lime Dressing",
      category: "Prep",
      usage_unit: "ml",
    },
    {
      item_id: "PREP007",
      item_name: "Cajun Fries",
      category: "Prep",
      usage_unit: "gr",
    },
  ];
}

function getMockRecipeLibrary() {
  return [
    {
      item_id: "PREP001",
      item_name: "Potato Wedges",
      category: "Prep",
      usage_unit: "gr",
      lines: [
        {
          input_item_id: "ING003",
          qty: 1000,
          unit: "gr",
          items: { item_name: "Kentang" },
        },
        {
          input_item_id: "ING005",
          qty: 25,
          unit: "gr",
          items: { item_name: "Lada Hitam" },
        },
        {
          input_item_id: "ING004",
          qty: 25,
          unit: "gr",
          items: { item_name: "Beef Powder" },
        },
      ],
      standard: {
        standard_yield_gram: 1050,
        portion_gram: 105,
        portions_per_batch: 10,
      },
    },
    {
      item_id: "PREP002",
      item_name: "Home FF",
      category: "Prep",
      usage_unit: "gr",
      lines: [
        {
          input_item_id: "ING003",
          qty: 8000,
          unit: "gr",
          items: { item_name: "Kentang" },
        },
        {
          input_item_id: "ING007",
          qty: 40,
          unit: "gr",
          items: { item_name: "Garlic Powder" },
        },
        {
          input_item_id: "ING004",
          qty: 40,
          unit: "gr",
          items: { item_name: "Beef Powder" },
        },
        {
          input_item_id: "ING006",
          qty: 10,
          unit: "gr",
          items: { item_name: "Lada Putih" },
        },
      ],
      standard: {
        standard_yield_gram: 8100,
        portion_gram: 150,
        portions_per_batch: 54,
      },
    },
    {
      item_id: "PREP003",
      item_name: "Mashed Potato",
      category: "Prep",
      usage_unit: "gr",
      lines: [
        {
          input_item_id: "ING003",
          qty: 1000,
          unit: "gr",
          items: { item_name: "Kentang" },
        },
        {
          input_item_id: "ING002",
          qty: 500,
          unit: "ml",
          items: { item_name: "Fresh Milk" },
        },
        {
          input_item_id: "ING001",
          qty: 500,
          unit: "ml",
          items: { item_name: "Whip Cream" },
        },
        {
          input_item_id: "ING004",
          qty: 20,
          unit: "gr",
          items: { item_name: "Beef Powder" },
        },
        {
          input_item_id: "ING005",
          qty: 10,
          unit: "gr",
          items: { item_name: "Lada Hitam" },
        },
        {
          input_item_id: "ING008",
          qty: 5,
          unit: "gr",
          items: { item_name: "Pala Kupas" },
        },
        {
          input_item_id: "ING009",
          qty: 100,
          unit: "gr",
          items: { item_name: "Cheese Mild" },
        },
      ],
      standard: {
        standard_yield_gram: 1500,
        portion_gram: 100,
        portions_per_batch: 15,
      },
    },
    {
      item_id: "PREP004",
      item_name: "Mixed Salad",
      category: "Prep",
      usage_unit: "gr",
      lines: [
        {
          input_item_id: "ING017",
          qty: 1000,
          unit: "gr",
          items: { item_name: "Selada Hijau" },
        },
        {
          input_item_id: "ING018",
          qty: 1000,
          unit: "gr",
          items: { item_name: "Selada Merah" },
        },
        {
          input_item_id: "ING019",
          qty: 500,
          unit: "gr",
          items: { item_name: "Frisee" },
        },
        {
          input_item_id: "ING020",
          qty: 2000,
          unit: "gr",
          items: { item_name: "Jembak" },
        },
        {
          input_item_id: "ING021",
          qty: 100,
          unit: "gr",
          items: { item_name: "Tomat Chery" },
        },
      ],
      standard: {
        standard_yield_gram: 4600,
        portion_gram: 92,
        portions_per_batch: 50,
      },
    },
    {
      item_id: "PREP005",
      item_name: "Beef Patty",
      category: "Prep",
      usage_unit: "pcs",
      lines: [
        {
          input_item_id: "ING016",
          qty: 3000,
          unit: "gr",
          items: { item_name: "Daging Giling" },
        },
        {
          input_item_id: "ING013",
          qty: 100,
          unit: "ml",
          items: { item_name: "Yellow Mustard" },
        },
        {
          input_item_id: "ING005",
          qty: 15,
          unit: "gr",
          items: { item_name: "Lada Hitam" },
        },
        {
          input_item_id: "ING004",
          qty: 100,
          unit: "gr",
          items: { item_name: "Beef Powder" },
        },
        {
          input_item_id: "ING015",
          qty: 50,
          unit: "gr",
          items: { item_name: "Telur Ayam" },
        },
        {
          input_item_id: "ING012",
          qty: 500,
          unit: "gr",
          items: { item_name: "Tepung Panir" },
        },
        {
          input_item_id: "ING014",
          qty: 200,
          unit: "ml",
          items: { item_name: "BBQ Sauce Can" },
        },
        {
          input_item_id: "ING011",
          qty: 15,
          unit: "gr",
          items: { item_name: "Gula Pasir" },
        },
      ],
      standard: {
        standard_yield_gram: 4430,
        portion_gram: 100,
        portions_per_batch: 44.3,
      },
    },
    {
      item_id: "PREP006",
      item_name: "Honey Lime Dressing",
      category: "Prep",
      usage_unit: "ml",
      lines: [
        {
          input_item_id: "ING013",
          qty: 550,
          unit: "ml",
          items: { item_name: "Yellow Mustard" },
        },
        {
          input_item_id: "ING024",
          qty: 600,
          unit: "gr",
          items: { item_name: "Madu" },
        },
        {
          input_item_id: "ING025",
          qty: 250,
          unit: "gr",
          items: { item_name: "Jeruk Nipis" },
        },
        {
          input_item_id: "ING026",
          qty: 3000,
          unit: "ml",
          items: { item_name: "Salad Oil" },
        },
      ],
      standard: {
        standard_yield_gram: 3800,
        portion_gram: 190,
        portions_per_batch: 20,
      },
    },
    {
      item_id: "DISH001",
      item_name: "Wagyu Striploin Steak",
      category: "Dish",
      usage_unit: "portion",
      lines: [
        {
          input_item_id: "ING030",
          qty: 200,
          unit: "gr",
          items: { item_name: "Wagyu Striploin" },
        },
        {
          input_item_id: "ING031",
          qty: 20,
          unit: "gr",
          items: { item_name: "Butter" },
        },
        {
          input_item_id: "ING010",
          qty: 3,
          unit: "gr",
          items: { item_name: "Garam" },
        },
        {
          input_item_id: "ING005",
          qty: 2,
          unit: "gr",
          items: { item_name: "Lada Hitam" },
        },
        {
          input_item_id: "ING032",
          qty: 10,
          unit: "ml",
          items: { item_name: "Worcestershire" },
        },
        {
          input_item_id: "PREP003",
          qty: 100,
          unit: "gr",
          items: { item_name: "Mashed Potato" },
        },
        {
          input_item_id: "PREP001",
          qty: 105,
          unit: "gr",
          items: { item_name: "Potato Wedges" },
        },
        {
          input_item_id: "PREP004",
          qty: 92,
          unit: "gr",
          items: { item_name: "Mixed Salad" },
        },
      ],
      standard: null,
    },
    {
      item_id: "DISH002",
      item_name: "Classic Beef Burger",
      category: "Dish",
      usage_unit: "portion",
      lines: [
        {
          input_item_id: "PREP005",
          qty: 1,
          unit: "pcs",
          items: { item_name: "Beef Patty" },
        },
        {
          input_item_id: "ING033",
          qty: 1,
          unit: "pcs",
          items: { item_name: "Burger Bun" },
        },
        {
          input_item_id: "ING029",
          qty: 2,
          unit: "pcs",
          items: { item_name: "Cheese Slice" },
        },
        {
          input_item_id: "ING017",
          qty: 30,
          unit: "gr",
          items: { item_name: "Selada Hijau" },
        },
        {
          input_item_id: "ING022",
          qty: 40,
          unit: "gr",
          items: { item_name: "Tomat Besar" },
        },
        {
          input_item_id: "ING023",
          qty: 30,
          unit: "gr",
          items: { item_name: "Timun" },
        },
        {
          input_item_id: "ING027",
          qty: 20,
          unit: "gr",
          items: { item_name: "Acar Gerkien" },
        },
        {
          input_item_id: "ING013",
          qty: 15,
          unit: "ml",
          items: { item_name: "Yellow Mustard" },
        },
        {
          input_item_id: "PREP001",
          qty: 105,
          unit: "gr",
          items: { item_name: "Potato Wedges" },
        },
        {
          input_item_id: "PREP004",
          qty: 92,
          unit: "gr",
          items: { item_name: "Mixed Salad" },
        },
      ],
      standard: null,
    },
  ];
}

// ── ITEMS MASTER CRUD ────────────────────────────────────────

async function fetchAllItemsMaster() {
  const db = await initSupabase();
  if (!db) return getMockAllItemsMaster();

  const { data, error } = await db
    .from("items")
    .select("*")
    .eq("is_active", true)
    .order("category")
    .order("item_id");

  if (error) {
    console.error(error);
    return getMockAllItemsMaster();
  }
  return data;
}

async function upsertItem(item) {
  const db = await initSupabase();
  if (!db) return { error: null }; // mock: succeed silently

  const { error } = await db
    .from("items")
    .upsert(item, { onConflict: "item_id" });

  return { error: error?.message || null };
}

// ── SUPPLIERS CRUD ───────────────────────────────────────────

async function fetchAllSuppliers() {
  const db = await initSupabase();
  if (!db) return getMockAllSuppliers();

  const { data, error } = await db
    .from("suppliers")
    .select("*")
    .order("supplier_name");

  if (error) {
    console.error(error);
    return getMockAllSuppliers();
  }
  return data;
}

async function upsertSupplier(sup) {
  const db = await initSupabase();
  if (!db) return { error: null };

  const { error } = await db
    .from("suppliers")
    .upsert(sup, { onConflict: "supplier_id" });

  return { error: error?.message || null };
}

// ── OPENING STOCK ────────────────────────────────────────────

async function insertOpeningStock(date, ref, lines) {
  const db = await initSupabase();
  if (!db) return { error: null };

  const rows = lines.map((l) => ({
    date,
    item_id: l.item_id,
    in_qty: l.qty,
    out_qty: 0,
    source: "OPENING",
    ref,
    created_by: "admin",
  }));

  const { error } = await db.from("stock_ledger").insert(rows);
  return { error: error?.message || null };
}

// ── MOCK DATA for new functions ──────────────────────────────

function getMockAllItemsMaster() {
  // Full list matching schema_and_seed.sql
  return [
    {
      item_id: "ING001",
      item_name: "Whip Cream",
      category: "Ingredient",
      purchase_unit: "ltr",
      usage_unit: "ml",
      conversion: 1000,
      par_level: 500,
      is_active: true,
    },
    {
      item_id: "ING002",
      item_name: "Fresh Milk",
      category: "Ingredient",
      purchase_unit: "ltr",
      usage_unit: "ml",
      conversion: 1000,
      par_level: 500,
      is_active: true,
    },
    {
      item_id: "ING003",
      item_name: "Kentang",
      category: "Ingredient",
      purchase_unit: "kg",
      usage_unit: "gr",
      conversion: 1000,
      par_level: 3000,
      is_active: true,
    },
    {
      item_id: "ING004",
      item_name: "Beef Powder",
      category: "Ingredient",
      purchase_unit: "kg",
      usage_unit: "gr",
      conversion: 1000,
      par_level: 200,
      is_active: true,
    },
    {
      item_id: "ING005",
      item_name: "Lada Hitam",
      category: "Ingredient",
      purchase_unit: "kg",
      usage_unit: "gr",
      conversion: 1000,
      par_level: 100,
      is_active: true,
    },
    {
      item_id: "ING006",
      item_name: "Lada Putih",
      category: "Ingredient",
      purchase_unit: "kg",
      usage_unit: "gr",
      conversion: 1000,
      par_level: 100,
      is_active: true,
    },
    {
      item_id: "ING007",
      item_name: "Garlic Powder",
      category: "Ingredient",
      purchase_unit: "kg",
      usage_unit: "gr",
      conversion: 1000,
      par_level: 100,
      is_active: true,
    },
    {
      item_id: "ING008",
      item_name: "Pala Kupas",
      category: "Ingredient",
      purchase_unit: "kg",
      usage_unit: "gr",
      conversion: 1000,
      par_level: 50,
      is_active: true,
    },
    {
      item_id: "ING009",
      item_name: "Cheese Mild",
      category: "Ingredient",
      purchase_unit: "kg",
      usage_unit: "gr",
      conversion: 1000,
      par_level: 300,
      is_active: true,
    },
    {
      item_id: "ING010",
      item_name: "Garam",
      category: "Ingredient",
      purchase_unit: "kg",
      usage_unit: "gr",
      conversion: 1000,
      par_level: 200,
      is_active: true,
    },
    {
      item_id: "ING011",
      item_name: "Gula Pasir",
      category: "Ingredient",
      purchase_unit: "kg",
      usage_unit: "gr",
      conversion: 1000,
      par_level: 300,
      is_active: true,
    },
    {
      item_id: "ING012",
      item_name: "Tepung Panir",
      category: "Ingredient",
      purchase_unit: "kg",
      usage_unit: "gr",
      conversion: 1000,
      par_level: 500,
      is_active: true,
    },
    {
      item_id: "ING013",
      item_name: "Yellow Mustard",
      category: "Ingredient",
      purchase_unit: "ltr",
      usage_unit: "ml",
      conversion: 1000,
      par_level: 300,
      is_active: true,
    },
    {
      item_id: "ING014",
      item_name: "BBQ Sauce Can",
      category: "Ingredient",
      purchase_unit: "ltr",
      usage_unit: "ml",
      conversion: 1000,
      par_level: 300,
      is_active: true,
    },
    {
      item_id: "ING015",
      item_name: "Telur Ayam",
      category: "Ingredient",
      purchase_unit: "kg",
      usage_unit: "gr",
      conversion: 1000,
      par_level: 200,
      is_active: true,
    },
    {
      item_id: "ING016",
      item_name: "Daging Giling",
      category: "Ingredient",
      purchase_unit: "kg",
      usage_unit: "gr",
      conversion: 1000,
      par_level: 2000,
      is_active: true,
    },
    {
      item_id: "ING017",
      item_name: "Selada Hijau",
      category: "Ingredient",
      purchase_unit: "kg",
      usage_unit: "gr",
      conversion: 1000,
      par_level: 500,
      is_active: true,
    },
    {
      item_id: "ING018",
      item_name: "Selada Merah",
      category: "Ingredient",
      purchase_unit: "kg",
      usage_unit: "gr",
      conversion: 1000,
      par_level: 500,
      is_active: true,
    },
    {
      item_id: "ING019",
      item_name: "Frisee",
      category: "Ingredient",
      purchase_unit: "kg",
      usage_unit: "gr",
      conversion: 1000,
      par_level: 300,
      is_active: true,
    },
    {
      item_id: "ING020",
      item_name: "Jembak",
      category: "Ingredient",
      purchase_unit: "kg",
      usage_unit: "gr",
      conversion: 1000,
      par_level: 500,
      is_active: true,
    },
    {
      item_id: "ING021",
      item_name: "Tomat Chery",
      category: "Ingredient",
      purchase_unit: "kg",
      usage_unit: "gr",
      conversion: 1000,
      par_level: 200,
      is_active: true,
    },
    {
      item_id: "ING022",
      item_name: "Tomat Besar",
      category: "Ingredient",
      purchase_unit: "kg",
      usage_unit: "gr",
      conversion: 1000,
      par_level: 300,
      is_active: true,
    },
    {
      item_id: "ING023",
      item_name: "Timun",
      category: "Ingredient",
      purchase_unit: "kg",
      usage_unit: "gr",
      conversion: 1000,
      par_level: 300,
      is_active: true,
    },
    {
      item_id: "ING024",
      item_name: "Madu",
      category: "Ingredient",
      purchase_unit: "kg",
      usage_unit: "gr",
      conversion: 1000,
      par_level: 300,
      is_active: true,
    },
    {
      item_id: "ING025",
      item_name: "Jeruk Nipis",
      category: "Ingredient",
      purchase_unit: "kg",
      usage_unit: "gr",
      conversion: 1000,
      par_level: 200,
      is_active: true,
    },
    {
      item_id: "ING026",
      item_name: "Salad Oil",
      category: "Ingredient",
      purchase_unit: "ltr",
      usage_unit: "ml",
      conversion: 1000,
      par_level: 500,
      is_active: true,
    },
    {
      item_id: "ING027",
      item_name: "Acar Gerkien",
      category: "Ingredient",
      purchase_unit: "kg",
      usage_unit: "gr",
      conversion: 1000,
      par_level: 200,
      is_active: true,
    },
    {
      item_id: "ING028",
      item_name: "Mixed Cajun",
      category: "Ingredient",
      purchase_unit: "kg",
      usage_unit: "gr",
      conversion: 1000,
      par_level: 200,
      is_active: true,
    },
    {
      item_id: "ING029",
      item_name: "Cheese Slice",
      category: "Ingredient",
      purchase_unit: "pcs",
      usage_unit: "pcs",
      conversion: 12,
      par_level: 24,
      is_active: true,
    },
    {
      item_id: "ING030",
      item_name: "Wagyu Striploin",
      category: "Ingredient",
      purchase_unit: "kg",
      usage_unit: "gr",
      conversion: 1000,
      par_level: 2000,
      is_active: true,
    },
    {
      item_id: "ING031",
      item_name: "Butter",
      category: "Ingredient",
      purchase_unit: "kg",
      usage_unit: "gr",
      conversion: 1000,
      par_level: 300,
      is_active: true,
    },
    {
      item_id: "ING032",
      item_name: "Worcestershire",
      category: "Ingredient",
      purchase_unit: "ltr",
      usage_unit: "ml",
      conversion: 1000,
      par_level: 200,
      is_active: true,
    },
    {
      item_id: "ING033",
      item_name: "Burger Bun",
      category: "Ingredient",
      purchase_unit: "pcs",
      usage_unit: "pcs",
      conversion: 1,
      par_level: 20,
      is_active: true,
    },
    {
      item_id: "ING034",
      item_name: "Bawang Bombay",
      category: "Ingredient",
      purchase_unit: "kg",
      usage_unit: "gr",
      conversion: 1000,
      par_level: 300,
      is_active: true,
    },
    {
      item_id: "PREP001",
      item_name: "Potato Wedges",
      category: "Prep",
      purchase_unit: null,
      usage_unit: "gr",
      conversion: 1,
      par_level: 500,
      is_active: true,
    },
    {
      item_id: "PREP002",
      item_name: "Home FF",
      category: "Prep",
      purchase_unit: null,
      usage_unit: "gr",
      conversion: 1,
      par_level: 800,
      is_active: true,
    },
    {
      item_id: "PREP003",
      item_name: "Mashed Potato",
      category: "Prep",
      purchase_unit: null,
      usage_unit: "gr",
      conversion: 1,
      par_level: 500,
      is_active: true,
    },
    {
      item_id: "PREP004",
      item_name: "Mixed Salad",
      category: "Prep",
      purchase_unit: null,
      usage_unit: "gr",
      conversion: 1,
      par_level: 300,
      is_active: true,
    },
    {
      item_id: "PREP005",
      item_name: "Beef Patty",
      category: "Prep",
      purchase_unit: null,
      usage_unit: "pcs",
      conversion: 1,
      par_level: 10,
      is_active: true,
    },
    {
      item_id: "PREP006",
      item_name: "Honey Lime Dressing",
      category: "Prep",
      purchase_unit: null,
      usage_unit: "ml",
      conversion: 1,
      par_level: 200,
      is_active: true,
    },
    {
      item_id: "PREP007",
      item_name: "Cajun Fries",
      category: "Prep",
      purchase_unit: null,
      usage_unit: "gr",
      conversion: 1,
      par_level: 500,
      is_active: true,
    },
    {
      item_id: "DISH001",
      item_name: "Wagyu Striploin Steak",
      category: "Dish",
      purchase_unit: null,
      usage_unit: "portion",
      conversion: 1,
      par_level: 5,
      is_active: true,
    },
    {
      item_id: "DISH002",
      item_name: "Classic Beef Burger",
      category: "Dish",
      purchase_unit: null,
      usage_unit: "portion",
      conversion: 1,
      par_level: 5,
      is_active: true,
    },
    {
      item_id: "DISH003",
      item_name: "Cajun Burger",
      category: "Dish",
      purchase_unit: null,
      usage_unit: "portion",
      conversion: 1,
      par_level: 5,
      is_active: true,
    },
  ];
}

function getMockAllSuppliers() {
  return [
    {
      supplier_id: "SUP001",
      supplier_name: "Sukanda Jaya",
      category: "Dry Goods",
      contact: "021-5555-0101",
      payment_terms: "NET 30",
      is_active: true,
    },
    {
      supplier_id: "SUP002",
      supplier_name: "Wagyu Indo Prima",
      category: "Protein",
      contact: "0812-9999-0202",
      payment_terms: "COD",
      is_active: true,
    },
    {
      supplier_id: "SUP003",
      supplier_name: "Fresh Market Jkt",
      category: "Produce",
      contact: "0821-8888-0303",
      payment_terms: "NET 14",
      is_active: true,
    },
    {
      supplier_id: "SUP004",
      supplier_name: "Anchor Dairy",
      category: "Dairy",
      contact: "021-5555-0404",
      payment_terms: "NET 30",
      is_active: true,
    },
  ];
}

// ── SALES / SERVICE ─────────────────────────────────────────

async function fetchDishItems() {
  const db = await initSupabase();
  if (!db) return getMockDishItems();

  const { data, error } = await db
    .from("items")
    .select("item_id, item_name, usage_unit, category")
    .in("category", ["Dish"])
    .eq("is_active", true)
    .order("item_name");

  if (error) {
    console.error(error);
    return getMockDishItems();
  }
  return data;
}

async function fetchSalesHistory() {
  const db = await initSupabase();
  if (!db) return getMockSalesHistory();

  const { data, error } = await db
    .from("sales_log")
    .select("*, items!sales_log_dish_id_fkey(item_name)")
    .order("date", { ascending: false })
    .limit(60);

  if (error) {
    console.error(error);
    return getMockSalesHistory();
  }
  return data;
}

async function fetchSalesSummary() {
  const db = await initSupabase();
  if (!db) return getMockSalesSummary();

  const { data, error } = await db.from("sales_summary").select("*");

  if (error) {
    console.error(error);
    return getMockSalesSummary();
  }
  return data;
}

async function insertSaleRecord(saleLog, ledgerRows) {
  const db = await initSupabase();
  if (!db) return { error: "Supabase not configured" };

  const { error: saleErr } = await db.from("sales_log").insert(saleLog);

  if (saleErr) return { error: saleErr.message };

  if (ledgerRows.length) {
    const { error: ledgerErr } = await db
      .from("stock_ledger")
      .insert(ledgerRows);
    if (ledgerErr) return { error: ledgerErr.message };
  }

  return { error: null };
}

async function fetchRecipeForDish(dishId) {
  const db = await initSupabase();
  if (!db) return getMockDishRecipe(dishId);

  const { data, error } = await db
    .from("recipes")
    .select(
      "input_item_id, qty, unit, items!recipes_input_item_id_fkey(item_name, usage_unit, category)",
    )
    .eq("output_item_id", dishId)
    .is("valid_to", null);

  if (error) {
    console.error(error);
    return [];
  }
  return data;
}

// ── ADJUSTMENTS ──────────────────────────────────────────────

async function fetchAdjustmentHistory() {
  const db = await initSupabase();
  if (!db) return getMockAdjustments();

  const { data, error } = await db
    .from("adjustments_log")
    .select("*, items(item_name, usage_unit)")
    .order("date", { ascending: false })
    .limit(50);

  if (error) {
    console.error(error);
    return getMockAdjustments();
  }
  return data;
}

async function insertAdjustment(adj, ledgerRow) {
  const db = await initSupabase();
  if (!db) return { error: "Supabase not configured" };

  const { error: adjErr } = await db.from("adjustments_log").insert(adj);

  if (adjErr) return { error: adjErr.message };

  if (ledgerRow.in_qty !== 0 || ledgerRow.out_qty !== 0) {
    const { error: ledgerErr } = await db
      .from("stock_ledger")
      .insert(ledgerRow);
    if (ledgerErr) return { error: ledgerErr.message };
  }

  return { error: null };
}

async function fetchCurrentStockForItem(itemId) {
  const db = await initSupabase();
  if (!db) {
    const stock = getMockStock();
    return stock.find((s) => s.item_id === itemId)?.stock_qty || 0;
  }

  const { data, error } = await db
    .from("current_stock")
    .select("stock_qty")
    .eq("item_id", itemId)
    .single();

  if (error) return 0;
  return data?.stock_qty || 0;
}

// ── LEDGER HISTORY ───────────────────────────────────────────

async function fetchLedgerHistory(filters = {}) {
  const db = await initSupabase();
  if (!db) return getMockLedgerHistory();

  let query = db
    .from("ledger_history")
    .select("*")
    .order("date", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(200);

  if (filters.item_id) query = query.eq("item_id", filters.item_id);
  if (filters.source) query = query.eq("source", filters.source);
  if (filters.from) query = query.gte("date", filters.from);
  if (filters.to) query = query.lte("date", filters.to);

  const { data, error } = await query;
  if (error) {
    console.error(error);
    return getMockLedgerHistory();
  }
  return data;
}

// ── MOCK DATA for new functions ──────────────────────────────

function getMockDishItems() {
  return [
    {
      item_id: "DISH001",
      item_name: "Wagyu Striploin Steak",
      category: "Dish",
      usage_unit: "portion",
    },
    {
      item_id: "DISH002",
      item_name: "Classic Beef Burger",
      category: "Dish",
      usage_unit: "portion",
    },
    {
      item_id: "DISH003",
      item_name: "Cajun Burger",
      category: "Dish",
      usage_unit: "portion",
    },
  ];
}

function getMockDishRecipe(dishId) {
  const recipes = {
    DISH001: [
      {
        input_item_id: "ING030",
        qty: 200,
        unit: "gr",
        items: {
          item_name: "Wagyu Striploin",
          usage_unit: "gr",
          category: "Ingredient",
        },
      },
      {
        input_item_id: "ING031",
        qty: 20,
        unit: "gr",
        items: {
          item_name: "Butter",
          usage_unit: "gr",
          category: "Ingredient",
        },
      },
      {
        input_item_id: "ING010",
        qty: 3,
        unit: "gr",
        items: { item_name: "Garam", usage_unit: "gr", category: "Ingredient" },
      },
      {
        input_item_id: "ING005",
        qty: 2,
        unit: "gr",
        items: {
          item_name: "Lada Hitam",
          usage_unit: "gr",
          category: "Ingredient",
        },
      },
      {
        input_item_id: "ING032",
        qty: 10,
        unit: "ml",
        items: {
          item_name: "Worcestershire",
          usage_unit: "ml",
          category: "Ingredient",
        },
      },
      {
        input_item_id: "PREP003",
        qty: 100,
        unit: "gr",
        items: {
          item_name: "Mashed Potato",
          usage_unit: "gr",
          category: "Prep",
        },
      },
      {
        input_item_id: "PREP001",
        qty: 105,
        unit: "gr",
        items: {
          item_name: "Potato Wedges",
          usage_unit: "gr",
          category: "Prep",
        },
      },
      {
        input_item_id: "PREP004",
        qty: 92,
        unit: "gr",
        items: { item_name: "Mixed Salad", usage_unit: "gr", category: "Prep" },
      },
    ],
    DISH002: [
      {
        input_item_id: "PREP005",
        qty: 1,
        unit: "pcs",
        items: { item_name: "Beef Patty", usage_unit: "pcs", category: "Prep" },
      },
      {
        input_item_id: "ING033",
        qty: 1,
        unit: "pcs",
        items: {
          item_name: "Burger Bun",
          usage_unit: "pcs",
          category: "Ingredient",
        },
      },
      {
        input_item_id: "ING029",
        qty: 2,
        unit: "pcs",
        items: {
          item_name: "Cheese Slice",
          usage_unit: "pcs",
          category: "Ingredient",
        },
      },
      {
        input_item_id: "ING017",
        qty: 30,
        unit: "gr",
        items: {
          item_name: "Selada Hijau",
          usage_unit: "gr",
          category: "Ingredient",
        },
      },
      {
        input_item_id: "ING022",
        qty: 40,
        unit: "gr",
        items: {
          item_name: "Tomat Besar",
          usage_unit: "gr",
          category: "Ingredient",
        },
      },
      {
        input_item_id: "ING023",
        qty: 30,
        unit: "gr",
        items: { item_name: "Timun", usage_unit: "gr", category: "Ingredient" },
      },
      {
        input_item_id: "ING027",
        qty: 20,
        unit: "gr",
        items: {
          item_name: "Acar Gerkien",
          usage_unit: "gr",
          category: "Ingredient",
        },
      },
      {
        input_item_id: "ING013",
        qty: 15,
        unit: "ml",
        items: {
          item_name: "Yellow Mustard",
          usage_unit: "ml",
          category: "Ingredient",
        },
      },
      {
        input_item_id: "PREP001",
        qty: 105,
        unit: "gr",
        items: {
          item_name: "Potato Wedges",
          usage_unit: "gr",
          category: "Prep",
        },
      },
      {
        input_item_id: "PREP004",
        qty: 92,
        unit: "gr",
        items: { item_name: "Mixed Salad", usage_unit: "gr", category: "Prep" },
      },
    ],
    DISH003: [
      {
        input_item_id: "PREP005",
        qty: 1,
        unit: "pcs",
        items: { item_name: "Beef Patty", usage_unit: "pcs", category: "Prep" },
      },
      {
        input_item_id: "ING033",
        qty: 1,
        unit: "pcs",
        items: {
          item_name: "Burger Bun",
          usage_unit: "pcs",
          category: "Ingredient",
        },
      },
      {
        input_item_id: "ING029",
        qty: 1,
        unit: "pcs",
        items: {
          item_name: "Cheese Slice",
          usage_unit: "pcs",
          category: "Ingredient",
        },
      },
      {
        input_item_id: "ING017",
        qty: 30,
        unit: "gr",
        items: {
          item_name: "Selada Hijau",
          usage_unit: "gr",
          category: "Ingredient",
        },
      },
      {
        input_item_id: "ING022",
        qty: 40,
        unit: "gr",
        items: {
          item_name: "Tomat Besar",
          usage_unit: "gr",
          category: "Ingredient",
        },
      },
      {
        input_item_id: "ING027",
        qty: 20,
        unit: "gr",
        items: {
          item_name: "Acar Gerkien",
          usage_unit: "gr",
          category: "Ingredient",
        },
      },
      {
        input_item_id: "ING028",
        qty: 10,
        unit: "gr",
        items: {
          item_name: "Mixed Cajun",
          usage_unit: "gr",
          category: "Ingredient",
        },
      },
      {
        input_item_id: "PREP007",
        qty: 105,
        unit: "gr",
        items: { item_name: "Cajun Fries", usage_unit: "gr", category: "Prep" },
      },
      {
        input_item_id: "PREP004",
        qty: 92,
        unit: "gr",
        items: { item_name: "Mixed Salad", usage_unit: "gr", category: "Prep" },
      },
    ],
  };
  return recipes[dishId] || [];
}

function getMockSalesHistory() {
  return [
    {
      id: "SL-20250319-003",
      date: "2025-03-19",
      dish_id: "DISH003",
      items: { item_name: "Cajun Burger" },
      qty_sold: 5,
      unit_price: 165000,
      source: "manual",
    },
    {
      id: "SL-20250319-002",
      date: "2025-03-19",
      dish_id: "DISH002",
      items: { item_name: "Classic Beef Burger" },
      qty_sold: 8,
      unit_price: 155000,
      source: "manual",
    },
    {
      id: "SL-20250319-001",
      date: "2025-03-19",
      dish_id: "DISH001",
      items: { item_name: "Wagyu Striploin Steak" },
      qty_sold: 7,
      unit_price: 285000,
      source: "manual",
    },
    {
      id: "SL-20250318-002",
      date: "2025-03-18",
      dish_id: "DISH002",
      items: { item_name: "Classic Beef Burger" },
      qty_sold: 14,
      unit_price: 155000,
      source: "manual",
    },
    {
      id: "SL-20250318-001",
      date: "2025-03-18",
      dish_id: "DISH001",
      items: { item_name: "Wagyu Striploin Steak" },
      qty_sold: 11,
      unit_price: 285000,
      source: "manual",
    },
    {
      id: "SL-20250317-003",
      date: "2025-03-17",
      dish_id: "DISH003",
      items: { item_name: "Cajun Burger" },
      qty_sold: 7,
      unit_price: 165000,
      source: "manual",
    },
    {
      id: "SL-20250317-002",
      date: "2025-03-17",
      dish_id: "DISH002",
      items: { item_name: "Classic Beef Burger" },
      qty_sold: 9,
      unit_price: 155000,
      source: "manual",
    },
    {
      id: "SL-20250317-001",
      date: "2025-03-17",
      dish_id: "DISH001",
      items: { item_name: "Wagyu Striploin Steak" },
      qty_sold: 5,
      unit_price: 285000,
      source: "manual",
    },
    {
      id: "SL-20250316-002",
      date: "2025-03-16",
      dish_id: "DISH002",
      items: { item_name: "Classic Beef Burger" },
      qty_sold: 12,
      unit_price: 155000,
      source: "manual",
    },
    {
      id: "SL-20250316-001",
      date: "2025-03-16",
      dish_id: "DISH001",
      items: { item_name: "Wagyu Striploin Steak" },
      qty_sold: 8,
      unit_price: 285000,
      source: "manual",
    },
    {
      id: "SL-20250315-003",
      date: "2025-03-15",
      dish_id: "DISH003",
      items: { item_name: "Cajun Burger" },
      qty_sold: 4,
      unit_price: 165000,
      source: "manual",
    },
    {
      id: "SL-20250315-002",
      date: "2025-03-15",
      dish_id: "DISH002",
      items: { item_name: "Classic Beef Burger" },
      qty_sold: 10,
      unit_price: 155000,
      source: "manual",
    },
    {
      id: "SL-20250315-001",
      date: "2025-03-15",
      dish_id: "DISH001",
      items: { item_name: "Wagyu Striploin Steak" },
      qty_sold: 6,
      unit_price: 285000,
      source: "manual",
    },
  ];
}

function getMockSalesSummary() {
  return [
    {
      item_id: "DISH002",
      item_name: "Classic Beef Burger",
      total_sold: 53,
      sale_entries: 5,
      last_sale: "2025-03-19",
    },
    {
      item_id: "DISH001",
      item_name: "Wagyu Striploin Steak",
      total_sold: 37,
      sale_entries: 5,
      last_sale: "2025-03-19",
    },
    {
      item_id: "DISH003",
      item_name: "Cajun Burger",
      total_sold: 16,
      sale_entries: 3,
      last_sale: "2025-03-19",
    },
  ];
}

function getMockAdjustments() {
  return [];
}

function getMockLedgerHistory() {
  return [
    {
      tx_id: "a1",
      date: "2025-03-19",
      item_id: "PREP001",
      item_name: "Potato Wedges",
      category: "Prep",
      usage_unit: "gr",
      in_qty: 2050,
      out_qty: 0,
      net_qty: 2050,
      source: "PROD_OUT",
      ref: "BK008",
      notes: null,
    },
    {
      tx_id: "a2",
      date: "2025-03-19",
      item_id: "ING003",
      item_name: "Kentang",
      category: "Ingredient",
      usage_unit: "gr",
      in_qty: 0,
      out_qty: 2000,
      net_qty: -2000,
      source: "PROD_USE",
      ref: "BK008",
      notes: null,
    },
    {
      tx_id: "a3",
      date: "2025-03-18",
      item_id: "PREP005",
      item_name: "Beef Patty",
      category: "Prep",
      usage_unit: "pcs",
      in_qty: 86,
      out_qty: 0,
      net_qty: 86,
      source: "PROD_OUT",
      ref: "BK006",
      notes: null,
    },
    {
      tx_id: "a4",
      date: "2025-03-18",
      item_id: "ING016",
      item_name: "Daging Giling",
      category: "Ingredient",
      usage_unit: "gr",
      in_qty: 0,
      out_qty: 5805,
      net_qty: -5805,
      source: "PROD_USE",
      ref: "BK006",
      notes: null,
    },
    {
      tx_id: "a5",
      date: "2025-03-15",
      item_id: "PREP005",
      item_name: "Beef Patty",
      category: "Prep",
      usage_unit: "pcs",
      in_qty: 0,
      out_qty: 10,
      net_qty: -10,
      source: "SALE",
      ref: "SL-20250315-002",
      notes: "Beef Patty 1pcs × 10",
    },
    {
      tx_id: "a6",
      date: "2025-03-15",
      item_id: "PREP003",
      item_name: "Mashed Potato",
      category: "Prep",
      usage_unit: "gr",
      in_qty: 0,
      out_qty: 600,
      net_qty: -600,
      source: "SALE",
      ref: "SL-20250315-001",
      notes: "Mashed Potato 100gr × 6",
    },
    {
      tx_id: "a7",
      date: "2025-03-10",
      item_id: "ING016",
      item_name: "Daging Giling",
      category: "Ingredient",
      usage_unit: "gr",
      in_qty: 5000,
      out_qty: 0,
      net_qty: 5000,
      source: "PURCHASE",
      ref: "PO-MAR-005",
      notes: null,
    },
    {
      tx_id: "a8",
      date: "2025-02-01",
      item_id: "ING016",
      item_name: "Daging Giling",
      category: "Ingredient",
      usage_unit: "gr",
      in_qty: 5000,
      out_qty: 0,
      net_qty: 5000,
      source: "OPENING",
      ref: "OPEN-FEB",
      notes: null,
    },
  ];
}

// ── COST MANAGEMENT ──────────────────────────────────────────

async function fetchIngredientCosts() {
  const db = await initSupabase();
  if (!db) return getMockIngredientCosts();

  const { data, error } = await db
    .from("ingredient_cost")
    .select("*")
    .order("category")
    .order("item_name");

  if (error) {
    console.error(error);
    return getMockIngredientCosts();
  }
  return data;
}

async function updateCostOverride(itemId, override, note) {
  const db = await initSupabase();
  if (!db) return { error: null };

  const { error } = await db
    .from("items")
    .update({
      cost_override: override,
      cost_override_note: note || null,
      cost_override_updated: new Date().toISOString(),
    })
    .eq("item_id", itemId);

  return { error: error?.message || null };
}

async function fetchRecipeCosts() {
  const db = await initSupabase();
  if (!db) return getMockRecipeCosts();

  const { data, error } = await db
    .from("recipe_cost")
    .select("*")
    .order("category")
    .order("recipe_name");

  if (error) {
    console.error(error);
    return getMockRecipeCosts();
  }
  return data;
}

async function fetchRecipeCostLines(outputItemId) {
  const db = await initSupabase();
  if (!db) return getMockRecipeCostLines(outputItemId);

  const { data, error } = await db
    .from("recipe_cost_lines")
    .select("*")
    .eq("output_item_id", outputItemId);

  if (error) {
    console.error(error);
    return [];
  }
  return data;
}

// ── CALCULATOR ───────────────────────────────────────────────

async function fetchCalculatorSessions() {
  const db = await initSupabase();
  if (!db) return getMockCalcSessions();

  const { data, error } = await db
    .from("calculator_sessions")
    .select("*")
    .order("updated_at", { ascending: false });

  if (error) {
    console.error(error);
    return getMockCalcSessions();
  }
  return data;
}

async function fetchCalculatorLines(sessionId) {
  const db = await initSupabase();
  if (!db) return getMockCalcLines(sessionId);

  const { data, error } = await db
    .from("calculator_lines")
    .select("*")
    .eq("session_id", sessionId)
    .order("sort_order");

  if (error) {
    console.error(error);
    return [];
  }
  return data;
}

async function createCalculatorSession(name, notes) {
  const db = await initSupabase();
  if (!db)
    return { data: { id: "mock-" + Date.now(), name, notes }, error: null };

  const { data, error } = await db
    .from("calculator_sessions")
    .insert({ name, notes: notes || null })
    .select()
    .single();

  return { data, error: error?.message || null };
}

async function saveCalculatorLines(sessionId, lines) {
  const db = await initSupabase();
  if (!db) return { error: null };

  // Delete existing lines then re-insert (simple replace strategy)
  await db.from("calculator_lines").delete().eq("session_id", sessionId);

  if (!lines.length) return { error: null };

  const rows = lines.map((l, i) => ({
    session_id: sessionId,
    item_id: l.item_id || null,
    custom_name: l.item_id ? null : l.name,
    qty: l.qty,
    unit: l.unit,
    manual_cost: l.manual_cost,
    sort_order: i,
  }));

  const { error } = await db.from("calculator_lines").insert(rows);

  // Touch updated_at on session
  await db
    .from("calculator_sessions")
    .update({ updated_at: new Date().toISOString() })
    .eq("id", sessionId);

  return { error: error?.message || null };
}

async function deleteCalculatorSession(sessionId) {
  const db = await initSupabase();
  if (!db) return { error: null };

  const { error } = await db
    .from("calculator_sessions")
    .delete()
    .eq("id", sessionId);

  return { error: error?.message || null };
}

// ── MOCK DATA ─────────────────────────────────────────────────

function getMockIngredientCosts() {
  // resolved_cost = cost_override ?? last_purchase_cost (per usage unit)
  // last_purchase_cost = unit_price / conversion
  return [
    {
      item_id: "ING001",
      item_name: "Whip Cream",
      category: "Ingredient",
      usage_unit: "ml",
      cost_override: null,
      last_purchase_cost: 45,
      resolved_cost: 45,
      cost_source: "purchase",
      last_purchase_date: "2025-03-01",
    },
    {
      item_id: "ING002",
      item_name: "Fresh Milk",
      category: "Ingredient",
      usage_unit: "ml",
      cost_override: null,
      last_purchase_cost: 22,
      resolved_cost: 22,
      cost_source: "purchase",
      last_purchase_date: "2025-03-01",
    },
    {
      item_id: "ING003",
      item_name: "Kentang",
      category: "Ingredient",
      usage_unit: "gr",
      cost_override: null,
      last_purchase_cost: 15,
      resolved_cost: 15,
      cost_source: "purchase",
      last_purchase_date: "2025-03-01",
    },
    {
      item_id: "ING004",
      item_name: "Beef Powder",
      category: "Ingredient",
      usage_unit: "gr",
      cost_override: null,
      last_purchase_cost: null,
      resolved_cost: null,
      cost_source: "uncosted",
      last_purchase_date: null,
    },
    {
      item_id: "ING005",
      item_name: "Lada Hitam",
      category: "Ingredient",
      usage_unit: "gr",
      cost_override: 15,
      last_purchase_cost: null,
      resolved_cost: 15,
      cost_source: "override",
      last_purchase_date: null,
    },
    {
      item_id: "ING006",
      item_name: "Lada Putih",
      category: "Ingredient",
      usage_unit: "gr",
      cost_override: 15,
      last_purchase_cost: null,
      resolved_cost: 15,
      cost_source: "override",
      last_purchase_date: null,
    },
    {
      item_id: "ING007",
      item_name: "Garlic Powder",
      category: "Ingredient",
      usage_unit: "gr",
      cost_override: 15,
      last_purchase_cost: null,
      resolved_cost: 15,
      cost_source: "override",
      last_purchase_date: null,
    },
    {
      item_id: "ING009",
      item_name: "Cheese Mild",
      category: "Ingredient",
      usage_unit: "gr",
      cost_override: null,
      last_purchase_cost: null,
      resolved_cost: null,
      cost_source: "uncosted",
      last_purchase_date: null,
    },
    {
      item_id: "ING010",
      item_name: "Garam",
      category: "Ingredient",
      usage_unit: "gr",
      cost_override: 15,
      last_purchase_cost: null,
      resolved_cost: 15,
      cost_source: "override",
      last_purchase_date: null,
    },
    {
      item_id: "ING011",
      item_name: "Gula Pasir",
      category: "Ingredient",
      usage_unit: "gr",
      cost_override: 15,
      last_purchase_cost: null,
      resolved_cost: 15,
      cost_source: "override",
      last_purchase_date: null,
    },
    {
      item_id: "ING012",
      item_name: "Tepung Panir",
      category: "Ingredient",
      usage_unit: "gr",
      cost_override: null,
      last_purchase_cost: 28,
      resolved_cost: 28,
      cost_source: "purchase",
      last_purchase_date: "2025-03-05",
    },
    {
      item_id: "ING013",
      item_name: "Yellow Mustard",
      category: "Ingredient",
      usage_unit: "ml",
      cost_override: null,
      last_purchase_cost: null,
      resolved_cost: null,
      cost_source: "uncosted",
      last_purchase_date: null,
    },
    {
      item_id: "ING015",
      item_name: "Telur Ayam",
      category: "Ingredient",
      usage_unit: "gr",
      cost_override: null,
      last_purchase_cost: null,
      resolved_cost: null,
      cost_source: "uncosted",
      last_purchase_date: null,
    },
    {
      item_id: "ING016",
      item_name: "Daging Giling",
      category: "Ingredient",
      usage_unit: "gr",
      cost_override: null,
      last_purchase_cost: 88,
      resolved_cost: 88,
      cost_source: "purchase",
      last_purchase_date: "2025-03-10",
    },
    {
      item_id: "ING017",
      item_name: "Selada Hijau",
      category: "Ingredient",
      usage_unit: "gr",
      cost_override: null,
      last_purchase_cost: 35,
      resolved_cost: 35,
      cost_source: "purchase",
      last_purchase_date: "2025-03-10",
    },
    {
      item_id: "ING018",
      item_name: "Selada Merah",
      category: "Ingredient",
      usage_unit: "gr",
      cost_override: null,
      last_purchase_cost: 35,
      resolved_cost: 35,
      cost_source: "purchase",
      last_purchase_date: "2025-03-10",
    },
    {
      item_id: "ING030",
      item_name: "Wagyu Striploin",
      category: "Ingredient",
      usage_unit: "gr",
      cost_override: null,
      last_purchase_cost: 450,
      resolved_cost: 450,
      cost_source: "purchase",
      last_purchase_date: "2025-03-01",
    },
  ];
}

function getMockRecipeCosts() {
  return [
    {
      output_item_id: "PREP001",
      recipe_name: "Potato Wedges",
      category: "Prep",
      standard_yield_gram: 1050,
      portion_gram: 105,
      portions_per_batch: 10,
      total_batch_cost: 15250,
      cost_per_portion: 1525,
      has_uncosted_ingredients: false,
      uncosted_line_count: 0,
      total_line_count: 3,
    },
    {
      output_item_id: "PREP002",
      recipe_name: "Home FF",
      category: "Prep",
      standard_yield_gram: 8100,
      portion_gram: 150,
      portions_per_batch: 54,
      total_batch_cost: 121850,
      cost_per_portion: 2256,
      has_uncosted_ingredients: false,
      uncosted_line_count: 0,
      total_line_count: 4,
    },
    {
      output_item_id: "PREP003",
      recipe_name: "Mashed Potato",
      category: "Prep",
      standard_yield_gram: 1500,
      portion_gram: 100,
      portions_per_batch: 15,
      total_batch_cost: 42720,
      cost_per_portion: 2848,
      has_uncosted_ingredients: false,
      uncosted_line_count: 0,
      total_line_count: 7,
    },
    {
      output_item_id: "PREP004",
      recipe_name: "Mixed Salad",
      category: "Prep",
      standard_yield_gram: 4600,
      portion_gram: 92,
      portions_per_batch: 50,
      total_batch_cost: 108500,
      cost_per_portion: 2170,
      has_uncosted_ingredients: false,
      uncosted_line_count: 0,
      total_line_count: 5,
    },
    {
      output_item_id: "PREP005",
      recipe_name: "Beef Patty",
      category: "Prep",
      standard_yield_gram: 4430,
      portion_gram: 100,
      portions_per_batch: 44.3,
      total_batch_cost: 277150,
      cost_per_portion: 6257,
      has_uncosted_ingredients: true,
      uncosted_line_count: 2,
      total_line_count: 8,
    },
    {
      output_item_id: "PREP006",
      recipe_name: "Honey Lime Dressing",
      category: "Prep",
      standard_yield_gram: 3800,
      portion_gram: 190,
      portions_per_batch: 20,
      total_batch_cost: null,
      cost_per_portion: null,
      has_uncosted_ingredients: true,
      uncosted_line_count: 2,
      total_line_count: 4,
    },
    {
      output_item_id: "DISH001",
      recipe_name: "Wagyu Striploin Steak",
      category: "Dish",
      standard_yield_gram: 1,
      portion_gram: 1,
      portions_per_batch: 1,
      total_batch_cost: 119835,
      cost_per_portion: 119835,
      has_uncosted_ingredients: false,
      uncosted_line_count: 0,
      total_line_count: 8,
    },
    {
      output_item_id: "DISH002",
      recipe_name: "Classic Beef Burger",
      category: "Dish",
      standard_yield_gram: 1,
      portion_gram: 1,
      portions_per_batch: 1,
      total_batch_cost: 25840,
      cost_per_portion: 25840,
      has_uncosted_ingredients: true,
      uncosted_line_count: 1,
      total_line_count: 10,
    },
  ];
}

function getMockRecipeCostLines(outputItemId) {
  const lines = {
    PREP001: [
      {
        input_item_id: "ING003",
        input_name: "Kentang",
        input_category: "Ingredient",
        cost_source: "purchase",
        qty: 1000,
        unit: "gr",
        unit_cost: 15,
        line_total: 15000,
        is_uncosted: false,
      },
      {
        input_item_id: "ING005",
        input_name: "Lada Hitam",
        input_category: "Ingredient",
        cost_source: "override",
        qty: 25,
        unit: "gr",
        unit_cost: 15,
        line_total: 375,
        is_uncosted: false,
      },
      {
        input_item_id: "ING004",
        input_name: "Beef Powder",
        input_category: "Ingredient",
        cost_source: "uncosted",
        qty: 25,
        unit: "gr",
        unit_cost: 0,
        line_total: 0,
        is_uncosted: true,
      },
    ],
    PREP005: [
      {
        input_item_id: "ING016",
        input_name: "Daging Giling",
        input_category: "Ingredient",
        cost_source: "purchase",
        qty: 3000,
        unit: "gr",
        unit_cost: 88,
        line_total: 264000,
        is_uncosted: false,
      },
      {
        input_item_id: "ING013",
        input_name: "Yellow Mustard",
        input_category: "Ingredient",
        cost_source: "uncosted",
        qty: 100,
        unit: "ml",
        unit_cost: 0,
        line_total: 0,
        is_uncosted: true,
      },
      {
        input_item_id: "ING005",
        input_name: "Lada Hitam",
        input_category: "Ingredient",
        cost_source: "override",
        qty: 15,
        unit: "gr",
        unit_cost: 15,
        line_total: 225,
        is_uncosted: false,
      },
      {
        input_item_id: "ING004",
        input_name: "Beef Powder",
        input_category: "Ingredient",
        cost_source: "uncosted",
        qty: 100,
        unit: "gr",
        unit_cost: 0,
        line_total: 0,
        is_uncosted: true,
      },
      {
        input_item_id: "ING015",
        input_name: "Telur Ayam",
        input_category: "Ingredient",
        cost_source: "purchase",
        qty: 50,
        unit: "gr",
        unit_cost: 18,
        line_total: 900,
        is_uncosted: false,
      },
      {
        input_item_id: "ING012",
        input_name: "Tepung Panir",
        input_category: "Ingredient",
        cost_source: "purchase",
        qty: 500,
        unit: "gr",
        unit_cost: 28,
        line_total: 14000,
        is_uncosted: false,
      },
      {
        input_item_id: "ING014",
        input_name: "BBQ Sauce Can",
        input_category: "Ingredient",
        cost_source: "uncosted",
        qty: 200,
        unit: "ml",
        unit_cost: 0,
        line_total: 0,
        is_uncosted: true,
      },
      {
        input_item_id: "ING011",
        input_name: "Gula Pasir",
        input_category: "Ingredient",
        cost_source: "override",
        qty: 15,
        unit: "gr",
        unit_cost: 15,
        line_total: 225,
        is_uncosted: false,
      },
    ],
    DISH001: [
      {
        input_item_id: "ING030",
        input_name: "Wagyu Striploin",
        input_category: "Ingredient",
        cost_source: "purchase",
        qty: 200,
        unit: "gr",
        unit_cost: 450,
        line_total: 90000,
        is_uncosted: false,
      },
      {
        input_item_id: "ING031",
        input_name: "Butter",
        input_category: "Ingredient",
        cost_source: "uncosted",
        qty: 20,
        unit: "gr",
        unit_cost: 0,
        line_total: 0,
        is_uncosted: true,
      },
      {
        input_item_id: "PREP003",
        input_name: "Mashed Potato",
        input_category: "Prep",
        cost_source: "purchase",
        qty: 100,
        unit: "gr",
        unit_cost: 28.5,
        line_total: 2850,
        is_uncosted: false,
      },
      {
        input_item_id: "PREP001",
        input_name: "Potato Wedges",
        input_category: "Prep",
        cost_source: "purchase",
        qty: 105,
        unit: "gr",
        unit_cost: 14.5,
        line_total: 1523,
        is_uncosted: false,
      },
      {
        input_item_id: "PREP004",
        input_name: "Mixed Salad",
        input_category: "Prep",
        cost_source: "purchase",
        qty: 92,
        unit: "gr",
        unit_cost: 23.6,
        line_total: 2171,
        is_uncosted: false,
      },
    ],
  };
  return lines[outputItemId] || [];
}

function getMockCalcSessions() {
  return [
    {
      id: "calc-001",
      name: "Truffle Burger",
      notes: "New menu item for Q2",
      created_at: "2025-03-18T10:00:00Z",
      updated_at: "2025-03-18T10:30:00Z",
    },
    {
      id: "calc-002",
      name: "Salmon Pasta Test",
      notes: null,
      created_at: "2025-03-15T14:00:00Z",
      updated_at: "2025-03-15T14:00:00Z",
    },
  ];
}

function getMockCalcLines(sessionId) {
  const lines = {
    "calc-001": [
      {
        id: "cl-1",
        session_id: "calc-001",
        item_id: "ING016",
        custom_name: null,
        qty: 150,
        unit: "gr",
        manual_cost: 88,
        line_total: 13200,
      },
      {
        id: "cl-2",
        session_id: "calc-001",
        item_id: null,
        custom_name: "Truffle Oil",
        qty: 10,
        unit: "ml",
        manual_cost: 500,
        line_total: 5000,
      },
      {
        id: "cl-3",
        session_id: "calc-001",
        item_id: "ING033",
        custom_name: null,
        qty: 1,
        unit: "pcs",
        manual_cost: 3500,
        line_total: 3500,
      },
    ],
    "calc-002": [],
  };
  return lines[sessionId] || [];
}
// ── WASTE ─────────────────────────────────────────────────────

async function fetchWasteHistory() {
  const db = await initSupabase();
  if (!db) return [];

  const { data, error } = await db
    .from("waste_log")
    .select("*, items(item_name, category, usage_unit)")
    .order("date", { ascending: false })
    .limit(100);

  if (error) {
    console.error(error);
    return [];
  }
  return data;
}

async function insertWasteRecord(wasteLog, ledgerRow) {
  const db = await initSupabase();
  if (!db) return { error: "Supabase not configured" };

  const { error: wasteErr } = await db.from("waste_log").insert(wasteLog);

  if (wasteErr) return { error: wasteErr.message };

  const { error: ledgerErr } = await db.from("stock_ledger").insert(ledgerRow);

  if (ledgerErr) return { error: ledgerErr.message };

  return { error: null };
}
