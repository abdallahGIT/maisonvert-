// POST /api/order — creates a COD order.
// The database save and the Telegram alert run side by side and independently:
// if one fails, the other still happens, so an order is never lost.
const { query, getSettings, DEFAULT_SETTINGS } = require('../lib/db');
const telegram = require('../lib/telegram');
const { send, readBody, clean, digits, clientIp } = require('../lib/http');
const COMMUNES = require('../lib/communes.json');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { ok: false });
  const b = await readBody(req);
  if (b.website) return send(res, 200, { ok: true, id: 0 }); // honeypot for bots

  const phone = digits(b.phone);
  const name = clean(b.name, 80);
  const code = String(b.wilaya_code || '').padStart(2, '0');
  const w = COMMUNES[code];
  const commune = clean(b.commune, 80);
  const reference = clean(b.reference, 200);
  const qty = Math.min(10, Math.max(1, parseInt(b.qty, 10) || 1));

  const errors = {};
  if (!/^0[567]\d{8}$/.test(phone)) errors.phone = 'رقم الهاتف غير صحيح';
  if (name.length < 2) errors.name = 'الاسم مطلوب';
  if (!w) errors.wilaya = 'اختر الولاية';
  else if (!w.communes.includes(commune)) errors.commune = 'اختر البلدية';
  if (Object.keys(errors).length) return send(res, 400, { ok: false, errors });

  // Price comes from the admin price sheet, never from the browser.
  let price = DEFAULT_SETTINGS.sell_price;
  try { price = (await getSettings()).sell_price || price; } catch (_) { /* DB down: use default */ }

  const order = {
    session_id: clean(b.sid, 64) || null, name, phone, wilaya_code: code, wilaya: w.name,
    commune, reference, qty, unit_price: price, total: price * qty, ip: clientIp(req),
  };

  // 1) Save to DB (with a duplicate guard: same phone within 15 minutes = same order)
  const dbTask = (async () => {
    const dup = await query(
      `SELECT id FROM orders WHERE phone = $1 AND created_at > now() - interval '15 minutes' ORDER BY id DESC LIMIT 1`,
      [phone]
    );
    if (dup.rows[0]) return { id: dup.rows[0].id, duplicate: true };
    const r = await query(
      `INSERT INTO orders (session_id, name, phone, wilaya_code, wilaya, commune, reference, qty, unit_price, total, ip)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [order.session_id, name, phone, code, w.name, commune, reference, qty, price, order.total, order.ip]
    );
    const id = r.rows[0].id;
    if (order.session_id) {
      await query(`UPDATE leads SET status = 'ordered', order_id = $2, updated_at = now() WHERE session_id = $1`, [order.session_id, id])
        .catch(() => {});
    }
    return { id, duplicate: false };
  })();

  // 2) Telegram — waits for the DB result at most 3s so it can include the order number, then sends anyway.
  const tgTask = (async () => {
    const db = await Promise.race([dbTask.then((v) => v, () => null), new Promise((r) => setTimeout(() => r(undefined), 3000))]);
    if (db && db.duplicate) return { ok: true, skipped: true };
    const id = db && db.id;
    return telegram.notify(telegram.orderMessage({ ...order, id }, db !== null), id ? telegram.orderKeyboard(id) : undefined);
  })();

  const [dbRes, tgRes] = await Promise.allSettled([dbTask, tgTask]);
  if (dbRes.status === 'rejected') console.error('order DB save failed', dbRes.reason && dbRes.reason.message);
  if (tgRes.status === 'fulfilled' && !tgRes.value.ok) console.warn('telegram failed', tgRes.value.errors);

  const dbOk = dbRes.status === 'fulfilled';
  const tgOk = tgRes.status === 'fulfilled' && tgRes.value.ok;
  if (!dbOk && !tgOk) return send(res, 500, { ok: false, error: 'تعذر إرسال الطلب، حاول مرة أخرى' });
  return send(res, 200, { ok: true, id: dbOk ? dbRes.value.id : null, total: order.total });
};
