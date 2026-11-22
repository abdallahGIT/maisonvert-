// GET /api/cron-osen-sync — daily Vercel Cron job: pulls the latest Osen status of sent parcels.
// Fails closed: the call must carry "Authorization: Bearer <CRON_SECRET>" (Vercel Cron sends it
// automatically when the CRON_SECRET env var is set), or the admin key. Without CRON_SECRET,
// only the admin (🔄 sync button) can run it.
const crypto = require('crypto');
const osen = require('../lib/osen');
const { send, isAdmin } = require('../lib/http');

function cronAuthorized(req) {
  const secret = process.env.CRON_SECRET || '';
  if (!secret) return false;
  const a = crypto.createHash('sha256').update('Bearer ' + secret).digest();
  const b = crypto.createHash('sha256').update(String(req.headers.authorization || '')).digest();
  return crypto.timingSafeEqual(a, b);
}

async function handler(req, res) {
  if (!cronAuthorized(req) && !isAdmin(req)) {
    return send(res, 401, { ok: false, error: process.env.CRON_SECRET ? 'unauthorized' : 'CRON_SECRET is not set' });
  }
  const r = await osen.syncTracking().catch((e) => ({ ok: false, error: e.message }));
  send(res, 200, { ok: !!r.ok, checked: r.checked || 0, updated: r.updated || 0, errors: (r.errors || []).length, error: r.error });
}

module.exports = handler;
module.exports.cronAuthorized = cronAuthorized;
