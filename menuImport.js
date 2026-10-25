// Excel menu import: parseWorkbook() turns the workbook into plain data (no DB),
// applyImport() writes that data using the app's db wrapper.

const norm = v => String(v ?? '').trim();
const lower = v => norm(v).toLowerCase();
const num = (v, d = 0) => {
  const s = norm(v).replace(/[₹,\s]/g, '');
  if (s === '') return d;
  const n = Number(s);
  return isFinite(n) ? n : d;
};
const bool = (v, d) => {
  if (typeof v === 'boolean') return v;
  const s = lower(v);
  if (!s) return d;
  if (['true', 'yes', 'y', '1'].includes(s)) return true;
  if (['false', 'no', 'n', '0'].includes(s)) return false;
  return d;
};
const clamp = (n, lo, hi) => Math.min(Math.max(n, lo), hi);
const isSkip = r => lower(r['Action']) === 'skip';
const isExemptTax = v => /no\s*tax|exempt|\bnil\b|^0(\.0+)?\s*%/i.test(norm(v));

// Returns an array of row objects (headers trimmed), or null when the sheet is missing.
function readSheet(wb, XLSX, name) {
  const ws = wb.Sheets[name];
  if (!ws) return null;
  return XLSX.utils.sheet_to_json(ws, { defval: '' }).map(r => {
    const o = {};
    Object.keys(r).forEach(k => { o[k.trim()] = r[k]; });
    return o;
  });
}

const byOrder = (a, b) => (a.order - b.order) || (a.idx - b.idx);

function parseWorkbook(wb, XLSX) {
  XLSX = XLSX || require('xlsx');
  const warnings = [];
  const warn = m => { if (warnings.length < 200) warnings.push(m); };

  const sheets = {};
  ['Categories', 'Menu Items', 'Variants', 'Addons', 'Addon Variant Prices', 'Upsells',
    'Units of Measure', 'Ingredients Master', 'Suppliers', 'Supplier Catalog', 'Recipes', 'Recipe Ingredients']
    .forEach(n => { sheets[n] = readSheet(wb, XLSX, n); });

  // ---------- categories ----------
  const categories = [];
  const catByKey = new Map();
  const addCategory = (name, visible, image) => {
    const k = lower(name);
    if (!k) return null;
    if (catByKey.has(k)) return catByKey.get(k);
    const c = { name: norm(name), visible, image: norm(image), sort: categories.length };
    categories.push(c);
    catByKey.set(k, c);
    return c;
  };
  (sheets['Categories'] || []).forEach(r => {
    if (isSkip(r)) return;
    addCategory(r['Category Name'] || r['category'], bool(r['Visible'], true), r['Image URL']);
  });

  // ---------- items ----------
  const items = [];
  const itemByKey = new Map();
  const perCatCount = new Map();
  (sheets['Menu Items'] || []).forEach(r => {
    if (isSkip(r)) return;
    const name = norm(r['Item Name'] || r['item_name']);
    if (!name) return;
    if (itemByKey.has(lower(name))) return warn(`Duplicate item "${name}" skip kiya`);
    const cat = addCategory(r['Category'] || r['category'] || 'General', true, '');
    const availability = lower(r['Availability'] || 'available');
    const n = (perCatCount.get(cat.name) || 0) + 1;
    perCatCount.set(cat.name, n);
    const item = {
      name,
      category: cat.name,
      price: num(r['Base Price (₹)'] ?? r['price']),
      image: norm(r['Image URL'] || r['image']),
      stock: availability === 'available' ? 50 : 0,
      visible: bool(r['Visible'], true) && availability !== 'hidden',
      exempt: isExemptTax(r['GST Tax Category']),
      sort: n
    };
    items.push(item);
    itemByKey.set(lower(name), item);
  });
  const findItem = name => itemByKey.get(lower(name));

  // ---------- variants ----------
  const variantsPresent = sheets['Variants'] !== null;
  const variantsByItem = new Map();
  (sheets['Variants'] || []).forEach((r, idx) => {
    if (isSkip(r) || !bool(r['Available'], true)) return;
    const item = findItem(r['Item Name']);
    const vname = norm(r['Variant Name']);
    if (!item || !vname) return warn(`Variant "${vname}" ka item "${norm(r['Item Name'])}" menu me nahi mila`);
    const list = variantsByItem.get(item.name) || [];
    if (list.some(v => lower(v.name) === lower(vname))) return;
    list.push({ name: vname, price: num(r['Price (₹)']), order: num(r['Sort Order'], 0), idx });
    variantsByItem.set(item.name, list);
  });
  variantsByItem.forEach(l => l.sort(byOrder));

  // ---------- addon groups ----------
  const addonsPresent = sheets['Addons'] !== null;
  const groups = new Map();            // defKey -> group def
  const nameDefs = new Map();          // group name -> [defKey]
  const itemGroups = new Map();        // item name -> [{ gname, defKey }]
  const groupSource = new Map();       // `${item}|${gname}` -> { meta, options[] } (all options, flat prices)

  const registerGroup = (wanted, meta, options) => {
    const sig = JSON.stringify([wanted, meta.min, meta.max, meta.mandatory, options.map(o => [o.name, o.price, o.image])]);
    if (groups.has(sig)) return sig;
    const taken = nameDefs.get(wanted) || [];
    const name = taken.length ? `${wanted} (${taken.length + 1})` : wanted;
    taken.push(sig);
    nameDefs.set(wanted, taken);
    groups.set(sig, { name, min: meta.min, max: meta.max, mandatory: meta.mandatory, items: options });
    return sig;
  };

  const addonTmp = new Map();          // `${item}|${gname}` -> { item, gname, meta, options[] }
  (sheets['Addons'] || []).forEach((r, idx) => {
    if (isSkip(r)) return;
    const item = findItem(r['Item Name']);
    const gname = norm(r['Addon Group']);
    if (!gname) return;
    if (!item) return warn(`Addon group "${gname}" ka item "${norm(r['Item Name'])}" menu me nahi mila`);
    const k = item.name + '|' + gname;
    if (!addonTmp.has(k)) {
      addonTmp.set(k, {
        item, gname, options: [],
        meta: {
          single: lower(r['Selection Type']) === 'single',
          mandatory: bool(r['Required'], false),
          min: num(r['Min Select'], 0),
          max: norm(r['Max Select']) === '' ? null : num(r['Max Select'], 1)
        }
      });
    }
    const oname = norm(r['Option Name']);
    if (!oname || !bool(r['Option Available'], true)) return;
    const linked = findItem(r['Linked Item']);
    addonTmp.get(k).options.push({
      name: oname,
      price: num(r['Option Price (₹)']),
      image: norm(r['Option Image URL']) || (linked ? linked.image : ''),
      order: num(r['Sort Order'], 0),
      idx
    });
  });

  const finalizeMeta = (meta, count) => {
    let max = meta.single ? 1 : (meta.max === null ? count : meta.max);
    max = clamp(max, 1, count);
    let min = clamp(meta.min, 0, max);
    if (meta.mandatory) min = Math.max(min, 1);
    return { min, max, mandatory: meta.mandatory };
  };

  addonTmp.forEach(t => {
    t.options.sort(byOrder);
    if (!t.options.length) return warn(`"${t.item.name}" ke group "${t.gname}" me koi available option nahi, skip kiya`);
    const options = t.options.map(o => ({ name: o.name, price: o.price, image: o.image }));
    const meta = finalizeMeta(t.meta, options.length);
    groupSource.set(t.item.name + '|' + t.gname, { meta, options });
    const defKey = registerGroup(t.gname, meta, options);
    const list = itemGroups.get(t.item.name) || [];
    list.push({ gname: t.gname, defKey });
    itemGroups.set(t.item.name, list);
  });

  // ---------- per-variant addon price overrides ----------
  // Overrides can't live on a single option, so each overridden variant gets its own copy of the group.
  const variantGroups = new Map();     // item name -> Map(variant name -> [defKey])
  const overrides = new Map();         // `${item}|${gname}|${option}|${variant}` (lowercased) -> price
  const overrideItems = new Set();
  (sheets['Addon Variant Prices'] || []).forEach(r => {
    if (isSkip(r) || norm(r['Override Price (₹)']) === '') return;
    const item = findItem(r['Item Name']);
    const vlist = item ? (variantsByItem.get(item.name) || []) : [];
    const src = item ? groupSource.get(item.name + '|' + norm(r['Addon Group'])) : null;
    if (!item || !src || !vlist.some(v => lower(v.name) === lower(r['Variant Name'])) ||
      !src.options.some(o => lower(o.name) === lower(r['Option Name']))) {
      return warn(`Addon variant price skip: ${norm(r['Item Name'])} / ${norm(r['Addon Group'])} / ${norm(r['Option Name'])} / ${norm(r['Variant Name'])}`);
    }
    overrides.set([item.name, norm(r['Addon Group']), norm(r['Option Name']), norm(r['Variant Name'])].map(lower).join('|'), num(r['Override Price (₹)']));
    overrideItems.add(item.name);
  });

  overrideItems.forEach(itemName => {
    const perVariant = new Map();
    (variantsByItem.get(itemName) || []).forEach(v => {
      const keys = (itemGroups.get(itemName) || []).map(g => {
        const src = groupSource.get(itemName + '|' + g.gname);
        const hasOverride = src.options.some(o => overrides.has([itemName, g.gname, o.name, v.name].map(lower).join('|')));
        if (!hasOverride) return g.defKey;
        const options = src.options.map(o => {
          const k = [itemName, g.gname, o.name, v.name].map(lower).join('|');
          return { name: o.name, price: overrides.has(k) ? overrides.get(k) : o.price, image: o.image };
        });
        return registerGroup(`${g.gname} (${v.name})`, src.meta, options);
      });
      perVariant.set(v.name, keys);
    });
    variantGroups.set(itemName, perVariant);
  });

  // ---------- upsells ----------
  const upsellsPresent = sheets['Upsells'] !== null;
  const upsells = [];
  (sheets['Upsells'] || []).forEach((r, idx) => {
    if (isSkip(r)) return;
    const item = findItem(r['Item Name']);
    const target = norm(r['Suggested Item']);
    const targetCat = norm(r['Suggested Category']);
    let type = lower(r['Type (upgrade/cross_sell)']).replace(/[\s-]+/g, '_') === 'upgrade' ? 'upgrade' : 'cross_sell';
    if (!item) return warn(`Upsell skip: item "${norm(r['Item Name'])}" menu me nahi mila`);
    if (!!target === !!targetCat) return warn(`Upsell skip (${item.name}): Suggested Item ya Suggested Category me se sirf ek chahiye`);
    if (targetCat && type === 'upgrade') type = 'cross_sell';
    if (target && !findItem(target)) return warn(`Upsell skip (${item.name}): suggested item "${target}" nahi mila`);
    upsells.push({
      item_name: item.name, type, suggested_item: target ? findItem(target).name : '', suggested_category: targetCat,
      label: norm(r['Label']), sort: num(r['Sort Order'], 0), active: bool(r['Active'], true), idx
    });
  });
  upsells.sort((a, b) => (a.sort - b.sort) || (a.idx - b.idx));

  // ---------- inventory & recipes ----------
  const uniqueBy = (rows, keyFn) => { const seen = new Set(); return rows.filter(r => { const k = lower(keyFn(r)); if (!k || seen.has(k)) return false; seen.add(k); return true; }); };
  const rowsOf = n => (sheets[n] || []).filter(r => !isSkip(r));

  const units = uniqueBy(rowsOf('Units of Measure'), r => r['Unit Name']).map(r => ({
    name: norm(r['Unit Name']), abbreviation: norm(r['Abbreviation']), unit_type: norm(r['Type'])
  }));
  const ingredients = uniqueBy(rowsOf('Ingredients Master'), r => r['Ingredient']).map(r => ({
    name: norm(r['Ingredient']), unit: norm(r['Unit']), unit_abbr: norm(r['Unit Abbr']),
    cost: num(r['Cost/Unit']), stock: num(r['Opening Stock']),
    reorder: norm(r['Reorder Level']) === '' ? null : num(r['Reorder Level']),
    group: norm(r['Group']), supplier: norm(r['Supplier'])
  }));
  const suppliers = uniqueBy(rowsOf('Suppliers'), r => r['Supplier Name']).map(r => ({
    name: norm(r['Supplier Name']), contact: norm(r['Contact Person']), phone: norm(r['Phone']), email: norm(r['Email']),
    address: norm(r['Address']), gstin: norm(r['GSTIN']), terms: num(r['Payment Terms (Days)']), notes: norm(r['Notes']),
    active: bool(r['Active'], true)
  }));
  const supplierCatalog = rowsOf('Supplier Catalog').filter(r => norm(r['Supplier']) && norm(r['Ingredient'])).map(r => ({
    supplier: norm(r['Supplier']), ingredient: norm(r['Ingredient']), unit: norm(r['Purchase Unit']), unit_abbr: norm(r['Unit Abbr']),
    cost: num(r['Unit Cost (₹)']), pack_size: num(r['Pack Size']), lead_time: num(r['Lead Time (Days)']),
    min_qty: num(r['Min Order Qty']), active: bool(r['Active'], true)
  }));
  const recipes = uniqueBy(rowsOf('Recipes'), r => r['Item Name']).filter(r => {
    if (findItem(r['Item Name'])) return true;
    warn(`Recipe skip: item "${norm(r['Item Name'])}" menu me nahi mila`);
    return false;
  }).map(r => ({
    item_name: findItem(r['Item Name']).name, recipe_name: norm(r['Recipe Name']), portion: norm(r['Portion Size']),
    yield_qty: num(r['Yield Qty'], 1), prep: num(r['Prep Time']), cook: num(r['Cook Time']), notes: norm(r['Prep Notes'])
  }));
  const recipeNames = new Set(recipes.map(r => lower(r.item_name)));
  const recipeLines = rowsOf('Recipe Ingredients').filter(r => recipeNames.has(lower(findItem(r['Item Name'])?.name)) && norm(r['Ingredient'])).map((r, idx) => ({
    item_name: findItem(r['Item Name']).name, ingredient: norm(r['Ingredient']), qty: num(r['Quantity']), unit: norm(r['Unit']),
    unit_abbr: norm(r['Unit Abbr']), wastage: num(r['Wastage %']), order: num(r['Line Order'], idx), notes: norm(r['Notes'])
  }));

  return {
    categories, items, groups, itemGroups, variantsByItem, variantGroups,
    variantsPresent, addonsPresent, upsellsPresent, upsells,
    inventory: {
      units: sheets['Units of Measure'] ? units : null,
      ingredients: sheets['Ingredients Master'] ? ingredients : null,
      suppliers: sheets['Suppliers'] ? suppliers : null,
      supplierCatalog: sheets['Supplier Catalog'] ? supplierCatalog : null,
      recipes: sheets['Recipes'] ? recipes : null,
      recipeLines: sheets['Recipe Ingredients'] ? recipeLines : null
    },
    warnings
  };
}

// ---------------------------------------------------------------------------

async function applyImport(db, parsed, opts = {}) {
  const replace = !!opts.replace;
  const run = (sql, params) => new Promise((resolve, reject) =>
    db.run(sql, params || [], function (err) { err ? reject(err) : resolve(this); }));
  const get = (sql, params) => new Promise((resolve, reject) =>
    db.get(sql, params || [], (err, row) => err ? reject(err) : resolve(row)));

  async function bulkInsert(table, cols, rows, suffix) {
    const size = clamp(Math.floor(30000 / cols.length), 1, 200);
    for (let i = 0; i < rows.length; i += size) {
      const chunk = rows.slice(i, i + size);
      const ph = '(' + cols.map(() => '?').join(',') + ')';
      await run(`INSERT INTO ${table} (${cols.join(', ')}) VALUES ${chunk.map(() => ph).join(',')} ${suffix || ''}`,
        chunk.flat());
    }
  }

  const summary = { categories: 0, items: 0, variants: 0, addonGroups: 0, upsells: 0, deleted: { items: 0, categories: 0, addonGroups: 0 }, inventory: {} };
  if (replace && !parsed.items.length) throw new Error('Replace mode ke liye "Menu Items" sheet me items hone chahiye');

  // 1. categories
  for (const c of parsed.categories) {
    await run(
      `INSERT INTO categories (name, is_visible, sort_order, image) VALUES (?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET is_visible = excluded.is_visible, sort_order = excluded.sort_order,
       image = CASE WHEN excluded.image = '' THEN categories.image ELSE excluded.image END`,
      [c.name, c.visible ? 1 : 0, c.sort, c.image]);
    summary.categories++;
  }

  // 2. add-on groups (reused by name so existing item links keep working)
  const groupIds = new Map();
  for (const [defKey, g] of parsed.groups) {
    const itemsJson = JSON.stringify(g.items);
    const existing = await get('SELECT id FROM addon_groups WHERE name = ? ORDER BY id LIMIT 1', [g.name]);
    if (existing) {
      await run('UPDATE addon_groups SET min_selection = ?, max_selection = ?, is_mandatory = ?, items = ? WHERE id = ?',
        [g.min, g.max, g.mandatory ? 1 : 0, itemsJson, existing.id]);
      groupIds.set(defKey, existing.id);
    } else {
      const res = await run('INSERT INTO addon_groups (name, min_selection, max_selection, is_mandatory, items) VALUES (?, ?, ?, ?, ?)',
        [g.name, g.min, g.max, g.mandatory ? 1 : 0, itemsJson]);
      groupIds.set(defKey, res.lastID);
    }
    summary.addonGroups++;
  }

  // 3. items
  for (const it of parsed.items) {
    await run(
      `INSERT INTO menu (name, category, price, stock, image, variations, assigned_addon_groups, is_exempt, is_visible, sort_order)
       VALUES (?, ?, ?, ?, ?, '[]', '[]', ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET category = excluded.category, price = excluded.price,
         stock = CASE WHEN excluded.stock = 0 THEN 0 WHEN menu.stock > 0 THEN menu.stock ELSE excluded.stock END,
         image = CASE WHEN excluded.image = '' THEN menu.image ELSE excluded.image END,
         is_exempt = excluded.is_exempt, is_visible = excluded.is_visible, sort_order = excluded.sort_order`,
      [it.name, it.category, it.price, it.stock, it.image, it.exempt ? 1 : 0, it.visible ? 1 : 0, it.sort]);
    summary.items++;

    const sets = [], params = [];
    if (parsed.variantsPresent || parsed.addonsPresent) {
      const ids = keys => keys.map(k => groupIds.get(k)).filter(v => v !== undefined);
      if (parsed.variantsPresent) {
        const perVariant = parsed.variantGroups.get(it.name);
        const vars = (parsed.variantsByItem.get(it.name) || []).map(v => ({
          name: v.name, price: v.price, image: '',
          addon_groups: perVariant && perVariant.has(v.name) ? ids(perVariant.get(v.name)) : []
        }));
        sets.push('variations = ?'); params.push(JSON.stringify(vars));
        summary.variants += vars.length;
      }
      if (parsed.addonsPresent) {
        sets.push('assigned_addon_groups = ?');
        params.push(JSON.stringify(ids((parsed.itemGroups.get(it.name) || []).map(g => g.defKey))));
      }
      await run(`UPDATE menu SET ${sets.join(', ')} WHERE name = ?`, [...params, it.name]);
    }
  }

  // 4. replace mode: drop everything the sheet doesn't list
  if (replace) {
    const notIn = (col, vals) => vals.length ? `${col} NOT IN (${vals.map(() => '?').join(',')})` : '1=1';
    const names = parsed.items.map(i => i.name);
    summary.deleted.items = (await run(`DELETE FROM menu WHERE ${notIn('name', names)}`, names)).changes || 0;
    const cats = parsed.categories.map(c => c.name);
    summary.deleted.categories = (await run(`DELETE FROM categories WHERE ${notIn('name', cats)}`, cats)).changes || 0;
    if (parsed.addonsPresent) {
      const ids = [...groupIds.values()];
      summary.deleted.addonGroups = (await run(`DELETE FROM addon_groups WHERE ${notIn('id', ids)}`, ids)).changes || 0;
    }
  }

  // 5. upsells
  if (parsed.upsellsPresent && parsed.upsells.length) {
    await run('DELETE FROM upsells');
    await bulkInsert('upsells', ['item_name', 'upsell_type', 'suggested_item', 'suggested_category', 'label', 'sort_order', 'is_active'],
      parsed.upsells.map(u => [u.item_name, u.type, u.suggested_item, u.suggested_category, u.label, u.sort, u.active ? 1 : 0]));
    summary.upsells = parsed.upsells.length;
  }

  // 6. inventory & recipes (only the sheets that actually carry rows)
  const inv = parsed.inventory;
  if (inv.units && inv.units.length) {
    await bulkInsert('units', ['name', 'abbreviation', 'unit_type'], inv.units.map(u => [u.name, u.abbreviation, u.unit_type]),
      'ON CONFLICT(name) DO UPDATE SET abbreviation = excluded.abbreviation, unit_type = excluded.unit_type');
    summary.inventory.units = inv.units.length;
  }
  if (inv.suppliers && inv.suppliers.length) {
    await bulkInsert('suppliers', ['name', 'contact_person', 'phone', 'email', 'address', 'gstin', 'payment_terms_days', 'notes', 'is_active'],
      inv.suppliers.map(s => [s.name, s.contact, s.phone, s.email, s.address, s.gstin, s.terms, s.notes, s.active ? 1 : 0]),
      `ON CONFLICT(name) DO UPDATE SET contact_person = excluded.contact_person, phone = excluded.phone, email = excluded.email,
       address = excluded.address, gstin = excluded.gstin, payment_terms_days = excluded.payment_terms_days, notes = excluded.notes, is_active = excluded.is_active`);
    summary.inventory.suppliers = inv.suppliers.length;
  }
  if (inv.ingredients && inv.ingredients.length) {
    // Opening stock only seeds brand-new ingredients; existing running stock is never overwritten.
    await bulkInsert('ingredients', ['name', 'unit', 'unit_abbr', 'cost_per_unit', 'stock', 'reorder_level', 'ingredient_group', 'supplier'],
      inv.ingredients.map(i => [i.name, i.unit, i.unit_abbr, i.cost, i.stock, i.reorder, i.group, i.supplier]),
      `ON CONFLICT(name) DO UPDATE SET unit = excluded.unit, unit_abbr = excluded.unit_abbr, cost_per_unit = excluded.cost_per_unit,
       reorder_level = excluded.reorder_level, ingredient_group = excluded.ingredient_group, supplier = excluded.supplier`);
    summary.inventory.ingredients = inv.ingredients.length;
  }
  if (inv.supplierCatalog && inv.supplierCatalog.length) {
    await run('DELETE FROM supplier_catalog');
    await bulkInsert('supplier_catalog', ['supplier', 'ingredient', 'purchase_unit', 'unit_abbr', 'unit_cost', 'pack_size', 'lead_time_days', 'min_order_qty', 'is_active'],
      inv.supplierCatalog.map(c => [c.supplier, c.ingredient, c.unit, c.unit_abbr, c.cost, c.pack_size, c.lead_time, c.min_qty, c.active ? 1 : 0]));
    summary.inventory.supplierCatalog = inv.supplierCatalog.length;
  }
  if (inv.recipes && inv.recipes.length) {
    await run('DELETE FROM recipe_ingredients');
    await run('DELETE FROM recipes');
    await bulkInsert('recipes', ['item_name', 'recipe_name', 'portion_size', 'yield_qty', 'prep_time', 'cook_time', 'prep_notes'],
      inv.recipes.map(r => [r.item_name, r.recipe_name, r.portion, r.yield_qty, r.prep, r.cook, r.notes]));
    summary.inventory.recipes = inv.recipes.length;
    if (inv.recipeLines && inv.recipeLines.length) {
      await bulkInsert('recipe_ingredients', ['item_name', 'ingredient', 'quantity', 'unit', 'unit_abbr', 'wastage_pct', 'line_order', 'notes'],
        inv.recipeLines.map(l => [l.item_name, l.ingredient, l.qty, l.unit, l.unit_abbr, l.wastage, l.order, l.notes]));
      summary.inventory.recipeLines = inv.recipeLines.length;
    }
  }

  return summary;
}

module.exports = { parseWorkbook, applyImport };
