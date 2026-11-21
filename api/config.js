// GET /api/config — public price for the landing page (from the admin price sheet).
const { getSettings, DEFAULT_SETTINGS } = require('../lib/db');
const { send } = require('../lib/http');

module.exports = async (req, res) => {
  let price = DEFAULT_SETTINGS.sell_price;
  try { price = (await getSettings()).sell_price || price; } catch (_) {}
  res.setHeader('cache-control', 'public, max-age=60');
  send(res, 200, { price });
};
