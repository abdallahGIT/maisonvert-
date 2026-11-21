// GET /api/config — public price for the landing page (from the admin price sheet).
const { getSettings, getDeliveryFees, DEFAULT_SETTINGS } = require('../lib/db');
const { send } = require('../lib/http');

module.exports = async (req, res) => {
  let price = DEFAULT_SETTINGS.sell_price;
  let fees = {};
  try {
    const [s, f] = await Promise.all([getSettings(), getDeliveryFees()]);
    price = s.sell_price || price;
    fees = f;
  } catch (_) {}
  res.setHeader('cache-control', 'public, max-age=60');
  send(res, 200, { price, fees });
};
