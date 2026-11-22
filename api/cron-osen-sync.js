// GET /api/cron-osen-sync — daily Vercel Cron job: pulls the latest Osen status of sent parcels.
// When CRON_SECRET is set in Vercel, Vercel sends it as "Authorization: Bearer <CRON_SECRET>" and it is required.
const osen = require('../lib/osen');
const { send, isAdmin } = require('../lib/http');

module.exports = async (req, res) => {
  const secret = process.env.CRON_SECRET;
  const okCron = secret ? req.headers.authorization === 'Bearer ' + secret : !!req.headers['x-vercel-cron'] || /vercel-cron/i.test(req.headers['user-agent'] || '');
  if (!okCron && !isAdmin(req)) return send(res, 401, { ok: false });
  const r = await osen.syncTracking().catch((e) => ({ ok: false, error: e.message }));
  send(res, 200, { ok: !!r.ok, checked: r.checked || 0, updated: r.updated || 0, errors: (r.errors || []).length, error: r.error });
};
