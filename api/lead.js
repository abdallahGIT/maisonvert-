// POST /api/lead — saves the visitor as a lead as soon as 3+ phone digits are typed.
// Called again (debounced) while they keep typing; the same browser session updates one row.
// Once the phone number is complete (10 digits) a Telegram alert is sent once, with call buttons.
const { query } = require('../lib/db');
const telegram = require('../lib/telegram');
const { send, readBody, clean, digits } = require('../lib/http');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { ok: false });
  const b = await readBody(req);
  const sid = clean(b.sid, 64);
  const phone = digits(b.phone);
  if (!sid || phone.length < 3) return send(res, 400, { ok: false, error: 'phone too short' });
  if (b.website) return send(res, 200, { ok: true }); // honeypot

  let lead;
  try {
    const r = await query(
      `INSERT INTO leads (session_id, phone, name, wilaya, commune, reference)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (session_id) DO UPDATE SET
         phone = EXCLUDED.phone,
         name = COALESCE(NULLIF(EXCLUDED.name,''), leads.name),
         wilaya = COALESCE(NULLIF(EXCLUDED.wilaya,''), leads.wilaya),
         commune = COALESCE(NULLIF(EXCLUDED.commune,''), leads.commune),
         reference = COALESCE(NULLIF(EXCLUDED.reference,''), leads.reference),
         updated_at = now()
       WHERE leads.status <> 'ordered'
       RETURNING id, phone, name, wilaya, commune, status, tg_msgs`,
      [sid, phone, clean(b.name, 80), clean(b.wilaya, 60), clean(b.commune, 80), clean(b.reference, 200)]
    );
    lead = r.rows[0];
  } catch (e) {
    console.error('lead save failed', e.message);
    return send(res, 200, { ok: false }); // never bother the visitor
  }

  // Telegram alert: only for a complete, valid number, only once per lead.
  if (lead && lead.status === 'lead' && /^0[567]\d{8}$/.test(lead.phone)) {
    try {
      if (lead.tg_msgs == null) {
        // claim the alert first so two quick requests don't both send it
        const c = await query(`UPDATE leads SET tg_msgs = '[]'::jsonb WHERE id = $1 AND tg_msgs IS NULL RETURNING id`, [lead.id]);
        if (c.rows[0]) {
          const t = await telegram.notify(telegram.leadMessage(lead), telegram.leadKeyboard(lead.id));
          await query(`UPDATE leads SET tg_msgs = $2 WHERE id = $1`, [lead.id, JSON.stringify(t.messages || [])]);
        }
      } else if (Array.isArray(lead.tg_msgs) && lead.tg_msgs.length) {
        // keep the alert up to date when they add their name / wilaya
        await Promise.allSettled(lead.tg_msgs.map((m) => telegram.call('editMessageText', {
          chat_id: m.chat_id, message_id: m.message_id, text: telegram.leadMessage(lead), parse_mode: 'HTML', ...telegram.leadKeyboard(lead.id),
        })));
      }
    } catch (e) { console.warn('lead telegram failed', e.message); }
  }
  return send(res, 200, { ok: true });
};
