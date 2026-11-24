// POST /api/order — creates a COD order.
// The database save and the Telegram alert run side by side and independently:
// if one fails, the other still happens, so an order is never lost.
const { query, getSettings, getDeliveryFees, deskAvailable, offerTotal, DEFAULT_SETTINGS } = require('../lib/db');
const telegram = require('../lib/telegram');
const osen = require('../lib/osen');
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
  const qty = Math.min(3, Math.max(1, parseInt(b.qty, 10) || 1)); // offers: 1, 2 or 3 packs
  const deliveryType = b.delivery_type === 'desk' ? 'desk' : 'home';

  const errors = {};
  if (!/^0[567]\d{8}$/.test(phone)) errors.phone = 'رقم الهاتف غير صحيح';
  if (name.length < 2) errors.name = 'الاسم مطلوب';
  if (!w) errors.wilaya = 'اختر الولاية';
  else if (!w.communes.includes(commune)) errors.commune = 'اختر البلدية';
  if (!errors.wilaya && !errors.commune) { // only communes Osen delivers to (skipped if Osen is unreachable)
    const un = await osen.unservedMap({ [code]: w }).catch(() => null);
    if (un && (un[code] || []).includes(commune)) errors.commune = 'التوصيل غير متوفر لهذه البلدية';
  }
  if (Object.keys(errors).length) return send(res, 400, { ok: false, errors });

  // Price comes from the admin price sheet, never from the browser.
  let packs = offerTotal(DEFAULT_SETTINGS, qty); // total for the chosen offer
  let fee = 0;
  let deskUnavailable = false;
  try {
    const [s, fees, desks] = await Promise.all([getSettings(), getDeliveryFees(), deliveryType === 'desk' ? osen.deskMap({ [code]: w }).catch(() => null) : null]);
    packs = offerTotal(s, qty);
    const f = fees[code];
    if (f && (f.home != null || f.desk != null) && deliveryType === 'desk' && !deskAvailable(f, commune, desks ? desks[code] || {} : null)) deskUnavailable = true;
    fee = (f && f[deliveryType]) || 0;
  } catch (_) { /* DB down: use defaults */ }
  if (deskUnavailable) return send(res, 400, { ok: false, errors: { delivery_type: 'التوصيل للمكتب غير متوفر في هذه البلدية، اختر التوصيل للمنزل' } });

  const price = Math.round(packs / qty); // unit price kept for reference; the offer total is exact
  const order = {
    session_id: clean(b.sid, 64) || null, name, phone, wilaya_code: code, wilaya: w.name,
    commune, reference, qty, unit_price: price, delivery_type: deliveryType, delivery_fee: fee, total: packs + fee, ip: clientIp(req),
  };

  // 1) Save to DB (with a duplicate guard: same phone within 15 minutes = same order)
  const dbTask = (async () => {
    const dup = await query(
      `SELECT id FROM orders WHERE phone = $1 AND created_at > now() - interval '15 minutes' ORDER BY id DESC LIMIT 1`,
      [phone]
    );
    if (dup.rows[0]) return { id: dup.rows[0].id, duplicate: true };
    const r = await query(
      `INSERT INTO orders (session_id, name, phone, wilaya_code, wilaya, commune, reference, qty, unit_price, total, ip, delivery_type, delivery_fee)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
      [order.session_id, name, phone, code, w.name, commune, reference, qty, price, order.total, order.ip, deliveryType, fee]
    );
    const id = r.rows[0].id;
    if (order.session_id) {
      const l = await query(`UPDATE leads SET status = 'ordered', order_id = $2, updated_at = now() WHERE session_id = $1 RETURNING *`, [order.session_id, id])
        .catch(() => null);
      const lead = l && l.rows[0];
      // the lead alert in Telegram now says the visitor completed the order (no more call buttons)
      if (lead && Array.isArray(lead.tg_msgs)) {
        await Promise.allSettled(lead.tg_msgs.map((m) => telegram.call('editMessageText', {
          chat_id: m.chat_id, message_id: m.message_id, parse_mode: 'HTML',
          text: telegram.leadMessage(lead, 'ordered') + ` — طلب #${id}`,
        })));
      }
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
  return send(res, 200, { ok: true, id: dbOk ? dbRes.value.id : null, total: order.total, delivery_fee: fee });
};
