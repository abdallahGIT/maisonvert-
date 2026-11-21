// Osen Logistics — sending orders to the delivery company.
//
// Osen has no public API documentation, so for now orders are put in a "send list"
// (courier_status = 'queued') from the admin page or the Telegram button, and the admin
// downloads them as one CSV file to import in the Osen space (status becomes 'exported').
// When Osen gives an API (URL + key), only sendToApi() below needs to be written.
const { query } = require('./db');

const MERCHANT_ID = process.env.OSEN_MERCHANT_ID || '01a163d0-dfb9-f214-ef0f-0f377b940761';
const SHOP_ID = process.env.OSEN_SHOP_ID || '01a163d1-d195-0bd0-845e-f4ba38ad45d9';

// Merchant ID + Store ID are edited in the admin page (Osen tab) and saved in settings 'osen'.
async function getIds() {
  try {
    const r = await query(`SELECT value FROM settings WHERE key = 'osen'`);
    const v = (r.rows[0] && r.rows[0].value) || {};
    return { merchant_id: v.merchant_id || MERCHANT_ID, store_id: v.store_id || SHOP_ID, source: v.source || '16' };
  } catch (_) { return { merchant_id: MERCHANT_ID, store_id: SHOP_ID, source: '16' }; }
}
async function saveIds(b) {
  const id = (s) => String(s || '').trim().slice(0, 64).replace(/[^A-Za-z0-9-]/g, '');
  const src = String(b.source || '16').replace(/\D/g, '').padStart(2, '0').slice(-2);
  const v = { merchant_id: id(b.merchant_id), store_id: id(b.store_id), source: src };
  await query(`INSERT INTO settings (key, value) VALUES ('osen', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify(v)]);
  return getIds();
}
async function authHeaders() {
  const ids = await getIds();
  const h = { 'x-api-id': ids.merchant_id, 'x-store-id': ids.store_id };
  if (apiKey()) h.authorization = 'Bearer ' + apiKey();
  return h;
}
const PRODUCT = 'بذور طماطم قلب الثور 2غ + هدية بذور البطيخ';

const BASE = (process.env.OSEN_API_URL || 'https://backendmain.osenexpress.com').replace(/\/+$/, '');

// The API key ("Clé API permanente" from osenexpress.com → Paramètres → API) is sent as a Bearer token,
// with the merchant ID as X-Api-Id. Without the key, orders go to the CSV send list instead.
function apiKey() {
  return String(process.env.OSEN_API_KEY || '').trim().replace(/^Bearer\s+/i, '');
}
function apiConfigured() {
  return !!apiKey();
}

// ---- Osen communes and stop desks (public list, cached 6h per server instance) ----
const norm = (s) => String(s || '').replace(/[\u064B-\u0652\u0640]/g, '').replace(/[أإآٱ]/g, 'ا').replace(/ة/g, 'ه')
  .replace(/ى/g, 'ي').replace(/ؤ/g, 'و').replace(/ئ/g, 'ي').replace(/[^\u0621-\u064A]/g, '').replace(/^ال/, '');
let geoCache = null;
let geoAt = 0;
async function geo() {
  if (geoCache && Date.now() - geoAt < 6 * 3600e3) return geoCache;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 6000);
  try {
    const r = await fetch(BASE + '/geo/provinces', { signal: ctl.signal });
    if (!r.ok) throw new Error('Osen geo HTTP ' + r.status);
    const list = await r.json();
    const map = {};
    for (const p of list) {
      const code = String(p.code || p.id).padStart(2, '0');
      map[code] = {};
      for (const m of p.municipalities || []) {
        const d = m.servingStopdesk;
        map[code][norm(m.name_arabic)] = { id: m.id, desk: d ? { name: d.name, address: d.address, phone: d.phoneNumber, location: d.location } : null };
      }
    }
    geoCache = map; geoAt = Date.now();
    return map;
  } finally { clearTimeout(t); }
}
async function municipality(code, commune) {
  const g = await geo();
  return (g[code] && g[code][norm(commune)]) || null;
}
// {code: {commune: deskName}} for the communes Osen serves with a stop desk (for the landing page)
async function deskMap(COMMUNES) {
  const g = await geo();
  const out = {};
  for (const [code, w] of Object.entries(COMMUNES)) {
    for (const c of w.communes) {
      const m = g[code] && g[code][norm(c)];
      if (m && m.desk) (out[code] = out[code] || {})[c] = m.desk.name;
    }
  }
  return out;
}

// ---- Create the parcel in Osen ----
async function createParcel(o) {
  const m = await municipality(o.wilaya_code, o.commune);
  if (!m) throw new Error(`البلدية غير موجودة في Osen: ${o.commune}`);
  if (o.delivery_type === 'desk' && !m.desk) throw new Error('لا يوجد مكتب Osen لهذه البلدية');
  const phone = String(o.phone || '').replace(/\D/g, '');
  const body = {
    target: {
      fullName: o.name,
      phoneNumberPrimary: phone.startsWith('0') ? '213' + phone.slice(1) : phone,
      address: o.reference || o.commune,
      municipality: { id: m.id },
    },
    parcel: {
      description: PRODUCT + (o.qty > 1 ? ` × ${o.qty}` : ''),
      weight: 1, volume: 0.01, fragile: false, openable: false, tryable: false,
      refrenceId: 'CMD-' + o.id,
      note: o.note || undefined,
      amount: Number(o.unit_price) * Number(o.qty),
    },
    operation: { deliveryType: o.delivery_type === 'desk' ? 'STOPDESK' : 'DELIVERY' },
    cashCollection: { totalPostTarget: Number(o.total) },
  };
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 9000);
  let r, j;
  try {
    r = await fetch(BASE + '/v1/orders', {
      method: 'POST', signal: ctl.signal,
      headers: { 'content-type': 'application/json', accept: 'application/json', ...(await authHeaders()) },
      body: JSON.stringify(body),
    });
    j = await r.json().catch(() => ({}));
  } finally { clearTimeout(t); }
  if (!r.ok) {
    const msg = Array.isArray(j.message) ? j.message.join(', ') : (j.message || 'HTTP ' + r.status);
    throw new Error(r.status === 401 ? 'مفتاح Osen غير صحيح (OSEN_API_KEY)' : 'Osen: ' + msg);
  }
  const d = j.data || j;
  return { id: d.id, tracking: d.trackingId || d.tracking_id || d.id };
}

// Full connection test, step by step (admin → Osen → اختبار الاتصال)
async function testConnection() {
  const steps = [];
  const ids = await getIds();
  steps.push({ name: 'المعرّفات', ok: !!(ids.merchant_id && ids.store_id), detail: `Merchant ${ids.merchant_id} · Store ${ids.store_id}` });
  try {
    geoCache = null;
    const g = await geo();
    const n = Object.values(g).reduce((a, w) => a + Object.keys(w).length, 0);
    const d = Object.values(g).reduce((a, w) => a + Object.values(w).filter((m) => m.desk).length, 0);
    steps.push({ name: 'خادم Osen (الولايات والبلديات)', ok: true, detail: `${Object.keys(g).length} ولاية · ${n} بلدية · ${d} بلدية فيها توصيل للمكتب` });
  } catch (e) { steps.push({ name: 'خادم Osen', ok: false, detail: e.message }); }
  try {
    const r = await fetch(BASE + '/v1/pricing-merchant-query-handler/?pagination%5Bskip%5D=0&pagination%5Btake%5D=1', { headers: await authHeaders() });
    const j = await r.json().catch(() => ({}));
    if (r.ok) steps.push({ name: 'حساب التاجر (الأسعار وإرسال الطلبات)', ok: true, detail: `${(j.metaData && j.metaData.count) || 0} سعر في حسابك` });
    else steps.push({ name: 'حساب التاجر (الأسعار وإرسال الطلبات)', ok: false, detail: `Osen رفض الطلب (${r.status}: ${Array.isArray(j.message) ? j.message.join(', ') : j.message || ''}). Osen يطلب مفتاح API مع المعرّفين لقراءة الأسعار وإنشاء الطرود.` });
  } catch (e) { steps.push({ name: 'حساب التاجر', ok: false, detail: e.message }); }
  return { ok: steps.every((s) => s.ok), steps };
}

// Download the merchant's Osen price list and turn it into the site's delivery fee table.
async function importPricing() {
  const ids = await getIds();
  const rows = [];
  for (let skip = 0; skip < 20000; skip += 200) {
    const r = await fetch(`${BASE}/v1/pricing-merchant-query-handler/?pagination%5Bskip%5D=${skip}&pagination%5Btake%5D=200`, { headers: await authHeaders() });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(r.status === 401 ? 'Osen رفض قراءة الأسعار: يلزم مفتاح API من Osen مع المعرّفين' : 'Osen: ' + (j.message || r.status));
    rows.push(...(j.data || []));
    if (!j.data || j.data.length < 200 || rows.length >= ((j.metaData && j.metaData.count) || 0)) break;
  }
  const src = Number(ids.source);
  const pick = (dest, type) => {
    const m = (r) => r.deliveryType === type && (String(r.destination) === String(dest) || r.destination === 'all');
    const best = rows.filter((r) => m(r) && Number(r.source) === src)[0] || rows.filter((r) => m(r) && r.source === 'all')[0];
    return best ? Math.round(Number(best.deliveryPrice)) : null;
  };
  const fees = {};
  for (let i = 1; i <= 58; i++) {
    const code = String(i).padStart(2, '0');
    fees[code] = { home: pick(i, 'DOORSTEP'), desk: pick(i, 'STOPDESK'), desk_communes: [] };
  }
  return { fees, rows: rows.length, source: ids.source };
}

// For /api/health: is Osen reachable and is the key accepted? (read-only request)
async function check() {
  const out = { key_set: apiConfigured() };
  try { const g = await geo(); out.communes_ok = Object.keys(g).length; } catch (e) { out.communes_error = e.message; }
  if (out.key_set) {
    try {
      const r = await fetch(BASE + '/v1/orders-merchant-query-handler/counts', { headers: await authHeaders() });
      out.key_ok = r.ok;
      if (!r.ok) out.key_status = r.status;
    } catch (e) { out.key_error = e.message; }
  }
  return out;
}

// Send orders to Osen now (API mode). Returns per-order results.
async function sendOrders(ids) {
  const rows = (await query(`SELECT * FROM orders WHERE id = ANY($1::int[]) AND status <> 'cancelled' ORDER BY id`, [ids])).rows;
  const results = [];
  for (const o of rows) {
    if (o.courier_status === 'sent') { results.push({ id: o.id, ok: true, already: true, tracking: o.courier_ref, order: o }); continue; }
    try {
      const p = await createParcel(o);
      const u = await query(`UPDATE orders SET courier_status = 'sent', courier_ref = $2, courier_error = NULL, courier_at = now(), updated_at = now() WHERE id = $1 RETURNING *`, [o.id, p.tracking]);
      results.push({ id: o.id, ok: true, tracking: p.tracking, order: u.rows[0] });
    } catch (e) {
      const u = await query(`UPDATE orders SET courier_status = 'error', courier_error = $2, updated_at = now() WHERE id = $1 RETURNING *`, [o.id, String(e.message).slice(0, 300)]);
      results.push({ id: o.id, ok: false, error: e.message, order: u.rows[0] });
    }
  }
  return results;
}

// Put orders in the Osen send list. Cancelled orders are refused; already sent ones are left alone.
async function queueOrders(ids) {
  ids = [...new Set(ids.map((x) => parseInt(x, 10)).filter((x) => x > 0))].slice(0, 500);
  if (!ids.length) return { orders: [], queued: 0, message: 'لا توجد طلبات' };
  if (apiConfigured()) {
    const res = await sendOrders(ids.slice(0, 50));
    const ok = res.filter((r) => r.ok);
    const bad = res.filter((r) => !r.ok);
    let message = ok.length === 1 && res.length === 1
      ? (ok[0].already ? `تم إرساله إلى Osen من قبل — ${ok[0].tracking}` : `✅ تم إنشاء الطرد في Osen — رقم التتبع: ${ok[0].tracking}`)
      : `✅ ${ok.length} طرد أُنشئ في Osen`;
    if (bad.length) message = (ok.length ? message + '\n' : '') + `❌ ${bad.length === 1 && res.length === 1 ? '' : bad.length + ' فشل: '}${bad[0].error}`;
    return { orders: res.map((r) => r.order), queued: ok.length, sent: ok.length, failed: bad.length, message, api: true };
  }
  const r = await query(
    `UPDATE orders SET courier_status = 'queued', courier_at = now(), updated_at = now()
     WHERE id = ANY($1::int[]) AND status <> 'cancelled' AND (courier_status IS NULL OR courier_status IN ('queued','error'))
     RETURNING id`,
    [ids]
  );
  const all = await query(`SELECT * FROM orders WHERE id = ANY($1::int[]) AND status <> 'cancelled' ORDER BY id`, [ids]);
  const n = r.rows.length;
  const already = all.rows.filter((o) => o.courier_status && o.courier_status !== 'queued').length;
  let message = n ? `📤 ${n === 1 ? 'الطلب في' : n + ' طلبات في'} قائمة Osen. حمّل الملف من صفحة الإدارة ← الطلبات ← تصدير Osen.` : 'لم يتغير شيء';
  if (already) message = `هذا الطلب تم تصديره إلى Osen من قبل (${all.rows[0].courier_status === 'sent' ? 'تم الإرسال' : 'تم التصدير'})`;
  return { orders: all.rows, queued: n, message };
}

const COLUMNS = [
  ['reference', 'Référence'], ['name', 'Nom et prénom'], ['phone', 'Téléphone'], ['wilaya_code', 'Code wilaya'],
  ['wilaya', 'Wilaya'], ['commune', 'Commune'], ['address', 'Adresse'], ['product', 'Produit'], ['qty', 'Quantité'],
  ['amount', 'Montant à encaisser (DA)'], ['stop_desk', 'Stop desk'], ['note', 'Remarque'],
];

function csvCell(v) {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@]/.test(s)) s = "'" + s; // spreadsheet formula guard
  return /[",\n;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function toCsv(orders) {
  const rows = orders.map((o) => ({
    reference: 'CMD-' + o.id, name: o.name, phone: o.phone, wilaya_code: o.wilaya_code, wilaya: o.wilaya,
    commune: o.commune, address: o.reference || o.commune, product: PRODUCT, qty: o.qty, amount: o.total,
    stop_desk: o.delivery_type === 'desk' ? 'oui' : 'non', note: o.note || '',
  }));
  return '﻿' + [COLUMNS.map((c) => c[1]).join(','), ...rows.map((r) => COLUMNS.map((c) => csvCell(r[c[0]])).join(','))].join('\r\n');
}

// Download the send list as CSV; the downloaded orders are marked 'exported'.
async function exportQueued({ mark = true } = {}) {
  const r = await query(`SELECT * FROM orders WHERE courier_status = 'queued' AND status <> 'cancelled' ORDER BY id`);
  if (mark && r.rows.length) {
    await query(`UPDATE orders SET courier_status = 'exported', courier_at = now(), updated_at = now() WHERE id = ANY($1::int[])`, [r.rows.map((o) => o.id)]);
  }
  return { count: r.rows.length, csv: toCsv(r.rows) };
}

module.exports = { testConnection, importPricing, getIds, saveIds, check, apiConfigured, geo, municipality, deskMap, createParcel, sendOrders, queueOrders, exportQueued, toCsv, MERCHANT_ID, SHOP_ID };
