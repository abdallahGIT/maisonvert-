// /api/admin?action=... — everything the admin page needs. Requires the x-admin-key header = ADMIN_PASSWORD.
const { query, getSettings, saveSettings, getDeliveryFees, saveDeliveryFees, offerTotal, getTracking, saveTracking } = require('../lib/db');
const telegram = require('../lib/telegram');
const osen = require('../lib/osen');
const { send, readBody, isAdmin, clean } = require('../lib/http');

const ORDER_STATUSES = ['new', 'confirmed', 'no_answer', 'cancelled', 'shipped', 'delivered', 'returned'];
const LEAD_STATUSES = ['lead', 'called', 'no_answer', 'not_interested', 'ordered'];
const CONFIRMED = ['confirmed', 'shipped', 'delivered', 'returned'];

// Weeks start on Saturday, Algeria time.
const LOCAL_DAY = `(created_at AT TIME ZONE 'Africa/Algiers')::date`;
const iso = (d) => d.toISOString().slice(0, 10);
function weekStart(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 1) % 7));
  return iso(d);
}
function todayAlgiers() {
  return new Date(Date.now() + 3600 * 1000).toISOString().slice(0, 10);
}
function addDays(s, n) { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return iso(d); }

async function summary() {
  const s = await getSettings();
  const thisWeek = weekStart(todayAlgiers());
  const from = addDays(thisWeek, -7 * 7); // 8 weeks

  const [daily, leads, ads] = await Promise.all([
    query(
      `SELECT ${LOCAL_DAY} AS d,
              count(*)::int AS orders,
              count(*) FILTER (WHERE status = ANY($2))::int AS confirmed,
              count(*) FILTER (WHERE status = 'cancelled')::int AS cancelled,
              count(*) FILTER (WHERE status = 'no_answer')::int AS no_answer,
              count(*) FILTER (WHERE status = 'new')::int AS pending,
              count(*) FILTER (WHERE status = 'delivered')::int AS delivered,
              count(*) FILTER (WHERE status = 'returned')::int AS returned,
              COALESCE(sum(qty) FILTER (WHERE status = 'delivered'),0)::int AS qty_delivered,
              COALESCE(sum(total - delivery_fee) FILTER (WHERE status = 'delivered'),0)::int AS revenue,
              COALESCE(sum(qty) FILTER (WHERE status = ANY($2) AND status <> 'returned'),0)::int AS qty_confirmed,
              COALESCE(sum(total - delivery_fee) FILTER (WHERE status = ANY($2) AND status <> 'returned'),0)::int AS revenue_confirmed
         FROM orders WHERE ${LOCAL_DAY} >= $1::date GROUP BY 1 ORDER BY 1`,
      [from, CONFIRMED]
    ),
    query(`SELECT ${LOCAL_DAY} AS d, count(*)::int AS n FROM leads WHERE ${LOCAL_DAY} >= $1::date GROUP BY 1`, [from]),
    query(`SELECT week_start::text AS w, ad_spend_usd::float AS usd, usd_rate::float AS rate, other_costs, note FROM weekly_ads WHERE week_start >= $1::date`, [from]),
  ]);

  const dayMap = {};
  daily.rows.forEach((r) => { dayMap[iso(new Date(r.d))] = r; });
  const leadMap = {};
  leads.rows.forEach((r) => { leadMap[iso(new Date(r.d))] = r.n; });
  const adsMap = {};
  ads.rows.forEach((r) => { adsMap[r.w] = r; });

  const keys = ['orders', 'confirmed', 'cancelled', 'no_answer', 'pending', 'delivered', 'returned', 'qty_delivered', 'revenue', 'qty_confirmed', 'revenue_confirmed'];
  const weeks = [];
  for (let i = 0; i < 8; i++) {
    const ws = addDays(thisWeek, -7 * i);
    const w = { week_start: ws, week_end: addDays(ws, 6), leads: 0 };
    keys.forEach((k) => (w[k] = 0));
    for (let j = 0; j < 7; j++) {
      const day = addDays(ws, j);
      const r = dayMap[day];
      if (r) keys.forEach((k) => (w[k] += r[k]));
      w.leads += leadMap[day] || 0;
    }
    const a = adsMap[ws] || { usd: 0, rate: 0, other_costs: 0, note: '' };
    const rate = a.rate || s.usd_rate || 0;
    w.ad_spend_usd = a.usd;
    w.usd_rate = rate;
    w.ad_spend_da = Math.round(a.usd * rate);
    w.other_costs = a.other_costs || 0;
    w.note = a.note || '';
    w.cogs = w.qty_delivered * s.product_cost;
    w.delivery_costs = w.delivered * s.delivery_cost;
    w.return_costs = w.returned * s.return_cost;
    w.total_cost = w.cogs + w.delivery_costs + w.return_costs + w.ad_spend_da + w.other_costs;
    w.profit = w.revenue - w.total_cost;
    // "If every confirmed order gets delivered"
    const confirmedParcels = w.confirmed - w.returned;
    w.expected_profit = w.revenue_confirmed - w.qty_confirmed * s.product_cost - confirmedParcels * s.delivery_cost
      - w.return_costs - w.ad_spend_da - w.other_costs;
    w.confirmation_rate = w.orders ? w.confirmed / w.orders : 0;
    w.delivery_rate = (w.delivered + w.returned) ? w.delivered / (w.delivered + w.returned) : 0;
    w.cost_per_order = w.orders ? Math.round(w.ad_spend_da / w.orders) : 0;
    weeks.push(w);
  }

  const days = (ws) => Array.from({ length: 7 }, (_, j) => {
    const day = addDays(ws, j);
    const r = dayMap[day] || { orders: 0, confirmed: 0 };
    return { day, orders: r.orders, confirmed: r.confirmed, leads: leadMap[day] || 0, rate: r.orders ? r.confirmed / r.orders : null };
  });

  return { settings: s, today: todayAlgiers(), weeks, chart: { this_week: days(thisWeek), last_week: days(addDays(thisWeek, -7)) } };
}

module.exports = async (req, res) => {
  if (!isAdmin(req)) return send(res, 401, { ok: false, error: 'unauthorized' });
  const url = new URL(req.url, 'http://x');
  const action = url.searchParams.get('action') || '';
  const b = req.method === 'POST' ? await readBody(req) : {};

  try {
    switch (action) {
      case 'summary':
        return send(res, 200, { ok: true, ...(await summary()) });

      case 'orders': {
        const status = url.searchParams.get('status') || '';
        const q = clean(url.searchParams.get('q'), 60);
        const page = Math.max(0, parseInt(url.searchParams.get('page'), 10) || 0);
        const where = [];
        const params = [];
        if (ORDER_STATUSES.includes(status)) { params.push(status); where.push(`status = $${params.length}`); }
        if (q) { params.push('%' + q + '%'); where.push(`(phone LIKE $${params.length} OR name ILIKE $${params.length} OR commune ILIKE $${params.length} OR wilaya ILIKE $${params.length})`); }
        const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
        const [rows, counts, osenCounts] = await Promise.all([
          query(`SELECT * FROM orders ${w} ORDER BY id DESC LIMIT 50 OFFSET ${page * 50}`, params),
          query(`SELECT status, count(*)::int AS n FROM orders GROUP BY status`),
          query(`SELECT count(*) FILTER (WHERE courier_status = 'queued' AND status <> 'cancelled')::int AS queued,
                        count(*) FILTER (WHERE (courier_status IS NULL OR courier_status = 'error') AND status = 'confirmed')::int AS confirmed_not_sent FROM orders`),
        ]);
        return send(res, 200, { ok: true, orders: rows.rows, counts: Object.fromEntries(counts.rows.map((r) => [r.status, r.n])), osen: { ...osenCounts.rows[0], api: await osen.apiConfigured() } });
      }

      case 'update_order': {
        const id = parseInt(b.id, 10);
        const fields = [];
        const params = [id];
        if (b.status !== undefined) {
          if (!ORDER_STATUSES.includes(b.status)) return send(res, 400, { ok: false, error: 'bad status' });
          params.push(b.status); fields.push(`status = $${params.length}`);
          if (b.status === 'confirmed') fields.push('confirmed_at = COALESCE(confirmed_at, now())');
        }
        if (b.note !== undefined) { params.push(clean(b.note, 500)); fields.push(`note = $${params.length}`); }
        if (b.qty !== undefined) {
          const qty = Math.min(10, Math.max(1, parseInt(b.qty, 10) || 1));
          const packs = offerTotal(await getSettings(), qty); // same offer prices as the landing page
          params.push(qty); fields.push(`qty = $${params.length}`);
          params.push(packs); fields.push(`total = $${params.length} + delivery_fee`);
          params.push(Math.round(packs / qty)); fields.push(`unit_price = $${params.length}`);
        }
        if (!fields.length) return send(res, 400, { ok: false });
        const r = await query(`UPDATE orders SET ${fields.join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`, params);
        return send(res, 200, { ok: true, order: r.rows[0] });
      }

      case 'leads': {
        const status = url.searchParams.get('status') || 'open';
        let w = `WHERE status <> 'ordered'`;
        const params = [];
        if (LEAD_STATUSES.includes(status)) { params.push(status); w = `WHERE status = $1`; }
        if (status === 'all') w = '';
        const r = await query(`SELECT * FROM leads ${w} ORDER BY id DESC LIMIT 200`, params);
        return send(res, 200, { ok: true, leads: r.rows });
      }

      case 'update_lead': {
        if (!LEAD_STATUSES.includes(b.status)) return send(res, 400, { ok: false });
        const r = await query(`UPDATE leads SET status = $2, updated_at = now() WHERE id = $1 RETURNING *`, [parseInt(b.id, 10), b.status]);
        return send(res, 200, { ok: true, lead: r.rows[0] });
      }

      case 'delivery_fees': {
        const imp = await query(`SELECT value FROM settings WHERE key = 'osen_communes'`).catch(() => ({ rows: [] }));
        return send(res, 200, { ok: true, fees: await getDeliveryFees(), osen_communes: imp.rows[0] ? imp.rows[0].value : null });
      }

      case 'osen_import_communes': { // pull baladias + offices from Osen now (no cache) and keep a copy
        const report = await osen.communesReport(require('../lib/communes.json'), { fresh: true });
        const value = { at: new Date().toISOString(), report };
        await query(`INSERT INTO settings (key, value) VALUES ('osen_communes', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify(value)]);
        const sum = Object.values(report).reduce((a, r) => ({ served: a.served + r.served, total: a.total + r.total, offices: a.offices + Object.keys(r.offices).length }), { served: 0, total: 0, offices: 0 });
        return send(res, 200, { ok: true, osen_communes: value, ...sum });
      }

      case 'save_delivery_fees':
        return send(res, 200, { ok: true, fees: await saveDeliveryFees(b.fees) });

      case 'reset_preview': { // what "clear test data" would delete
        const r = await query(`SELECT
          (SELECT count(*) FROM orders)::int AS orders, (SELECT min(created_at) FROM orders) AS orders_from, (SELECT max(created_at) FROM orders) AS orders_to,
          (SELECT count(*) FROM leads)::int AS leads, (SELECT count(*) FROM weekly_ads)::int AS weeks`);
        return send(res, 200, { ok: true, counts: r.rows[0] });
      }

      case 'reset_data': { // before launch: back up, then empty orders, leads and weekly ad spend. Settings are kept.
        if (req.method !== 'POST' || b.confirm !== 'DELETE') return send(res, 400, { ok: false, error: 'confirm' });
        const [o, l, w] = await Promise.all([
          query('SELECT * FROM orders ORDER BY id'), query('SELECT * FROM leads ORDER BY id'), query('SELECT * FROM weekly_ads'),
        ]);
        const backup = { created_at: new Date().toISOString(), orders: o.rows, leads: l.rows, weekly_ads: w.rows };
        // a copy stays in the database (settings 'backup_before_launch') in case the download is lost
        await query(`INSERT INTO settings (key, value) VALUES ('backup_before_launch', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify(backup)]);
        await query('TRUNCATE orders, leads, weekly_ads RESTART IDENTITY');
        return send(res, 200, { ok: true, deleted: { orders: o.rows.length, leads: l.rows.length, weeks: w.rows.length }, backup });
      }

      case 'tracking_settings':
        return send(res, 200, { ok: true, tracking: await getTracking() });

      case 'save_tracking':
        return send(res, 200, { ok: true, tracking: await saveTracking(b) });

      case 'save_settings':
        return send(res, 200, { ok: true, settings: await saveSettings(b) });

      case 'save_week': {
        const ws = weekStart(String(b.week_start || '').slice(0, 10) || todayAlgiers());
        await query(
          `INSERT INTO weekly_ads (week_start, ad_spend_usd, usd_rate, other_costs, note) VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (week_start) DO UPDATE SET ad_spend_usd = EXCLUDED.ad_spend_usd, usd_rate = EXCLUDED.usd_rate,
             other_costs = EXCLUDED.other_costs, note = EXCLUDED.note`,
          [ws, Number(b.ad_spend_usd) || 0, Number(b.usd_rate) || 0, parseInt(b.other_costs, 10) || 0, clean(b.note, 200)]
        );
        return send(res, 200, { ok: true });
      }

      case 'export': {
        const status = url.searchParams.get('status') || '';
        const params = [];
        let w = '';
        if (ORDER_STATUSES.includes(status)) { params.push(status); w = 'WHERE status = $1'; }
        const r = await query(`SELECT id, created_at, name, phone, wilaya_code, wilaya, commune, reference, delivery_type, qty, unit_price, delivery_fee, total, status, note FROM orders ${w} ORDER BY id`, params);
        const cols = ['id', 'created_at', 'name', 'phone', 'wilaya_code', 'wilaya', 'commune', 'reference', 'delivery_type', 'qty', 'unit_price', 'delivery_fee', 'total', 'status', 'note'];
        const csvCell = (v) => {
          let s = v instanceof Date ? v.toISOString() : String(v == null ? '' : v);
          if (/^[=+\-@]/.test(s)) s = "'" + s;
          return '"' + s.replace(/"/g, '""') + '"';
        };
        const csv = '﻿' + [cols.join(','), ...r.rows.map((row) => cols.map((c) => csvCell(row[c])).join(','))].join('\n');
        res.statusCode = 200;
        res.setHeader('content-type', 'text/csv; charset=utf-8');
        res.setHeader('content-disposition', `attachment; filename="orders-${todayAlgiers()}.csv"`);
        return res.end(csv);
      }

      // ---- Osen Logistics ----
      case 'osen_settings':
        return send(res, 200, { ok: true, ids: await osen.getIds(), check: await osen.check().catch((e) => ({ error: e.message })) });
      case 'osen_sync':
        return send(res, 200, { ok: true, ...(await osen.syncTracking()) });
      case 'osen_test':
        return send(res, 200, { ok: true, ...(await osen.testConnection()) });
      case 'osen_import_prices': {
        const r = await osen.importPricing();
        const fees = await saveDeliveryFees(r.fees);
        const n = Object.values(fees).filter((f) => f.home != null || f.desk != null).length;
        if (r.return_fee) await saveSettings({ return_cost: r.return_fee }).catch(() => {});
        return send(res, 200, { ok: true, wilayas: n, rows: r.rows, return_fee: r.return_fee });
      }
      case 'save_osen_settings':
        return send(res, 200, { ok: true, ids: await osen.saveIds(b) });
      case 'osen_queue': { // body: {ids:[...]} or {all_confirmed:true}
        let ids = Array.isArray(b.ids) ? b.ids : [];
        if (b.all_confirmed) ids = (await query(`SELECT id FROM orders WHERE status = 'confirmed' AND (courier_status IS NULL OR courier_status = 'error')`)).rows.map((r) => r.id);
        const r = await osen.queueOrders(ids);
        return send(res, 200, { ok: true, queued: r.queued, failed: r.failed || 0, api: !!r.api, message: r.message });
      }
      case 'osen_unqueue': {
        await query(`UPDATE orders SET courier_status = NULL, courier_at = NULL, updated_at = now() WHERE id = $1 AND courier_status = 'queued'`, [parseInt(b.id, 10)]);
        return send(res, 200, { ok: true });
      }
      case 'osen_mark': { // after the parcel is created in Osen: save its tracking number
        const r = await query(`UPDATE orders SET courier_status = 'sent', courier_ref = $2, courier_at = now(), updated_at = now() WHERE id = $1 RETURNING *`,
          [parseInt(b.id, 10), clean(b.courier_ref, 60) || null]);
        return send(res, 200, { ok: true, order: r.rows[0] });
      }
      case 'osen_export': { // CSV of the send list; marks them 'exported' (?mark=0 to only preview)
        const r = await osen.exportQueued({ mark: url.searchParams.get('mark') !== '0' });
        res.statusCode = 200;
        res.setHeader('content-type', 'text/csv; charset=utf-8');
        res.setHeader('x-count', String(r.count));
        res.setHeader('content-disposition', `attachment; filename="osen-${todayAlgiers()}.csv"`);
        return res.end(r.csv);
      }

      case 'telegram_chats': {
        const seen = await query(`SELECT value FROM settings WHERE key = 'tg_chats'`).catch(() => ({ rows: [] }));
        return send(res, 200, await telegram.findChats(seen.rows[0] ? seen.rows[0].value : []));
      }

      case 'telegram_test':
        return send(res, 200, await telegram.notify('✅ اختبار: إشعارات الطلبات تعمل'));

      default:
        return send(res, 400, { ok: false, error: 'unknown action' });
    }
  } catch (e) {
    console.error('admin error', action, e.message);
    return send(res, 500, { ok: false, error: e.message });
  }
};
