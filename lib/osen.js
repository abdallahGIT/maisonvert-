// Osen Logistics — sending orders to the delivery company.
//
// Osen has no public API documentation, so for now orders are put in a "send list"
// (courier_status = 'queued') from the admin page or the Telegram button, and the admin
// downloads them as one CSV file to import in the Osen space (status becomes 'exported').
// When Osen gives an API (URL + key), only sendToApi() below needs to be written.
const { query } = require('./db');

const MERCHANT_ID = process.env.OSEN_MERCHANT_ID || '01a163d0-dfb9-f214-ef0f-0f377b940761';
const SHOP_ID = process.env.OSEN_SHOP_ID || '01a163d1-d195-0bd0-845e-f4ba38ad45d9';
const PRODUCT = 'بذور طماطم قلب الثور 2غ + هدية بذور البطيخ';

function apiConfigured() {
  return !!(process.env.OSEN_API_URL && process.env.OSEN_API_KEY);
}

// Put orders in the Osen send list. Cancelled orders are refused; already sent ones are left alone.
async function queueOrders(ids) {
  ids = [...new Set(ids.map((x) => parseInt(x, 10)).filter((x) => x > 0))].slice(0, 500);
  if (!ids.length) return { orders: [], queued: 0, message: 'لا توجد طلبات' };
  const r = await query(
    `UPDATE orders SET courier_status = 'queued', courier_at = now(), updated_at = now()
     WHERE id = ANY($1::int[]) AND status <> 'cancelled' AND (courier_status IS NULL OR courier_status = 'queued')
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

module.exports = { apiConfigured, queueOrders, exportQueued, toCsv, MERCHANT_ID, SHOP_ID };
