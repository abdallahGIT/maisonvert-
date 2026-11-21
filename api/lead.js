// POST /api/lead — saves the visitor as a lead as soon as 3+ phone digits are typed.
// Called again (debounced) while they keep typing; the same browser session updates one row.
const { query } = require('../lib/db');
const { send, readBody, clean, digits } = require('../lib/http');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { ok: false });
  const b = await readBody(req);
  const sid = clean(b.sid, 64);
  const phone = digits(b.phone);
  if (!sid || phone.length < 3) return send(res, 400, { ok: false, error: 'phone too short' });
  if (b.website) return send(res, 200, { ok: true }); // honeypot

  try {
    await query(
      `INSERT INTO leads (session_id, phone, name, wilaya, commune, reference)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (session_id) DO UPDATE SET
         phone = EXCLUDED.phone,
         name = COALESCE(NULLIF(EXCLUDED.name,''), leads.name),
         wilaya = COALESCE(NULLIF(EXCLUDED.wilaya,''), leads.wilaya),
         commune = COALESCE(NULLIF(EXCLUDED.commune,''), leads.commune),
         reference = COALESCE(NULLIF(EXCLUDED.reference,''), leads.reference),
         updated_at = now()
       WHERE leads.status <> 'ordered'`,
      [sid, phone, clean(b.name, 80), clean(b.wilaya, 60), clean(b.commune, 80), clean(b.reference, 200)]
    );
    return send(res, 200, { ok: true });
  } catch (e) {
    console.error('lead save failed', e.message);
    return send(res, 200, { ok: false }); // never bother the visitor
  }
};
