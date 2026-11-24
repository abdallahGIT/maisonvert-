// GET /api/config — public price for the landing page (from the admin price sheet).
const { getSettings, getDeliveryFees, offers, DEFAULT_SETTINGS } = require('../lib/db');
const { send } = require('../lib/http');
const osen = require('../lib/osen');
const COMMUNES = require('../lib/communes.json');

module.exports = async (req, res) => {
  let price = DEFAULT_SETTINGS.sell_price;
  let offerPrices = offers(DEFAULT_SETTINGS); // {1: total, 2: total, 3: total}
  let fees = {};
  let desks = null; // communes served by an Osen stop desk: {code: {commune: deskName}}
  const [a, b] = await Promise.allSettled([Promise.all([getSettings(), getDeliveryFees()]), osen.deskMap(COMMUNES)]);
  if (a.status === 'fulfilled') { price = a.value[0].sell_price || price; offerPrices = offers(a.value[0]); fees = a.value[1]; }
  if (b.status === 'fulfilled') desks = b.value;
  res.setHeader('cache-control', 'public, max-age=60');
  send(res, 200, { price, offers: offerPrices, fees, desks });
};
