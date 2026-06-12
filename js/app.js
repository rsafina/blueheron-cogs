// ============================================================
// BLUE HERON JOGJA — App Controller
// Handles navigation, rendering, and form submission
// ============================================================

// ── INIT ────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
  setDate();
  checkConfig();
  initNav();
  loadPage("dashboard");
});

function setDate() {
  const d = new Date();
  const opts = {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  };
  document.getElementById("page-date").textContent = d.toLocaleDateString(
    "en-ID",
    opts,
  );
}

function checkConfig() {
  if (!SUPABASE_CONFIGURED) {
    document.getElementById("config-notice").classList.add("visible");
  }
}

// ── NAVIGATION ──────────────────────────────────────────────

function initNav() {
  document.querySelectorAll(".nav-item").forEach((link) => {
    link.addEventListener("click", (e) => {
      e.preventDefault();
      const page = link.dataset.page;
      document
        .querySelectorAll(".nav-item")
        .forEach((l) => l.classList.remove("active"));
      link.classList.add("active");
      document
        .querySelectorAll(".page")
        .forEach((p) => p.classList.remove("active"));
      document.getElementById("page-" + page).classList.add("active");
      const titles = {
        dashboard: "Overview",
        production: "Production",
        stock: "Stock",
        purchases: "Purchases",
        recipes: "Recipes",
        items: "Item Master",
        suppliers: "Suppliers",
        service: "Service",
        adjustments: "Adjustments",
        ledger: "Ledger",
        costing: "Costing",
        calculator: "Calculator",
      };
      document.getElementById("page-title").textContent = titles[page] || page;
      loadPage(page);
    });
  });

  document.getElementById("btn-refresh").addEventListener("click", () => {
    const active =
      document.querySelector(".nav-item.active")?.dataset.page || "dashboard";
    const btn = document.getElementById("btn-refresh");
    btn.classList.add("spinning");
    loadPage(active).finally(() => btn.classList.remove("spinning"));
  });
}

async function loadPage(page) {
  switch (page) {
    case "dashboard":
      return loadDashboard();
    case "production":
      return loadProduction();
    case "stock":
      return loadStock();
    case "purchases":
      return loadPurchases();
    case "recipes":
      return loadRecipes();
    case "items":
      return loadItems();
    case "suppliers":
      return loadSuppliers();
    case "service":
      return loadService();
    case "adjustments":
      return loadAdjustments();
    case "ledger":
      return loadLedger();
    case "costing":
      return loadCosting();
    case "calculator":
      return loadCalculator();
  }
}

// ── DASHBOARD ───────────────────────────────────────────────

async function loadDashboard() {
  const [stock, portions, batches] = await Promise.all([
    fetchCurrentStock(),
    fetchPortionAvailability(),
    fetchProductionLogs(),
  ]);

  renderStatCards(stock, batches);
  renderCapacityList(portions);
  renderPrepList(portions);
  renderEfficiencyChart(batches.slice(0, 8));
  renderAlertList(stock);
}

function renderStatCards(stock, batches) {
  const ok = stock.filter((s) => s.stock_status === "ok").length;
  const low = stock.filter((s) => s.stock_status === "low").length;
  const critical = stock.filter((s) => s.stock_status === "critical").length;

  const weekAgo = new Date();
  weekAgo.setDate(weekAgo.getDate() - 7);
  const batchCount = batches.filter((b) => new Date(b.date) >= weekAgo).length;

  document.getElementById("stat-ok-val").textContent = ok;
  document.getElementById("stat-low-val").textContent = low;
  document.getElementById("stat-critical-val").textContent = critical;
  document.getElementById("stat-batches-val").textContent = batchCount;
}

function renderCapacityList(portions) {
  const el = document.getElementById("capacity-list");
  if (!portions.length) {
    el.innerHTML = '<div class="loading-row">No prep data</div>';
    return;
  }

  const maxPortions = Math.max(
    ...portions.map((p) => p.portions_available || 0),
    1,
  );

  el.innerHTML = portions
    .map((p) => {
      const pct = Math.min(
        100,
        Math.round(((p.portions_available || 0) / maxPortions) * 100),
      );
      const status = p.stock_status;
      return `
      <div class="cap-row status-${status}">
        <span class="cap-name">${p.item_name}</span>
        <span class="cap-portions">${p.portions_available ?? 0}</span>
        <span class="cap-label">portions</span>
        <div class="cap-bar-wrap">
          <div class="cap-bar" style="width:${pct}%"></div>
        </div>
      </div>`;
    })
    .join("");
}

function renderPrepList(portions) {
  const el = document.getElementById("prep-list");
  if (!portions.length) {
    el.innerHTML = '<div class="loading-row">No prep data</div>';
    return;
  }

  el.innerHTML = portions
    .map((p) => {
      const status = p.stock_status;
      const qty = fmtNum(p.stock_qty);
      const unit = p.usage_unit || "gr";
      const statusLabel =
        status === "ok" ? "OK" : status === "low" ? "Low" : "Critical";
      return `
      <div class="prep-row status-${status}">
        <span class="cap-name">${p.item_name}</span>
        <span class="alert-stock">${qty} ${unit}</span>
        <span class="pill pill-${status}">${statusLabel}</span>
      </div>`;
    })
    .join("");
}

function renderEfficiencyChart(batches) {
  const el = document.getElementById("efficiency-chart");
  if (!batches.length) {
    el.innerHTML = '<div class="loading-row">No batch data</div>';
    return;
  }

  const reversed = [...batches].reverse();
  const maxH = 110; // px height for 100%

  const bars = reversed
    .map((b) => {
      const eff = parseFloat(b.efficiency_pct) || 0;
      const h = Math.max(4, Math.round((eff / 100) * maxH));
      const color =
        eff >= 90 ? "var(--green)" : eff >= 70 ? "var(--amber)" : "var(--red)";
      const name = b.items?.item_name || b.item_id;
      const shortName = name
        .replace("Mashed Potato", "Mashed")
        .replace("Steak Fries", "S.Fries")
        .replace("Beef Patty", "Patty")
        .replace("Mixed Salad", "Salad")
        .replace("Cajun Fries", "C.Fries")
        .replace("Honey Lime", "H.Lime");
      return `
      <div class="bar-group">
        <div class="bar-fill"
          style="height:${h}px; background:${color}; opacity:0.85"
          data-label="${eff}% — ${name}">
        </div>
        <div class="bar-label">${shortName}<br/>${b.batch_no}</div>
      </div>`;
    })
    .join("");

  el.innerHTML = `<div class="bar-chart">${bars}</div>`;
}

function renderAlertList(stock) {
  const alerts = stock
    .filter((s) => s.stock_status !== "ok")
    .sort((a, b) => (a.stock_status === "critical" ? -1 : 1));

  const el = document.getElementById("alert-list");
  if (!alerts.length) {
    el.innerHTML = '<div class="loading-row">✓ All items above par level</div>';
    return;
  }

  el.innerHTML = alerts
    .map(
      (s) => `
    <div class="alert-row">
      <div class="alert-dot ${s.stock_status}"></div>
      <span class="alert-name">${s.item_name}</span>
      <span class="alert-stock">${fmtNum(s.stock_qty)} ${s.usage_unit}</span>
      <span class="alert-par">par: ${fmtNum(s.par_level)} ${s.usage_unit}</span>
      <span class="pill pill-${s.stock_status}">${s.stock_status}</span>
    </div>`,
    )
    .join("");
}

// ── PRODUCTION ──────────────────────────────────────────────

let _batchStandards = {};

async function loadProduction() {
  const [items, batches] = await Promise.all([
    fetchPrepItems(),
    fetchProductionLogs(),
  ]);

  // Populate item dropdown
  const sel = document.getElementById("prod-item");
  sel.innerHTML =
    '<option value="">— select item —</option>' +
    items
      .map((i) => `<option value="${i.item_id}">${i.item_name}</option>`)
      .join("");

  // Set today's date
  document.getElementById("prod-date").value = today();

  // Auto-fill std yield when item selected
  sel.addEventListener("change", async () => {
    const itemId = sel.value;
    if (!itemId) {
      document.getElementById("prod-std").value = "";
      return;
    }
    const std = await fetchBatchStandard(itemId);
    _batchStandards[itemId] = std;
    const intended =
      parseFloat(document.getElementById("prod-intended").value) || 1;
    document.getElementById("prod-std").value = std
      ? std.standard_yield_gram * intended + " gr"
      : "—";
    recalcEfficiency();
  });

  document.getElementById("prod-intended").addEventListener("input", () => {
    const itemId = document.getElementById("prod-item").value;
    const std = _batchStandards[itemId];
    const intended =
      parseFloat(document.getElementById("prod-intended").value) || 1;
    if (std)
      document.getElementById("prod-std").value =
        std.standard_yield_gram * intended + " gr";
    recalcEfficiency();
  });

  document
    .getElementById("prod-yield")
    .addEventListener("input", recalcEfficiency);

  // Form submit
  document.getElementById("prod-form").onsubmit = handleProdSubmit;

  renderProdTable(batches);
}

function recalcEfficiency() {
  const itemId = document.getElementById("prod-item").value;
  const std = _batchStandards[itemId];
  const actual = parseFloat(document.getElementById("prod-yield").value);
  const intended =
    parseFloat(document.getElementById("prod-intended").value) || 1;

  if (!std || !actual) {
    document.getElementById("prod-eff").value = "";
    return;
  }

  const stdYield = std.standard_yield_gram * intended;
  const eff = ((actual / stdYield) * 100).toFixed(1);
  document.getElementById("prod-eff").value = eff + "%";
}

async function handleProdSubmit(e) {
  e.preventDefault();
  const fb = document.getElementById("prod-feedback");
  const btn = e.target.querySelector("button[type=submit]");
  btn.disabled = true;
  fb.textContent = "Saving…";
  fb.className = "form-feedback";

  const itemId = document.getElementById("prod-item").value;
  const std = _batchStandards[itemId];
  const intended = parseFloat(document.getElementById("prod-intended").value);
  const actual = parseFloat(document.getElementById("prod-yield").value);

  if (!std) {
    fb.textContent = "Select a valid item first";
    fb.className = "form-feedback error";
    btn.disabled = false;
    return;
  }

  const stdYield = std.standard_yield_gram * intended;
  const portions = actual / std.portion_gram;

  const log = {
    batch_no: "BK" + Date.now().toString().slice(-6),
    date: document.getElementById("prod-date").value,
    item_id: itemId,
    intended_batch: intended,
    actual_yield_gram: actual,
    std_yield_gram: stdYield,
    total_portions: parseFloat(portions.toFixed(2)),
    notes: document.getElementById("prod-notes").value || null,
    created_by: "kitchen",
  };

  const result = await insertProductionLog(log);
  if (result.error) {
    fb.textContent = "Error: " + result.error;
    fb.className = "form-feedback error";
  } else {
    fb.textContent = `✓ Batch ${log.batch_no} saved — ${log.total_portions} portions`;
    e.target.reset();
    document.getElementById("prod-date").value = today();
    const batches = await fetchProductionLogs();
    renderProdTable(batches);
  }
  btn.disabled = false;
}

function renderProdTable(batches) {
  const tbody = document.getElementById("prod-tbody");
  if (!batches.length) {
    tbody.innerHTML =
      '<tr><td colspan="8" class="loading-row">No batches yet</td></tr>';
    return;
  }

  tbody.innerHTML = batches
    .map((b) => {
      const eff = parseFloat(b.efficiency_pct) || 0;
      const effClass =
        eff >= 90 ? "eff-good" : eff >= 70 ? "eff-warn" : "eff-bad";
      return `
      <tr>
        <td class="mono">${b.batch_no}</td>
        <td>${fmtDate(b.date)}</td>
        <td>${b.items?.item_name || b.item_id}</td>
        <td class="mono">${fmtNum(b.std_yield_gram)} gr</td>
        <td class="mono">${fmtNum(b.actual_yield_gram)} gr</td>
        <td class="mono ${effClass}">${eff}%</td>
        <td class="mono">${b.total_portions ?? "—"}</td>
        <td style="color:var(--slate-400);font-size:11px">${b.notes || ""}</td>
      </tr>`;
    })
    .join("");
}

// ── STOCK ───────────────────────────────────────────────────

let _allStock = [];

async function loadStock() {
  initOpeningStock();
  _allStock = await fetchCurrentStock();
  renderStockTable(_allStock);

  document.getElementById("stock-filter-cat").onchange = filterStock;
  document.getElementById("stock-filter-status").onchange = filterStock;
}

function filterStock() {
  const cat = document.getElementById("stock-filter-cat").value;
  const status = document.getElementById("stock-filter-status").value;
  const filtered = _allStock.filter(
    (s) =>
      (!cat || s.category === cat) && (!status || s.stock_status === status),
  );
  renderStockTable(filtered);
}

function renderStockTable(stock) {
  const tbody = document.getElementById("stock-tbody");
  if (!stock.length) {
    tbody.innerHTML =
      '<tr><td colspan="6" class="loading-row">No items</td></tr>';
    return;
  }

  tbody.innerHTML = stock
    .map(
      (s) => `
    <tr>
      <td>${s.item_name}</td>
      <td><span style="font-size:11px;color:var(--slate-400)">${s.category}</span></td>
      <td class="mono">${fmtNum(s.stock_qty)}</td>
      <td style="font-size:11px;color:var(--slate-400)">${s.usage_unit}</td>
      <td class="mono" style="color:var(--slate-400)">${fmtNum(s.par_level)}</td>
      <td><span class="pill pill-${s.stock_status}">${s.stock_status}</span></td>
    </tr>`,
    )
    .join("");
}

// ── PURCHASES ───────────────────────────────────────────────

let _ingredients = [];

async function loadPurchases() {
  const [ingredients, suppliers, history] = await Promise.all([
    fetchIngredientItems(),
    fetchSuppliers(),
    fetchPurchaseHistory(),
  ]);

  _ingredients = ingredients;

  const itemSel = document.getElementById("po-item");
  itemSel.innerHTML =
    '<option value="">— select ingredient —</option>' +
    ingredients
      .map(
        (i) =>
          `<option value="${i.item_id}" data-conv="${i.conversion}" data-pu="${i.purchase_unit}">${i.item_name} (${i.purchase_unit})</option>`,
      )
      .join("");

  const supSel = document.getElementById("po-supplier");
  supSel.innerHTML =
    '<option value="">— select supplier —</option>' +
    suppliers
      .map(
        (s) => `<option value="${s.supplier_id}">${s.supplier_name}</option>`,
      )
      .join("");

  document.getElementById("po-date").value = today();

  // Auto-calculate usage qty and total
  const recalcPO = () => {
    const opt = itemSel.selectedOptions[0];
    const conv = parseFloat(opt?.dataset.conv || 1);
    const qty = parseFloat(document.getElementById("po-qty").value) || 0;
    const price = parseFloat(document.getElementById("po-price").value) || 0;
    const pu = opt?.dataset.pu || "";

    document.getElementById("po-qty-usage").value = qty
      ? fmtNum(qty * conv) +
        " " +
        (pu === "kg" ? "gr" : pu === "ltr" ? "ml" : "pcs")
      : "";
    document.getElementById("po-total").value =
      qty && price ? "Rp " + (qty * price).toLocaleString("id-ID") : "";
  };

  itemSel.addEventListener("change", recalcPO);
  document.getElementById("po-qty").addEventListener("input", recalcPO);
  document.getElementById("po-price").addEventListener("input", recalcPO);

  document.getElementById("po-form").onsubmit = handlePOSubmit;
  renderPOTable(history);
}

async function handlePOSubmit(e) {
  e.preventDefault();
  const fb = document.getElementById("po-feedback");
  const btn = e.target.querySelector("button[type=submit]");
  btn.disabled = true;
  fb.textContent = "Saving…";
  fb.className = "form-feedback";

  const opt = document.getElementById("po-item").selectedOptions[0];
  const conv = parseFloat(opt?.dataset.conv || 1);
  const qtyPU = parseFloat(document.getElementById("po-qty").value);

  const po = {
    date: document.getElementById("po-date").value,
    supplier_id: document.getElementById("po-supplier").value || null,
    item_id: document.getElementById("po-item").value,
    qty_purchase_unit: qtyPU,
    qty_usage_unit: qtyPU * conv,
    unit_price: parseFloat(document.getElementById("po-price").value),
    ref: document.getElementById("po-ref").value || null,
    status: "received",
    created_by: "purchasing",
  };

  const result = await insertPurchaseOrder(po);
  if (result.error) {
    fb.textContent = "Error: " + result.error;
    fb.className = "form-feedback error";
  } else {
    fb.textContent = "✓ Purchase recorded";
    e.target.reset();
    document.getElementById("po-date").value = today();
    const history = await fetchPurchaseHistory();
    renderPOTable(history);
  }
  btn.disabled = false;
}

function renderPOTable(history) {
  const tbody = document.getElementById("po-tbody");
  if (!history.length) {
    tbody.innerHTML =
      '<tr><td colspan="8" class="loading-row">No purchases yet</td></tr>';
    return;
  }

  tbody.innerHTML = history
    .map(
      (p) => `
    <tr>
      <td>${fmtDate(p.date)}</td>
      <td>${p.items?.item_name || p.item_id}</td>
      <td style="font-size:11px;color:var(--slate-400)">${p.suppliers?.supplier_name || "—"}</td>
      <td class="mono">${fmtNum(p.qty_purchase_unit)}</td>
      <td style="font-size:11px;color:var(--slate-400)">${p.items?.purchase_unit || "—"}</td>
      <td class="mono">Rp ${(p.unit_price || 0).toLocaleString("id-ID")}</td>
      <td class="mono" style="color:var(--gold)">Rp ${(p.total_cost || 0).toLocaleString("id-ID")}</td>
      <td style="font-size:11px;color:var(--slate-400)">${p.ref || "—"}</td>
    </tr>`,
    )
    .join("");
}

// ── HELPERS ─────────────────────────────────────────────────

function fmtNum(n) {
  if (n === null || n === undefined) return "—";
  const num = parseFloat(n);
  return isNaN(num)
    ? "—"
    : num.toLocaleString("id-ID", { maximumFractionDigits: 1 });
}

function fmtDate(d) {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("en-ID", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function today() {
  return new Date().toISOString().split("T")[0];
}

// ── RECIPES ─────────────────────────────────────────────────

let _activeRecipeItemId = null;
let _recipeLines = []; // pending lines not yet saved

async function loadRecipes() {
  const [prepDishItems, allInputItems, library] = await Promise.all([
    fetchAllPrepAndDishItems(),
    fetchAllIngredientAndPrepItems(),
    fetchRecipeLibrary(),
  ]);

  // Tab switching
  document.getElementById("rtab-new").onclick = () => switchRTab("new");
  document.getElementById("rtab-existing").onclick = () =>
    switchRTab("existing");

  // Populate existing item selector
  const existingSel = document.getElementById("ri-existing-sel");
  existingSel.innerHTML =
    '<option value="">— select —</option>' +
    prepDishItems
      .map(
        (i) =>
          `<option value="${i.item_id}">${i.item_name} (${i.category})</option>`,
      )
      .join("");

  // Populate recipe input items dropdown
  const inputSel = document.getElementById("rl-input-item");
  inputSel.innerHTML =
    '<option value="">— select ingredient or prep —</option>' +
    allInputItems
      .map(
        (i) =>
          `<option value="${i.item_id}" data-unit="${i.usage_unit}">[${i.category}] ${i.item_name}</option>`,
      )
      .join("");

  // Auto-set unit when input item selected
  inputSel.onchange = () => {
    const opt = inputSel.selectedOptions[0];
    const unit = opt?.dataset.unit || "gr";
    const unitSel = document.getElementById("rl-unit");
    for (let o of unitSel.options) {
      if (o.value === unit) {
        o.selected = true;
        break;
      }
    }
  };

  // Create new item button
  document.getElementById("btn-create-item").onclick = handleCreateItem;

  // Load existing item
  document.getElementById("btn-load-existing").onclick = async () => {
    const itemId = existingSel.value;
    if (!itemId) return;
    const item = prepDishItems.find((i) => i.item_id === itemId);
    const lines = await fetchRecipeLinesForItem(itemId);
    activateRecipeEditor(item, lines);
  };

  // Add recipe line
  document.getElementById("btn-add-line").onclick = handleAddRecipeLine;

  // Save recipe
  document.getElementById("btn-save-recipe").onclick = handleSaveRecipe;

  // Batch standard form
  document.getElementById("std-yield").oninput = recalcPortions;
  document.getElementById("std-portion").oninput = recalcPortions;
  document.getElementById("std-form").onsubmit = handleSaveStandard;

  renderRecipeLibrary(library);
}

function switchRTab(tab) {
  document.getElementById("rtab-new").classList.toggle("active", tab === "new");
  document
    .getElementById("rtab-existing")
    .classList.toggle("active", tab === "existing");
  document.getElementById("rpanel-new").style.display =
    tab === "new" ? "flex" : "none";
  document.getElementById("rpanel-existing").style.display =
    tab === "existing" ? "flex" : "none";
}

async function handleCreateItem() {
  const fb = document.getElementById("ri-feedback");
  const btn = document.getElementById("btn-create-item");
  const id = document.getElementById("ri-name").value.trim();
  const name = document.getElementById("ri-name").value.trim();

  if (!name) {
    fb.textContent = "Item name is required";
    fb.className = "form-feedback error";
    return;
  }

  btn.disabled = true;
  fb.textContent = "Creating…";
  fb.className = "form-feedback";

  // Generate item_id from category + timestamp if not editing
  const cat = document.getElementById("ri-category").value;
  const prefix =
    cat === "Ingredient" ? "ING" : cat === "Prep" ? "PREP" : "DISH";
  const newId = prefix + Date.now().toString().slice(-4);

  const item = {
    item_id: newId,
    item_name: name,
    category: cat,
    usage_unit: document.getElementById("ri-unit").value,
    par_level: parseFloat(document.getElementById("ri-par").value) || 0,
    is_active: true,
  };

  const { data, error } = await createItem(item);
  if (error) {
    fb.textContent = "Error: " + error.message;
    fb.className = "form-feedback error";
    btn.disabled = false;
    return;
  }

  fb.textContent = `✓ Created ${newId}`;
  activateRecipeEditor(data || item, []);
  btn.disabled = false;
}

function activateRecipeEditor(item, existingLines) {
  _activeRecipeItemId = item.item_id;
  _recipeLines = existingLines.map((l) => ({ ...l }));

  document.getElementById("recipe-item-name").textContent = item.item_name;
  document.getElementById("std-item-name").textContent = item.item_name;
  document.getElementById("recipe-lines-card").style.display = "block";
  document.getElementById("recipe-std-card").style.display =
    item.category === "Dish" ? "none" : "block";

  renderRecipeLineTable();
}

function handleAddRecipeLine() {
  const sel = document.getElementById("rl-input-item");
  const inputId = sel.value;
  if (!inputId) return;

  const qty = parseFloat(document.getElementById("rl-qty").value);
  if (!qty || qty <= 0) {
    return;
  }

  const unit = document.getElementById("rl-unit").value;
  const name =
    sel.selectedOptions[0]?.text.replace(/^\[.*?\]\s*/, "") || inputId;

  // Prevent duplicates
  if (_recipeLines.find((l) => l.input_item_id === inputId)) {
    const existing = _recipeLines.find((l) => l.input_item_id === inputId);
    existing.qty = qty;
    existing.unit = unit;
  } else {
    _recipeLines.push({
      input_item_id: inputId,
      qty,
      unit,
      items: { item_name: name },
    });
  }

  sel.value = "";
  document.getElementById("rl-qty").value = "";
  renderRecipeLineTable();
}

function renderRecipeLineTable() {
  const tbody = document.getElementById("recipe-lines-tbody");
  if (!_recipeLines.length) {
    tbody.innerHTML =
      '<tr><td colspan="4" class="loading-row">No lines yet — add ingredients above</td></tr>';
    return;
  }
  tbody.innerHTML = _recipeLines
    .map(
      (l, idx) => `
    <tr>
      <td>${l.items?.item_name || l.input_item_id}</td>
      <td class="mono">${l.qty}</td>
      <td style="color:var(--slate-400);font-size:11px">${l.unit}</td>
      <td><button class="btn-del" data-idx="${idx}">✕</button></td>
    </tr>`,
    )
    .join("");

  tbody.querySelectorAll(".btn-del").forEach((btn) => {
    btn.onclick = () => {
      _recipeLines.splice(parseInt(btn.dataset.idx), 1);
      renderRecipeLineTable();
    };
  });
}

async function handleSaveRecipe() {
  const fb = document.getElementById("rl-feedback");
  const btn = document.getElementById("btn-save-recipe");
  if (!_activeRecipeItemId) {
    fb.textContent = "No item selected";
    fb.className = "form-feedback error";
    return;
  }
  if (!_recipeLines.length) {
    fb.textContent = "Add at least one ingredient";
    fb.className = "form-feedback error";
    return;
  }

  btn.disabled = true;
  fb.textContent = "Saving…";
  fb.className = "form-feedback";

  const { error } = await saveRecipeLines(_activeRecipeItemId, _recipeLines);
  if (error) {
    fb.textContent = "Error: " + error;
    fb.className = "form-feedback error";
  } else {
    fb.textContent = "✓ Recipe saved";
    const library = await fetchRecipeLibrary();
    renderRecipeLibrary(library);
  }
  btn.disabled = false;
}

function recalcPortions() {
  const y = parseFloat(document.getElementById("std-yield").value) || 0;
  const p = parseFloat(document.getElementById("std-portion").value) || 0;
  document.getElementById("std-portions-calc").value =
    y && p ? (y / p).toFixed(1) + " portions" : "";
}

async function handleSaveStandard(e) {
  e.preventDefault();
  const fb = document.getElementById("std-feedback");
  const btn = e.target.querySelector("button[type=submit]");
  if (!_activeRecipeItemId) return;

  btn.disabled = true;
  fb.textContent = "Saving…";

  const stdYield = parseFloat(document.getElementById("std-yield").value);
  const portion = parseFloat(document.getElementById("std-portion").value);
  const { error } = await saveBatchStandard(
    _activeRecipeItemId,
    stdYield,
    portion,
  );

  if (error) {
    fb.textContent = "Error: " + error;
    fb.className = "form-feedback error";
  } else {
    fb.textContent = "✓ Batch standard saved";
    fb.className = "form-feedback";
  }
  btn.disabled = false;
}

function renderRecipeLibrary(library) {
  const el = document.getElementById("recipe-library");
  if (!library.length) {
    el.innerHTML = '<div class="loading-row">No recipes yet</div>';
    return;
  }

  el.innerHTML = library
    .map((item) => {
      const std = item.standard;
      const stdHtml = std
        ? `
      <div class="rlib-std">
        <div class="rlib-std-item">
          <span class="rlib-std-label">Std Yield</span>
          <span class="rlib-std-val">${fmtNum(std.standard_yield_gram)}</span>
          <span class="rlib-std-unit">gr</span>
        </div>
        <div class="rlib-std-item">
          <span class="rlib-std-label">Portion</span>
          <span class="rlib-std-val">${fmtNum(std.portion_gram)}</span>
          <span class="rlib-std-unit">gr / pcs</span>
        </div>
        <div class="rlib-std-item">
          <span class="rlib-std-label">Portions / Batch</span>
          <span class="rlib-std-val">${fmtNum(std.portions_per_batch)}</span>
          <span class="rlib-std-unit">portions</span>
        </div>
      </div>`
        : "";

      const linesHtml = item.lines.length
        ? `
      <table class="rlib-lines">
        <thead><tr><th>Ingredient / Prep</th><th>Qty</th><th>Unit</th></tr></thead>
        <tbody>
          ${item.lines
            .map(
              (l) => `
            <tr>
              <td>${l.items?.item_name || l.input_item_id}</td>
              <td class="mono">${l.qty}</td>
              <td style="color:var(--slate-400);font-size:11px">${l.unit}</td>
            </tr>`,
            )
            .join("")}
        </tbody>
      </table>`
        : '<div class="loading-row" style="padding:12px 0">No recipe lines</div>';

      return `
      <div class="recipe-library-item">
        <div class="rlib-header" onclick="toggleRLib(this)">
          <span class="pill pill-${item.category === "Dish" ? "ok" : "low"}" style="font-size:9px">${item.category}</span>
          <span class="rlib-name">${item.item_name}</span>
          <span class="rlib-meta">${item.lines.length} ingredients</span>
          <span class="rlib-chevron">›</span>
        </div>
        <div class="rlib-body">
          ${linesHtml}
          ${stdHtml}
        </div>
      </div>`;
    })
    .join("");
}

function toggleRLib(header) {
  header.classList.toggle("open");
  const body = header.nextElementSibling;
  body.classList.toggle("open");
}

// ── ITEMS ────────────────────────────────────────────────────

let _allItemsMaster = [];
let _editingItemId = null;

async function loadItems() {
  _allItemsMaster = await fetchAllItemsMaster();
  renderItemsTable(_allItemsMaster);

  document.getElementById("items-filter-cat").onchange = () => {
    const cat = document.getElementById("items-filter-cat").value;
    renderItemsTable(
      cat ? _allItemsMaster.filter((i) => i.category === cat) : _allItemsMaster,
    );
  };

  // Conversion note auto-update
  const updateConvNote = () => {
    const pu = document.getElementById("item-purchase-unit").value;
    const uu = document.getElementById("item-usage-unit").value;
    const conv = document.getElementById("item-conversion").value;
    document.getElementById("item-conv-note").value =
      pu && uu && conv ? `1 ${pu} = ${conv} ${uu}` : "";
  };
  document.getElementById("item-purchase-unit").onchange = updateConvNote;
  document.getElementById("item-usage-unit").onchange = updateConvNote;
  document.getElementById("item-conversion").oninput = updateConvNote;
  updateConvNote();

  document.getElementById("item-form").onsubmit = handleItemSubmit;
  document.getElementById("item-form-cancel").onclick = cancelItemEdit;
}

async function handleItemSubmit(e) {
  e.preventDefault();
  const fb = document.getElementById("item-feedback");
  const btn = document.getElementById("item-form-btn");
  btn.disabled = true;
  fb.textContent = "Saving…";
  fb.className = "form-feedback";

  const item = {
    item_id:
      _editingItemId ||
      document.getElementById("item-id").value.trim().toUpperCase(),
    item_name: document.getElementById("item-name").value.trim(),
    category: document.getElementById("item-category").value,
    purchase_unit: document.getElementById("item-purchase-unit").value || null,
    usage_unit: document.getElementById("item-usage-unit").value,
    conversion:
      parseFloat(document.getElementById("item-conversion").value) || 1,
    par_level: parseFloat(document.getElementById("item-par").value) || 0,
    is_active: true,
  };

  if (!item.item_id) {
    fb.textContent = "Item ID is required";
    fb.className = "form-feedback error";
    btn.disabled = false;
    return;
  }

  const { error } = await upsertItem(item);
  if (error) {
    fb.textContent = "Error: " + error;
    fb.className = "form-feedback error";
  } else {
    fb.textContent = _editingItemId ? "✓ Item updated" : "✓ Item added";
    fb.className = "form-feedback";
    cancelItemEdit();
    _allItemsMaster = await fetchAllItemsMaster();
    renderItemsTable(_allItemsMaster);
  }
  btn.disabled = false;
}

function populateItemForm(item) {
  _editingItemId = item.item_id;
  document.getElementById("item-id").value = item.item_id;
  document.getElementById("item-id").readOnly = true;
  document.getElementById("item-name").value = item.item_name;
  document.getElementById("item-category").value = item.category;
  document.getElementById("item-purchase-unit").value =
    item.purchase_unit || "";
  document.getElementById("item-usage-unit").value = item.usage_unit;
  document.getElementById("item-conversion").value = item.conversion;
  document.getElementById("item-par").value = item.par_level;
  document.getElementById("item-form-btn").textContent = "Update item";
  document.getElementById("item-form-cancel").style.display = "inline-block";
  document.getElementById("item-conv-note").value = item.purchase_unit
    ? `1 ${item.purchase_unit} = ${item.conversion} ${item.usage_unit}`
    : "";
  document
    .getElementById("item-form-btn")
    .scrollIntoView({ behavior: "smooth", block: "center" });
}

function cancelItemEdit() {
  _editingItemId = null;
  document.getElementById("item-form").reset();
  document.getElementById("item-id").readOnly = false;
  document.getElementById("item-form-btn").textContent = "Add item";
  document.getElementById("item-form-cancel").style.display = "none";
  document.getElementById("item-feedback").textContent = "";
}

function renderItemsTable(items) {
  const tbody = document.getElementById("items-tbody");
  if (!items.length) {
    tbody.innerHTML =
      '<tr><td colspan="8" class="loading-row">No items</td></tr>';
    return;
  }
  tbody.innerHTML = items
    .map(
      (i) => `
    <tr>
      <td class="mono" style="font-size:11px">${i.item_id}</td>
      <td>${i.item_name}</td>
      <td><span class="pill pill-${i.category === "Ingredient" ? "ok" : i.category === "Prep" ? "low" : "critical"}"
        style="font-size:9px">${i.category}</span></td>
      <td style="color:var(--slate-400);font-size:12px">${i.purchase_unit || "—"}</td>
      <td style="color:var(--slate-400);font-size:12px">${i.usage_unit}</td>
      <td class="mono" style="font-size:11px">${i.conversion}×</td>
      <td class="mono" style="font-size:11px">${fmtNum(i.par_level)}</td>
      <td><button class="btn-secondary" style="padding:4px 10px;font-size:11px"
        onclick='populateItemForm(${JSON.stringify(i)})'>Edit</button></td>
    </tr>`,
    )
    .join("");
}

// ── SUPPLIERS ────────────────────────────────────────────────

let _editingSupplierId = null;

async function loadSuppliers() {
  const suppliers = await fetchAllSuppliers();
  renderSuppliersTable(suppliers);

  document.getElementById("supplier-form").onsubmit = handleSupplierSubmit;
  document.getElementById("sup-form-cancel").onclick = cancelSupplierEdit;
}

async function handleSupplierSubmit(e) {
  e.preventDefault();
  const fb = document.getElementById("sup-feedback");
  const btn = document.getElementById("sup-form-btn");
  btn.disabled = true;
  fb.textContent = "Saving…";
  fb.className = "form-feedback";

  const sup = {
    supplier_id:
      _editingSupplierId ||
      document.getElementById("sup-id").value.trim().toUpperCase(),
    supplier_name: document.getElementById("sup-name").value.trim(),
    category: document.getElementById("sup-category").value,
    contact: document.getElementById("sup-contact").value.trim() || null,
    payment_terms: document.getElementById("sup-terms").value,
    is_active: true,
  };

  if (!sup.supplier_id) {
    fb.textContent = "Supplier ID is required";
    fb.className = "form-feedback error";
    btn.disabled = false;
    return;
  }

  const { error } = await upsertSupplier(sup);
  if (error) {
    fb.textContent = "Error: " + error;
    fb.className = "form-feedback error";
  } else {
    fb.textContent = _editingSupplierId
      ? "✓ Supplier updated"
      : "✓ Supplier added";
    fb.className = "form-feedback";
    cancelSupplierEdit();
    const suppliers = await fetchAllSuppliers();
    renderSuppliersTable(suppliers);
  }
  btn.disabled = false;
}

function populateSupplierForm(sup) {
  _editingSupplierId = sup.supplier_id;
  document.getElementById("sup-id").value = sup.supplier_id;
  document.getElementById("sup-id").readOnly = true;
  document.getElementById("sup-name").value = sup.supplier_name;
  document.getElementById("sup-category").value = sup.category || "Other";
  document.getElementById("sup-contact").value = sup.contact || "";
  document.getElementById("sup-terms").value = sup.payment_terms || "COD";
  document.getElementById("sup-form-btn").textContent = "Update supplier";
  document.getElementById("sup-form-cancel").style.display = "inline-block";
  document
    .getElementById("sup-form-btn")
    .scrollIntoView({ behavior: "smooth", block: "center" });
}

function cancelSupplierEdit() {
  _editingSupplierId = null;
  document.getElementById("supplier-form").reset();
  document.getElementById("sup-id").readOnly = false;
  document.getElementById("sup-form-btn").textContent = "Add supplier";
  document.getElementById("sup-form-cancel").style.display = "none";
  document.getElementById("sup-feedback").textContent = "";
}

function renderSuppliersTable(suppliers) {
  const tbody = document.getElementById("suppliers-tbody");
  if (!suppliers.length) {
    tbody.innerHTML =
      '<tr><td colspan="7" class="loading-row">No suppliers</td></tr>';
    return;
  }
  tbody.innerHTML = suppliers
    .map(
      (s) => `
    <tr>
      <td class="mono" style="font-size:11px">${s.supplier_id}</td>
      <td>${s.supplier_name}</td>
      <td style="color:var(--slate-400);font-size:12px">${s.category || "—"}</td>
      <td style="color:var(--slate-400);font-size:12px">${s.contact || "—"}</td>
      <td style="font-size:12px">${s.payment_terms || "—"}</td>
      <td><span class="pill pill-${s.is_active ? "ok" : "critical"}">${s.is_active ? "Active" : "Inactive"}</span></td>
      <td><button class="btn-secondary" style="padding:4px 10px;font-size:11px"
        onclick='populateSupplierForm(${JSON.stringify(s)})'>Edit</button></td>
    </tr>`,
    )
    .join("");
}

// ── OPENING STOCK ────────────────────────────────────────────

let _osLines = [];

async function initOpeningStock() {
  const toggle = document.getElementById("opening-stock-toggle");
  const body = document.getElementById("opening-stock-body");
  if (!toggle) return;

  toggle.onclick = () => {
    const open = body.style.display === "block";
    body.style.display = open ? "none" : "block";
    toggle.querySelector(".toggle-chevron").style.transform = open
      ? ""
      : "rotate(90deg)";
  };

  document.getElementById("os-date").value = today();

  const allItems = await fetchAllItemsMaster();
  const sel = document.getElementById("os-item-sel");
  sel.innerHTML =
    '<option value="">— select item —</option>' +
    allItems
      .map(
        (i) =>
          `<option value="${i.item_id}" data-unit="${i.usage_unit}">${i.item_name} (${i.usage_unit})</option>`,
      )
      .join("");

  sel.onchange = () => {
    const unit = sel.selectedOptions[0]?.dataset.unit || "";
    document.getElementById("os-unit-label").textContent = unit;
  };

  document.getElementById("btn-os-add").onclick = () => {
    const itemId = sel.value;
    const qty = parseFloat(document.getElementById("os-qty").value);
    if (!itemId || !qty) return;
    const name = sel.selectedOptions[0]?.text || itemId;
    const unit = sel.selectedOptions[0]?.dataset.unit || "";
    if (_osLines.find((l) => l.item_id === itemId)) {
      _osLines.find((l) => l.item_id === itemId).qty = qty;
    } else {
      _osLines.push({ item_id: itemId, qty, unit, name });
    }
    sel.value = "";
    document.getElementById("os-qty").value = "";
    document.getElementById("os-unit-label").textContent = "";
    renderOsLines();
  };

  document.getElementById("btn-os-save").onclick = handleSaveOpeningStock;
}

function renderOsLines() {
  const el = document.getElementById("os-lines-body");
  el.innerHTML = _osLines
    .map(
      (l, idx) => `
    <div class="os-line-row">
      <span>${l.name}</span>
      <span class="mono">${l.qty}</span>
      <span style="color:var(--slate-400);font-size:11px">${l.unit}</span>
      <button class="btn-del" onclick="_osLines.splice(${idx},1);renderOsLines()">✕</button>
    </div>`,
    )
    .join("");
}

async function handleSaveOpeningStock() {
  const fb = document.getElementById("os-feedback");
  const btn = document.getElementById("btn-os-save");
  if (!_osLines.length) {
    fb.textContent = "Add at least one item";
    fb.className = "form-feedback error";
    return;
  }

  const ref = document.getElementById("os-ref").value.trim();
  const date = document.getElementById("os-date").value;
  if (!ref || !date) {
    fb.textContent = "Reference and date are required";
    fb.className = "form-feedback error";
    return;
  }

  btn.disabled = true;
  fb.textContent = "Saving…";
  fb.className = "form-feedback";

  const { error } = await insertOpeningStock(date, ref, _osLines);
  if (error) {
    fb.textContent = "Error: " + error;
    fb.className = "form-feedback error";
  } else {
    fb.textContent = `✓ ${_osLines.length} items recorded`;
    fb.className = "form-feedback";
    _osLines = [];
    renderOsLines();
    _allStock = await fetchCurrentStock();
    renderStockTable(_allStock);
  }
  btn.disabled = false;
}

// ── SERVICE (End-of-Day Sales) ───────────────────────────────

let _svcLines = []; // [{ dishId, dishName, qty, unitPrice, recipe }]
let _svcRecipes = {}; // cache: dishId → recipe lines

async function loadService() {
  document.getElementById("svc-date").value = today();

  const dishes = await fetchDishItems();
  const sel = document.getElementById("svc-dish-sel");
  sel.innerHTML =
    '<option value="">— select dish —</option>' +
    dishes
      .map((d) => `<option value="${d.item_id}">${d.item_name}</option>`)
      .join("");

  document.getElementById("btn-svc-add").onclick = handleSvcAddDish;
  document.getElementById("btn-svc-save").onclick = handleSvcSave;

  // Preload recipes for all dishes
  for (const d of dishes) {
    _svcRecipes[d.item_id] = await fetchRecipeForDish(d.item_id);
  }

  _svcLines = [];
  renderSvcLines();
  const history = await fetchSalesHistory();
  renderSalesTable(history);
}

async function handleSvcAddDish() {
  const sel = document.getElementById("svc-dish-sel");
  const dishId = sel.value;
  const qty = parseInt(document.getElementById("svc-qty").value) || 0;
  const price = parseFloat(document.getElementById("svc-price").value) || null;

  if (!dishId || qty < 1) return;
  const dishName = sel.selectedOptions[0]?.text || dishId;

  // If dish already in list, add qty
  const existing = _svcLines.find((l) => l.dishId === dishId);
  if (existing) {
    existing.qty += qty;
  } else {
    _svcLines.push({
      dishId,
      dishName,
      qty,
      unitPrice: price,
      recipe: _svcRecipes[dishId] || [],
    });
  }

  sel.value = "";
  document.getElementById("svc-qty").value = "";
  document.getElementById("svc-price").value = "";
  renderSvcLines();
  renderSvcPreview();
}

function renderSvcLines() {
  const el = document.getElementById("svc-lines-body");
  if (!_svcLines.length) {
    el.innerHTML = "";
    return;
  }

  el.innerHTML = _svcLines
    .map((l, idx) => {
      const deductions = (l.recipe || []).length;
      return `
      <div class="os-line-row" style="grid-template-columns:1fr 80px 100px 120px 32px">
        <span>${l.dishName}</span>
        <span class="mono">${l.qty} portion${l.qty > 1 ? "s" : ""}</span>
        <span class="mono" style="color:var(--text-muted)">${l.unitPrice ? "Rp " + l.unitPrice.toLocaleString("id-ID") : "—"}</span>
        <span style="font-size:11px;color:var(--text-muted)">${deductions} item${deductions !== 1 ? "s" : ""} deducted</span>
        <button class="btn-del" onclick="_svcLines.splice(${idx},1);renderSvcLines();renderSvcPreview()">✕</button>
      </div>`;
    })
    .join("");
}

function renderSvcPreview() {
  const preview = document.getElementById("svc-preview");
  const tbody = document.getElementById("svc-preview-tbody");

  if (!_svcLines.length) {
    preview.style.display = "none";
    return;
  }
  preview.style.display = "block";

  // Aggregate deductions across all dishes
  const deductMap = {};
  for (const line of _svcLines) {
    for (const r of line.recipe || []) {
      const key = r.input_item_id;
      if (!deductMap[key]) {
        deductMap[key] = {
          name: r.items?.item_name || key,
          category: r.items?.category || "—",
          unit: r.unit,
          qty: 0,
        };
      }
      deductMap[key].qty += r.qty * line.qty;
    }
  }

  const rows = Object.values(deductMap);
  if (!rows.length) {
    tbody.innerHTML =
      '<tr><td colspan="4" class="loading-row">No recipe lines found</td></tr>';
    return;
  }

  tbody.innerHTML = rows
    .map(
      (r) => `
    <tr>
      <td>${r.name}</td>
      <td><span class="pill pill-${r.category === "Prep" ? "low" : "ok"}" style="font-size:9px">${r.category}</span></td>
      <td class="mono">${fmtNum(r.qty)}</td>
      <td style="color:var(--text-muted);font-size:11px">${r.unit}</td>
    </tr>`,
    )
    .join("");
}

async function handleSvcSave() {
  const fb = document.getElementById("svc-feedback");
  const btn = document.getElementById("btn-svc-save");
  const date = document.getElementById("svc-date").value;

  if (!date) {
    fb.textContent = "Date is required";
    fb.className = "form-feedback error";
    return;
  }
  if (!_svcLines.length) {
    fb.textContent = "Add at least one dish";
    fb.className = "form-feedback error";
    return;
  }

  btn.disabled = true;
  fb.textContent = "Saving…";
  fb.className = "form-feedback";

  const dateFmt = date.replace(/-/g, "");
  let errors = [];

  for (let i = 0; i < _svcLines.length; i++) {
    const line = _svcLines[i];
    const seqStr = String(i + 1).padStart(3, "0");
    const saleId = `SL-${dateFmt}-${seqStr}`;

    const saleLog = {
      id: saleId,
      date,
      dish_id: line.dishId,
      qty_sold: line.qty,
      unit_price: line.unitPrice || null,
      source: "manual",
      created_by: "service",
    };

    // Build ledger rows — one per recipe line × qty sold
    const ledgerRows = (line.recipe || []).map((r) => ({
      date,
      item_id: r.input_item_id,
      in_qty: 0,
      out_qty: parseFloat((r.qty * line.qty).toFixed(2)),
      source: "SALE",
      ref: saleId,
      notes: `${r.items?.item_name || r.input_item_id} ${r.qty}${r.unit} × ${line.qty}`,
      created_by: "service",
    }));

    const { error } = await insertSaleRecord(saleLog, ledgerRows);
    if (error) errors.push(`${line.dishName}: ${error}`);
  }

  if (errors.length) {
    fb.textContent = "Errors: " + errors.join(", ");
    fb.className = "form-feedback error";
  } else {
    const totalPortions = _svcLines.reduce((s, l) => s + l.qty, 0);
    fb.textContent = `✓ ${_svcLines.length} dish type${_svcLines.length > 1 ? "s" : ""}, ${totalPortions} portions recorded`;
    fb.className = "form-feedback";
    _svcLines = [];
    renderSvcLines();
    renderSvcPreview();
    const history = await fetchSalesHistory();
    renderSalesTable(history);
  }
  btn.disabled = false;
}

function renderSalesTable(history) {
  const tbody = document.getElementById("sales-tbody");
  if (!history.length) {
    tbody.innerHTML =
      '<tr><td colspan="6" class="loading-row">No sales recorded yet</td></tr>';
    return;
  }

  tbody.innerHTML = history
    .map((s) => {
      const revenue = s.unit_price ? s.qty_sold * s.unit_price : null;
      return `
      <tr>
        <td>${fmtDate(s.date)}</td>
        <td>${s.items?.item_name || s.dish_id}</td>
        <td class="mono">${s.qty_sold} portions</td>
        <td class="mono">${s.unit_price ? "Rp " + s.unit_price.toLocaleString("id-ID") : "—"}</td>
        <td class="mono" style="color:var(--gold-dark)">${revenue ? "Rp " + revenue.toLocaleString("id-ID") : "—"}</td>
        <td><span class="pill pill-ok" style="font-size:9px">${s.source}</span></td>
      </tr>`;
    })
    .join("");
}

// ── ADJUSTMENTS ──────────────────────────────────────────────

async function loadAdjustments() {
  document.getElementById("adj-date").value = today();

  const allItems = await fetchAllItemsMaster();
  const sel = document.getElementById("adj-item");
  sel.innerHTML =
    '<option value="">— select item —</option>' +
    allItems
      .map(
        (i) =>
          `<option value="${i.item_id}" data-unit="${i.usage_unit}">${i.item_name} (${i.usage_unit})</option>`,
      )
      .join("");

  sel.onchange = async () => {
    const itemId = sel.value;
    if (!itemId) {
      document.getElementById("adj-system-qty").value = "";
      document.getElementById("adj-delta").value = "";
      return;
    }
    const sysQty = await fetchCurrentStockForItem(itemId);
    document.getElementById("adj-system-qty").value =
      fmtNum(sysQty) + " " + (sel.selectedOptions[0]?.dataset.unit || "");
    sel._sysQty = sysQty;
    recalcDelta();
  };

  document.getElementById("adj-physical").oninput = recalcDelta;
  document.getElementById("btn-adj-save").onclick = handleAdjSave;

  const history = await fetchAdjustmentHistory();
  renderAdjTable(history);
}

function recalcDelta() {
  const sysQty = document.getElementById("adj-item")._sysQty ?? null;
  const physical = parseFloat(document.getElementById("adj-physical").value);
  if (sysQty === null || isNaN(physical)) {
    document.getElementById("adj-delta").value = "";
    return;
  }
  const delta = physical - sysQty;
  const sign = delta > 0 ? "+" : "";
  document.getElementById("adj-delta").value = `${sign}${fmtNum(delta)}`;
}

async function handleAdjSave() {
  const fb = document.getElementById("adj-feedback");
  const btn = document.getElementById("btn-adj-save");
  const sel = document.getElementById("adj-item");
  const itemId = sel.value;
  const date = document.getElementById("adj-date").value;
  const physical = parseFloat(document.getElementById("adj-physical").value);
  const reason = document.getElementById("adj-reason").value.trim();
  const sysQty = sel._sysQty ?? 0;
  const unit = sel.selectedOptions[0]?.dataset.unit || "";

  if (!itemId || !date || isNaN(physical) || !reason) {
    fb.textContent = "All fields are required";
    fb.className = "form-feedback error";
    return;
  }

  btn.disabled = true;
  fb.textContent = "Saving…";
  fb.className = "form-feedback";

  const dateFmt = date.replace(/-/g, "");
  const adjId = `ADJ-${dateFmt}-${Date.now().toString().slice(-3)}`;
  const delta = parseFloat((physical - sysQty).toFixed(2));

  const adj = {
    id: adjId,
    date,
    item_id: itemId,
    system_qty: sysQty,
    physical_qty: physical,
    reason,
    created_by: "admin",
  };

  const ledgerRow = {
    date,
    item_id: itemId,
    in_qty: delta > 0 ? delta : 0,
    out_qty: delta < 0 ? Math.abs(delta) : 0,
    source: "ADJUSTMENT",
    ref: adjId,
    notes: reason,
    created_by: "admin",
  };

  const { error } = await insertAdjustment(adj, ledgerRow);
  if (error) {
    fb.textContent = "Error: " + error;
    fb.className = "form-feedback error";
  } else {
    const sign = delta >= 0 ? "+" : "";
    fb.textContent = `✓ Adjustment saved — ${sign}${fmtNum(delta)} ${unit}`;
    fb.className = "form-feedback";
    document.getElementById("adj-item").value = "";
    document.getElementById("adj-physical").value = "";
    document.getElementById("adj-reason").value = "";
    document.getElementById("adj-system-qty").value = "";
    document.getElementById("adj-delta").value = "";
    const history = await fetchAdjustmentHistory();
    renderAdjTable(history);
  }
  btn.disabled = false;
}

function renderAdjTable(history) {
  const tbody = document.getElementById("adj-tbody");
  if (!history.length) {
    tbody.innerHTML =
      '<tr><td colspan="7" class="loading-row">No adjustments yet</td></tr>';
    return;
  }
  tbody.innerHTML = history
    .map((a) => {
      const delta = parseFloat(a.delta) || 0;
      const sign = delta >= 0 ? "+" : "";
      const col =
        delta > 0
          ? "var(--green)"
          : delta < 0
            ? "var(--red)"
            : "var(--text-muted)";
      return `
      <tr>
        <td>${fmtDate(a.date)}</td>
        <td>${a.items?.item_name || a.item_id}</td>
        <td class="mono">${fmtNum(a.system_qty)} ${a.items?.usage_unit || ""}</td>
        <td class="mono">${fmtNum(a.physical_qty)} ${a.items?.usage_unit || ""}</td>
        <td class="mono" style="color:${col}">${sign}${fmtNum(delta)}</td>
        <td style="font-size:12px;color:var(--text-secondary)">${a.reason}</td>
        <td style="font-size:11px;color:var(--text-muted)">${a.created_by}</td>
      </tr>`;
    })
    .join("");
}

// ── LEDGER ───────────────────────────────────────────────────

let _allLedger = [];

async function loadLedger() {
  _allLedger = await fetchLedgerHistory();
  renderLedgerTable(_allLedger);

  document.getElementById("ledger-filter-source").onchange = filterLedger;
  document.getElementById("ledger-filter-cat").onchange = filterLedger;
}

function filterLedger() {
  const source = document.getElementById("ledger-filter-source").value;
  const cat = document.getElementById("ledger-filter-cat").value;
  const filtered = _allLedger.filter(
    (r) => (!source || r.source === source) && (!cat || r.category === cat),
  );
  renderLedgerTable(filtered);
}

function renderLedgerTable(rows) {
  const tbody = document.getElementById("ledger-tbody");
  if (!rows.length) {
    tbody.innerHTML =
      '<tr><td colspan="10" class="loading-row">No movements found</td></tr>';
    return;
  }

  const sourceColors = {
    OPENING: "var(--text-muted)",
    PURCHASE: "var(--green)",
    PROD_OUT: "var(--navy, #1a3550)",
    PROD_USE: "var(--amber)",
    SALE: "var(--gold-dark)",
    ADJUSTMENT: "var(--red)",
    WASTE: "var(--red)",
  };

  tbody.innerHTML = rows
    .map((r) => {
      const net = parseFloat(r.net_qty) || 0;
      const netCol =
        net > 0 ? "var(--green)" : net < 0 ? "var(--red)" : "var(--text-muted)";
      const sign = net > 0 ? "+" : "";
      const srcCol = sourceColors[r.source] || "var(--text-muted)";

      return `
      <tr>
        <td style="white-space:nowrap">${fmtDate(r.date)}</td>
        <td>${r.item_name}</td>
        <td><span style="font-size:10px;color:var(--text-muted)">${r.category}</span></td>
        <td class="mono" style="color:var(--green)">${r.in_qty > 0 ? "+" + fmtNum(r.in_qty) : "—"}</td>
        <td class="mono" style="color:var(--red)">${r.out_qty > 0 ? "-" + fmtNum(r.out_qty) : "—"}</td>
        <td class="mono" style="color:${netCol};font-weight:600">${sign}${fmtNum(net)}</td>
        <td style="font-size:11px;color:var(--text-muted)">${r.usage_unit}</td>
        <td><span style="font-size:10px;font-weight:600;color:${srcCol}">${r.source}</span></td>
        <td style="font-size:11px;color:var(--text-muted);font-family:'JetBrains Mono',monospace">${r.ref || "—"}</td>
        <td style="font-size:11px;color:var(--text-muted);max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${r.notes || ""}">${r.notes || "—"}</td>
      </tr>`;
    })
    .join("");
}

// ── COSTING PAGE ─────────────────────────────────────────────

let _allIngCosts = [];
let _allRecipeCosts = [];
let _overrideItemId = null;

async function loadCosting() {
  const [recipeCosts, ingCosts] = await Promise.all([
    fetchRecipeCosts(),
    fetchIngredientCosts(),
  ]);
  _allRecipeCosts = recipeCosts;
  _allIngCosts = ingCosts;

  renderRecipeCostTable(recipeCosts);
  renderIngCostTable(ingCosts);

  document.getElementById("cost-filter-cat").onchange = () => {
    const cat = document.getElementById("cost-filter-cat").value;
    renderRecipeCostTable(
      cat ? _allRecipeCosts.filter((r) => r.category === cat) : _allRecipeCosts,
    );
  };

  document.getElementById("ing-cost-filter").onchange = () => {
    const src = document.getElementById("ing-cost-filter").value;
    renderIngCostTable(
      src ? _allIngCosts.filter((i) => i.cost_source === src) : _allIngCosts,
    );
  };

  document.getElementById("btn-override-save").onclick = handleOverrideSave;
  document.getElementById("btn-override-clear").onclick = handleOverrideClear;
}

function renderRecipeCostTable(costs) {
  const tbody = document.getElementById("recipe-cost-tbody");
  if (!costs.length) {
    tbody.innerHTML =
      '<tr><td colspan="7" class="loading-row">No recipes</td></tr>';
    return;
  }

  tbody.innerHTML = costs
    .map((r) => {
      const hasWarning = r.has_uncosted_ingredients;
      const costDisplay =
        r.cost_per_portion != null
          ? "Rp " + Math.round(r.cost_per_portion).toLocaleString("id-ID")
          : "—";
      const batchDisplay =
        r.total_batch_cost != null
          ? "Rp " + Math.round(r.total_batch_cost).toLocaleString("id-ID")
          : "—";

      return `<tr style="cursor:pointer" onclick="showCostBreakdown('${r.output_item_id}','${r.recipe_name}',${r.portions_per_batch})">
      <td><strong>${r.recipe_name}</strong></td>
      <td><span class="pill pill-${r.category === "Dish" ? "ok" : "low"}" style="font-size:9px">${r.category}</span></td>
      <td class="mono">${r.portions_per_batch}</td>
      <td class="mono">${batchDisplay}</td>
      <td class="mono" style="color:var(--gold-dark);font-weight:600">${costDisplay}</td>
      <td>${
        hasWarning
          ? `<span class="pill pill-low" style="font-size:9px">⚠ ${r.uncosted_line_count} uncosted</span>`
          : '<span class="pill pill-ok" style="font-size:9px">✓ Complete</span>'
      }</td>
      <td style="font-size:11px;color:var(--text-muted)">View →</td>
    </tr>`;
    })
    .join("");
}

async function showCostBreakdown(itemId, name, portionsPerBatch) {
  const card = document.getElementById("cost-breakdown-card");
  card.style.display = "block";
  document.getElementById("cost-breakdown-title").textContent =
    name + " — Cost Breakdown";
  document.getElementById("cost-breakdown-sub").textContent =
    `${portionsPerBatch} portions per batch`;
  document.getElementById("cost-breakdown-tbody").innerHTML =
    '<tr><td colspan="7" class="loading-row">Loading…</td></tr>';
  card.scrollIntoView({ behavior: "smooth", block: "start" });

  const lines = await fetchRecipeCostLines(itemId);

  if (!lines.length) {
    document.getElementById("cost-breakdown-tbody").innerHTML =
      '<tr><td colspan="7" class="loading-row">No recipe lines</td></tr>';
    return;
  }

  const srcBadge = (src) => {
    const colors = {
      purchase: "var(--green)",
      override: "var(--amber)",
      uncosted: "var(--red)",
    };
    return `<span style="font-size:10px;font-weight:600;color:${colors[src] || "var(--text-muted)"}">${src}</span>`;
  };

  const tbody = document.getElementById("cost-breakdown-tbody");
  tbody.innerHTML = lines
    .map(
      (l) => `
    <tr>
      <td>${l.input_name}${l.is_uncosted ? ' <span style="color:var(--red);font-size:10px">⚠ uncosted</span>' : ""}</td>
      <td><span style="font-size:10px;color:var(--text-muted)">${l.input_category}</span></td>
      <td class="mono">${l.qty}</td>
      <td style="font-size:11px;color:var(--text-muted)">${l.unit}</td>
      <td class="mono">${l.unit_cost ? "Rp " + fmtNum(l.unit_cost) : "—"}</td>
      <td class="mono" style="font-weight:600">${l.line_total ? "Rp " + Math.round(l.line_total).toLocaleString("id-ID") : "—"}</td>
      <td>${srcBadge(l.cost_source)}</td>
    </tr>`,
    )
    .join("");

  const total = lines.reduce((s, l) => s + (l.line_total || 0), 0);
  const perPortion = portionsPerBatch ? total / portionsPerBatch : total;
  document.getElementById("cost-breakdown-total").textContent =
    "Rp " + Math.round(total).toLocaleString("id-ID");
  document.getElementById("cost-breakdown-per-portion").textContent =
    "Rp " + Math.round(perPortion).toLocaleString("id-ID");
}

function renderIngCostTable(costs) {
  const tbody = document.getElementById("ing-cost-tbody");
  if (!costs.length) {
    tbody.innerHTML =
      '<tr><td colspan="7" class="loading-row">No items</td></tr>';
    return;
  }

  const srcBadge = (src) => {
    const styles = {
      purchase: "color:var(--green)",
      override: "color:var(--amber)",
      uncosted: "color:var(--red)",
    };
    return `<span class="pill pill-${src === "purchase" ? "ok" : src === "override" ? "low" : "critical"}" style="font-size:9px">${src}</span>`;
  };

  tbody.innerHTML = costs
    .map(
      (i) => `
    <tr>
      <td>${i.item_name}</td>
      <td style="font-size:11px;color:var(--text-muted)">${i.usage_unit}</td>
      <td class="mono">${i.last_purchase_cost != null ? "Rp " + fmtNum(i.last_purchase_cost) : "—"}</td>
      <td class="mono">${i.cost_override != null ? "Rp " + fmtNum(i.cost_override) : "—"}</td>
      <td class="mono" style="font-weight:600;color:var(--text-primary)">
  ${
    i.resolved_cost != null
      ? "Rp " + fmtNum(i.resolved_cost)
      : '<span style="color:var(--red)">Uncosted</span>'
  }
</td>
      <td>${srcBadge(i.cost_source)}</td>
      <td><button class="btn-secondary" style="padding:3px 10px;font-size:11px"
        onclick="openOverrideEditor('${i.item_id}','${i.item_name}','${i.usage_unit}',${i.cost_override ?? "null"},'${i.cost_override_note ?? ""}')">
        ${i.cost_override ? "Edit" : "Set override"}</button></td>
    </tr>`,
    )
    .join("");
}

function openOverrideEditor(itemId, name, unit, currentOverride, currentNote) {
  _overrideItemId = itemId;
  document.getElementById("override-item-label").textContent = name;
  document.getElementById("override-unit-label").textContent = unit;
  document.getElementById("override-cost-input").value = currentOverride ?? "";
  document.getElementById("override-note-input").value = currentNote || "";
  document.getElementById("override-feedback").textContent = "";
  document.getElementById("override-editor").style.display = "block";
  document
    .getElementById("override-editor")
    .scrollIntoView({ behavior: "smooth", block: "start" });
}

async function handleOverrideSave() {
  const fb = document.getElementById("override-feedback");
  const cost = parseFloat(document.getElementById("override-cost-input").value);
  const note = document.getElementById("override-note-input").value.trim();

  if (isNaN(cost) || cost < 0) {
    fb.textContent = "Enter a valid cost";
    fb.className = "form-feedback error";
    return;
  }

  fb.textContent = "Saving…";
  fb.className = "form-feedback";
  const { error } = await updateCostOverride(_overrideItemId, cost, note);
  if (error) {
    fb.textContent = "Error: " + error;
    fb.className = "form-feedback error";
    return;
  }

  fb.textContent = "✓ Override saved";
  document.getElementById("override-editor").style.display = "none";
  _allIngCosts = await fetchIngredientCosts();
  renderIngCostTable(_allIngCosts);
  _allRecipeCosts = await fetchRecipeCosts();
  renderRecipeCostTable(_allRecipeCosts);
}

async function handleOverrideClear() {
  const fb = document.getElementById("override-feedback");
  fb.textContent = "Clearing…";
  fb.className = "form-feedback";
  const { error } = await updateCostOverride(_overrideItemId, null, null);
  if (error) {
    fb.textContent = "Error: " + error;
    fb.className = "form-feedback error";
    return;
  }

  fb.textContent = "✓ Override cleared";
  document.getElementById("override-editor").style.display = "none";
  _allIngCosts = await fetchIngredientCosts();
  renderIngCostTable(_allIngCosts);
  _allRecipeCosts = await fetchRecipeCosts();
  renderRecipeCostTable(_allRecipeCosts);
}

// ── CALCULATOR PAGE ───────────────────────────────────────────

let _calcSessionId = null;
let _calcLines = []; // [{ item_id, name, qty, unit, manual_cost }]
let _calcAllItems = [];

async function loadCalculator() {
  _calcAllItems = await fetchAllIngredientAndPrepItems();
  const sessions = await fetchCalculatorSessions();
  renderCalcSessionList(sessions);

  const itemSel = document.getElementById("calc-item-sel");
  itemSel.innerHTML =
    '<option value="__custom__">+ Custom ingredient</option>' +
    _calcAllItems
      .map(
        (i) =>
          `<option value="${i.item_id}" data-unit="${i.usage_unit}">${i.item_name} (${i.usage_unit})</option>`,
      )
      .join("");

  itemSel.onchange = () => {
    const isCustom = itemSel.value === "__custom__";
    document.getElementById("calc-custom-name").style.display = isCustom
      ? "block"
      : "none";
    if (!isCustom) {
      const unit = itemSel.selectedOptions[0]?.dataset.unit || "gr";
      const unitSel = document.getElementById("calc-unit");
      for (let o of unitSel.options) {
        if (o.value === unit) {
          o.selected = true;
          break;
        }
      }
    }
  };

  document.getElementById("btn-calc-add-line").onclick = handleCalcAddLine;
  document.getElementById("btn-new-session").onclick = handleNewSession;
  document.getElementById("btn-calc-save").onclick = handleCalcSave;
  document.getElementById("btn-delete-session").onclick = handleDeleteSession;
  document.getElementById("calc-portions").oninput = recalcCalcSummary;
}

function renderCalcSessionList(sessions) {
  const el = document.getElementById("calc-session-list");
  if (!sessions.length) {
    el.innerHTML =
      '<div class="loading-row">No sessions yet — create one</div>';
    return;
  }
  el.innerHTML = sessions
    .map(
      (s) => `
    <div class="rlib-header" onclick="openCalcSession('${s.id}','${s.name}')"
      style="border-bottom:1px solid var(--border);padding:12px 20px">
      <span class="rlib-name">${s.name}</span>
      <span class="rlib-meta">${fmtDate(s.updated_at)}</span>
      <span class="rlib-chevron">›</span>
    </div>`,
    )
    .join("");
}

async function openCalcSession(sessionId, name) {
  _calcSessionId = sessionId;
  _calcLines = [];

  document.getElementById("calc-editor-card").style.display = "block";
  document.getElementById("calc-session-title").textContent = name;
  document.getElementById("calc-feedback").textContent = "";

  const lines = await fetchCalculatorLines(sessionId);
  _calcLines = lines.map((l) => ({
    item_id: l.item_id || null,
    name:
      l.custom_name ||
      _calcAllItems.find((i) => i.item_id === l.item_id)?.item_name ||
      l.item_id,
    qty: l.qty,
    unit: l.unit,
    manual_cost: l.manual_cost,
  }));

  renderCalcLines();
  recalcCalcSummary();
}

async function handleNewSession() {
  const name = prompt('Session name (e.g. "Truffle Burger test"):');
  if (!name?.trim()) return;
  const { data, error } = await createCalculatorSession(name.trim(), null);
  if (error) {
    alert("Error: " + error);
    return;
  }

  const sessions = await fetchCalculatorSessions();
  renderCalcSessionList(sessions);
  openCalcSession(data.id, data.name);
}

function handleCalcAddLine() {
  const sel = document.getElementById("calc-item-sel");
  const isCustom = sel.value === "__custom__";
  const name = isCustom
    ? document.getElementById("calc-custom-name").value.trim()
    : sel.selectedOptions[0]?.text.replace(/\s*\(.*\)$/, "") || sel.value;
  const qty = parseFloat(document.getElementById("calc-qty").value);
  const unit = document.getElementById("calc-unit").value;
  const cost = parseFloat(document.getElementById("calc-cost").value);

  if (!name || !qty || isNaN(cost)) return;

  _calcLines.push({
    item_id: isCustom ? null : sel.value,
    name,
    qty,
    unit,
    manual_cost: cost,
  });

  sel.value = "__custom__";
  document.getElementById("calc-custom-name").value = "";
  document.getElementById("calc-custom-name").style.display = "none";
  document.getElementById("calc-qty").value = "";
  document.getElementById("calc-cost").value = "";
  renderCalcLines();
  recalcCalcSummary();
}

function renderCalcLines() {
  const el = document.getElementById("calc-lines-body");
  if (!_calcLines.length) {
    el.innerHTML = "";
    return;
  }
  el.innerHTML = _calcLines
    .map(
      (l, idx) => `
    <div class="os-line-row" style="grid-template-columns:1fr 70px 80px 100px 32px">
      <span>${l.name}${l.item_id ? "" : ' <span style="font-size:10px;color:var(--text-muted)">(custom)</span>'}</span>
      <span class="mono">${l.qty}</span>
      <span style="font-size:11px;color:var(--text-muted)">${l.unit}</span>
      <span class="mono">Rp ${Math.round(l.manual_cost * l.qty).toLocaleString("id-ID")}</span>
      <button class="btn-del" onclick="_calcLines.splice(${idx},1);renderCalcLines();recalcCalcSummary()">✕</button>
    </div>`,
    )
    .join("");
}

function recalcCalcSummary() {
  const total = _calcLines.reduce((s, l) => s + l.qty * l.manual_cost, 0);
  const portions =
    parseFloat(document.getElementById("calc-portions").value) || 1;
  const perPortion = total / portions;
  const suggested = perPortion / 0.3; // 30% food cost target

  document.getElementById("calc-total").textContent =
    "Rp " + Math.round(total).toLocaleString("id-ID");
  document.getElementById("calc-per-portion").value =
    "Rp " + Math.round(perPortion).toLocaleString("id-ID");
  document.getElementById("calc-suggested-price").value =
    "Rp " + Math.round(suggested).toLocaleString("id-ID");
}

async function handleCalcSave() {
  const fb = document.getElementById("calc-feedback");
  const btn = document.getElementById("btn-calc-save");
  if (!_calcSessionId) return;

  btn.disabled = true;
  fb.textContent = "Saving…";
  const { error } = await saveCalculatorLines(_calcSessionId, _calcLines);
  if (error) {
    fb.textContent = "Error: " + error;
    fb.className = "form-feedback error";
  } else {
    fb.textContent = "✓ Saved";
    fb.className = "form-feedback";
  }
  btn.disabled = false;
}

async function handleDeleteSession() {
  if (!_calcSessionId) return;
  if (!confirm("Delete this session? This cannot be undone.")) return;
  await deleteCalculatorSession(_calcSessionId);
  _calcSessionId = null;
  _calcLines = [];
  document.getElementById("calc-editor-card").style.display = "none";
  const sessions = await fetchCalculatorSessions();
  renderCalcSessionList(sessions);
}
