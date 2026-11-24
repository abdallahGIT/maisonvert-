// Osen Logistics — sending orders to the delivery company.
//
// Osen API operations run server-side when an API token is configured:
//   - connection validation  (POST /v2/ecomanager/auth/validate)
//   - delivery-fee import    (GET  /api/v1/get/fees)
//   - parcel creation        (POST /v2/ecomanager/orders, JSON array)
//   - tracking sync          (POST /v2/ecomanager/orders, {"trackings": [...]})
// Without a token, orders can still be queued (courier_status = 'queued') and exported
// as one CSV file for manual import in the Osen space (status becomes 'exported').
// Credentials entered in Admin are stored encrypted in settings; OSEN_API_KEY is only an
// optional environment-variable fallback.
const { query } = require('./db');

const MERCHANT_ID = process.env.OSEN_MERCHANT_ID || '01a163d0-dfb9-f214-ef0f-0f377b940761';
const SHOP_ID = process.env.OSEN_SHOP_ID || '01a163d1-d195-0bd0-845e-f4ba38ad45d9';

// Osen settings are entered in the admin page (Osen tab) and saved server-side in settings 'osen':
//   merchant_id, store_id (not secret) and token_enc = the API token, AES-256-GCM encrypted.
// The token is never sent back to the browser and never logged.
const crypto = require('crypto');
function secretKey() {
  const s = process.env.OSEN_SECRET || process.env.ADMIN_PASSWORD || '';
  return s ? crypto.createHash('sha256').update('osen-token:' + s).digest() : null;
}
function encrypt(text) {
  const k = secretKey();
  if (!k) throw new Error('ADMIN_PASSWORD غير مضبوط: لا يمكن حفظ المفتاح بأمان');
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', k, iv);
  const enc = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString('base64')).join('.');
}
function decrypt(s) {
  try {
    const k = secretKey();
    const [iv, tag, enc] = String(s).split('.').map((x) => Buffer.from(x, 'base64'));
    const d = crypto.createDecipheriv('aes-256-gcm', k, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
  } catch (_) { return ''; } // wrong secret or corrupted: treated as "no token saved"
}
async function readSettings() {
  try {
    const r = await query(`SELECT value FROM settings WHERE key = 'osen'`);
    return (r.rows[0] && r.rows[0].value) || {};
  } catch (_) { return {}; }
}
// Where to fix a missing or rejected token (shown in admin / Telegram errors).
const TOKEN_HINT = 'أدخل « Clé API » في صفحة الإدارة ← تبويب Osen ثم اضغط اختبار الاتصال';

// Token: the one saved in the admin page first; OSEN_API_KEY env var only as a fallback.
async function getToken() {
  const v = await readSettings();
  const saved = v.token_enc ? decrypt(v.token_enc) : '';
  return (saved || String(process.env.OSEN_API_KEY || '')).trim().replace(/^Bearer\s+/i, '');
}
async function getIds() {
  const v = await readSettings();
  return {
    merchant_id: v.merchant_id || MERCHANT_ID, store_id: v.store_id || SHOP_ID, source: v.source || '16',
    token_saved: !!(v.token_enc && decrypt(v.token_enc)), token_env: !!process.env.OSEN_API_KEY,
  };
}
async function saveIds(b) {
  const id = (s) => String(s || '').trim().slice(0, 64).replace(/[^A-Za-z0-9-]/g, '');
  const src = String(b.source || '16').replace(/\D/g, '').padStart(2, '0').slice(-2);
  const cur = await readSettings();
  const v = { merchant_id: id(b.merchant_id), store_id: id(b.store_id), source: src, token_enc: cur.token_enc };
  const tok = String(b.api_token || '').trim().replace(/^Bearer\s+/i, '');
  if (tok) v.token_enc = encrypt(tok.slice(0, 4000));
  if (b.clear_token) delete v.token_enc;
  await query(`INSERT INTO settings (key, value) VALUES ('osen', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify(v)]);
  return getIds();
}
async function authHeaders() {
  // Official EcoManager v2 auth: X-Api-Id = merchant ID, token in X-Api-Token (v1 reads Authorization: Bearer).
  const ids = await getIds();
  const tok = await getToken();
  const h = { 'x-api-id': ids.merchant_id };
  if (tok) { h['x-api-token'] = tok; h.authorization = 'Bearer ' + tok; }
  return h;
}
const PRODUCT = 'بذور طماطم قلب الثور 2غ + هدية بذور البطيخ';

const BASE = (process.env.OSEN_API_URL || 'https://backendmain.osenexpress.com').replace(/\/+$/, '');

// Without a token, orders go to the CSV send list instead.
async function apiConfigured() {
  return !!(await getToken());
}

// ---- Osen communes and stop desks (public list, cached 6h per server instance) ----
const norm = (s) => String(s || '').replace(/[\u064B-\u0652\u0640]/g, '').replace(/[أإآٱ]/g, 'ا').replace(/ة/g, 'ه')
  .replace(/ى/g, 'ي').replace(/ؤ/g, 'و').replace(/ئ/g, 'ي').replace(/[^\u0621-\u064A]/g, '').replace(/^ال/, '');
let geoCache = null;
let geoAt = 0;
async function geo({ fresh = false } = {}) {
  if (!fresh && geoCache && Date.now() - geoAt < 6 * 3600e3) return geoCache;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 6000);
  try {
    // provinces = communes (+ the desk that serves each one); stopdesks = where each office actually is
    const [r, rs] = await Promise.all([
      fetch(BASE + '/geo/provinces', { signal: ctl.signal }),
      fetch(BASE + '/geo/stopdesks', { signal: ctl.signal }),
    ]);
    if (!r.ok) throw new Error('Osen geo HTTP ' + r.status);
    if (!rs.ok) throw new Error('Osen stopdesks HTTP ' + rs.status);
    const list = await r.json();
    const sj = await rs.json();
    const desks = Array.isArray(sj) ? sj : (sj.data || sj.items || []);
    // Office delivery is offered only in a commune that has its own Osen office.
    const details = {}; // desk id -> address/phone/location (given on the communes list)
    for (const p of list) for (const m of p.municipalities || []) if (m.servingStopdesk) details[m.servingStopdesk.id] = m.servingStopdesk;
    const deskIn = {}; // municipality id -> office located there
    for (const d of desks) {
      const mid = d.municipality && d.municipality.id;
      if (mid == null || deskIn[mid]) continue;
      const x = details[d.id] || {};
      deskIn[mid] = { name: d.name, code: d.code, address: x.address, phone: x.phoneNumber, location: x.location };
    }
    const map = {};
    for (const p of list) {
      const code = String(p.code || p.id).padStart(2, '0');
      map[code] = {};
      for (const m of p.municipalities || []) {
        // served = Osen links the commune to one of its offices (communes without one are not delivered)
        map[code][norm(m.name_arabic)] = { id: m.id, served: !!m.servingStopdesk, desk: deskIn[m.id] || null };
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
// {code: {commune: deskName}} for the communes that have their own Osen office (for the landing page)
// Per wilaya: which communes Osen delivers to, and which have their own office (admin "import baladias")
async function communesReport(COMMUNES, opts) {
  const g = await geo(opts);
  const out = {};
  for (const [code, w] of Object.entries(COMMUNES)) {
    const r = { total: w.communes.length, served: 0, unserved: [], offices: {} };
    for (const c of w.communes) {
      const m = g[code] && g[code][norm(c)];
      if (m && m.served) r.served++; else r.unserved.push(c);
      if (m && m.desk) r.offices[c] = m.desk.name;
    }
    out[code] = r;
  }
  return out;
}
// {code: [commune, ...]} for communes Osen does not deliver to (not in its list, or no office serves them)
async function unservedMap(COMMUNES) {
  const g = await geo();
  const out = {};
  for (const [code, w] of Object.entries(COMMUNES)) {
    if (!g[code]) continue;
    for (const c of w.communes) {
      const m = g[code][norm(c)];
      if (!m || !m.served) (out[code] = out[code] || []).push(c);
    }
  }
  return out;
}
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

// ---- Create the parcel in Osen (official v2: POST /v2/ecomanager/orders with a JSON array) ----
async function osenFetch(path, opts = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), opts.timeout || 9000);
  try {
    const r = await fetch(BASE + path, { ...opts, redirect: 'error', signal: ctl.signal, headers: { accept: 'application/json', 'content-type': 'application/json', ...(await authHeaders()), ...(opts.headers || {}) } });
    const j = await r.json().catch(() => ({}));
    return { r, j };
  } finally { clearTimeout(t); }
}
const errText = (j, r) => (Array.isArray(j.message) ? j.message.join(', ') : j.message || j.error || 'HTTP ' + r.status);

async function createParcel(o) {
  const m = await municipality(o.wilaya_code, o.commune);
  if (!m) throw new Error(`البلدية غير موجودة في Osen: ${o.commune}`);
  if (o.delivery_type === 'desk' && !m.desk) throw new Error('لا يوجد مكتب Osen لهذه البلدية');
  const body = [{
    order_id: 'CMD-' + o.id,
    recipient_name: o.name,
    recipient_phone: String(o.phone || '').replace(/\D/g, ''),
    address: o.reference || o.commune,
    wilaya_id: String(Number(o.wilaya_code)),
    commune_id: String(m.id),
    is_stopdesk: o.delivery_type === 'desk',
    cod_amount: Number(o.total),
    weight_kg: 0.2,
    note: o.note || null,
  }];
  const { r, j } = await osenFetch('/v2/ecomanager/orders', { method: 'POST', body: JSON.stringify(body), timeout: 15000 });
  if (r.status === 401) throw new Error('Osen: ' + errText(j, r) + ' — ' + TOKEN_HINT);
  if (!r.ok) throw new Error('Osen: ' + errText(j, r));
  const row = Array.isArray(j) ? j[0] : null;
  if (!row || !row.success || !row.tracking) throw new Error('Osen: ' + ((row && (row.error_message || row.error_code)) || 'لم يتم قبول الطلب'));
  return { tracking: row.tracking };
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
  // Official identity check: POST /v2/ecomanager/auth/validate {api_id, api_token}
  try {
    const { r, j } = await osenFetch('/v2/ecomanager/auth/validate', { method: 'POST', body: JSON.stringify({ api_id: ids.merchant_id, api_token: await getToken() }) });
    if (r.ok && j.valid === true) {
      const storeOk = !j.store || String(j.store.id) === String(ids.store_id);
      steps.push({ name: 'حساب التاجر (الأسعار وإرسال الطلبات)', ok: storeOk, detail: storeOk ? `مفعّل (${j.scope || ''})` : `المفتاح يخص متجراً آخر (${j.store && j.store.id})` });
    } else {
      steps.push({ name: 'حساب التاجر (الأسعار وإرسال الطلبات)', ok: false, detail: `جواب Osen: « ${errText(j, r)} ». Osen يقبل الأسعار وإنشاء الطرود فقط بمعرّف التاجر + مفتاح API (token).` });
    }
  } catch (e) { steps.push({ name: 'حساب التاجر', ok: false, detail: e.message }); }
  return { ok: steps.every((s) => s.ok), steps };
}

// Download the merchant's Osen price list and turn it into the site's delivery fee table.
async function importPricing() {
  // Official v1 fees: livraison[] rows {wilaya_id, tarif, tarif_stopdesk}; "0" = service unavailable.
  const { r, j } = await osenFetch('/api/v1/get/fees');
  if (!r.ok) throw new Error(r.status === 401 ? 'Osen رفض قراءة الأسعار («' + errText(j, r) + '»): ' + TOKEN_HINT : 'Osen: ' + errText(j, r));
  const rows = j.livraison || [];
  const num = (v) => { const n = Math.round(Number(v)); return n > 0 ? n : null; };
  const fees = {};
  for (const row of rows) {
    const code = String(row.wilaya_id).padStart(2, '0');
    fees[code] = { home: num(row.tarif), desk: num(row.tarif_stopdesk), desk_communes: [] };
  }
  const ret = (j.retours || []).map((x) => num(x.tarif)).filter(Boolean);
  return { fees, rows: rows.length, return_fee: ret.length ? Math.round(ret.reduce((a, b) => a + b, 0) / ret.length) : null };
}

// ---- Tracking status sync (official v2: POST /v2/ecomanager/orders with {"trackings": [...]}) ----
// Raw Osen status is always saved and shown. The shop's own order status is only moved for clear cases.
const TO_SHOP_STATUS = {
  PICKED_UP: 'shipped', PENDING_RECEPTION: 'shipped', AWAITING_TRANSIT: 'shipped', IN_TRANSIT: 'shipped',
  READY_FOR_DELIVERY: 'shipped', OUT_FOR_DELIVERY: 'shipped',
  DELIVERED: 'delivered', PAID: 'delivered', SETTLED: 'delivered',
  RETURNED: 'returned', RETURN_ARRIVED: 'returned', RETURN_COLLECTED: 'returned',
};
const FINAL = ['delivered', 'returned', 'cancelled'];
function shopStatus(current, code) {
  const next = TO_SHOP_STATUS[code];
  if (!next || FINAL.includes(current)) return current;
  if (next === 'shipped' && !['new', 'confirmed', 'no_answer'].includes(current)) return current;
  return next;
}

async function syncTracking({ limit = 300 } = {}) {
  if (!(await apiConfigured())) return { ok: false, error: 'لا يوجد مفتاح API لـ Osen', checked: 0, updated: 0 };
  const rows = (await query(
    `SELECT id, status, courier_ref, courier_state FROM orders
     WHERE courier_status = 'sent' AND courier_ref IS NOT NULL AND status NOT IN ('delivered','returned','cancelled')
     ORDER BY courier_synced_at NULLS FIRST, id LIMIT $1`, [limit])).rows;
  let updated = 0;
  const errors = [];
  for (let i = 0; i < rows.length; i += 100) {
    const batch = rows.slice(i, i + 100);
    let res;
    try {
      const { r, j } = await osenFetch('/v2/ecomanager/orders', { method: 'POST', body: JSON.stringify({ trackings: batch.map((o) => o.courier_ref) }), timeout: 12000 });
      if (!r.ok) { errors.push('Osen: ' + errText(j, r)); continue; }
      res = Array.isArray(j) ? j : [];
    } catch (e) { errors.push(e.message); continue; }
    const byTracking = new Map(res.map((x) => [String(x.tracking), x]));
    for (const o of batch) {
      const x = byTracking.get(String(o.courier_ref));
      if (!x || !x.last_status) { await query(`UPDATE orders SET courier_synced_at = now() WHERE id = $1`, [o.id]); continue; }
      const st = x.last_status;
      const next = shopStatus(o.status, st.code);
      await query(
        `UPDATE orders SET courier_state = $2, courier_state_label = $3, courier_state_at = $4, courier_synced_at = now(),
           status = $5, updated_at = CASE WHEN status <> $5 OR courier_state IS DISTINCT FROM $2 THEN now() ELSE updated_at END
         WHERE id = $1`,
        [o.id, String(st.code || '').slice(0, 60), String(st.label || '').slice(0, 120), st.date ? new Date(st.date) : null, next]
      );
      if (next !== o.status || st.code !== o.courier_state) updated++;
    }
  }
  return { ok: errors.length === 0, checked: rows.length, updated, errors };
}

// For /api/health: is Osen reachable and is the key accepted? (read-only request)
async function check() {
  const out = { key_set: await apiConfigured() };
  try { const g = await geo(); out.communes_ok = Object.keys(g).length; } catch (e) { out.communes_error = e.message; }
  if (out.key_set) {
    try {
      const ids = await getIds();
      const { j } = await osenFetch('/v2/ecomanager/auth/validate', { method: 'POST', body: JSON.stringify({ api_id: ids.merchant_id, api_token: await getToken() }) });
      out.key_ok = j.valid === true && (!j.store || String(j.store.id) === String(ids.store_id));
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
  if (await apiConfigured()) {
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

module.exports = { communesReport, unservedMap, syncTracking, shopStatus, testConnection, importPricing, getIds, saveIds, check, apiConfigured, geo, municipality, deskMap, createParcel, sendOrders, queueOrders, exportQueued, toCsv, MERCHANT_ID, SHOP_ID };
