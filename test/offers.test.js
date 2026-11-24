// Offer prices: 1 = 1600, 2 = 2700, 3 = 3500 (defaults, editable in admin)
const test = require('node:test');
const assert = require('node:assert');
const { offerTotal, offers, DEFAULT_SETTINGS } = require('../lib/db');

test('default offers are 1600 / 2700 / 3500', () => {
  assert.deepStrictEqual(offers(DEFAULT_SETTINGS), { 1: 1600, 2: 2700, 3: 3500 });
});

test('admin-edited prices are used; missing offer falls back to n x single price', () => {
  assert.strictEqual(offerTotal({ sell_price: 1800, price_2: 3000, price_3: 4000 }, 2), 3000);
  assert.strictEqual(offerTotal({ sell_price: 1800 }, 3), 5400);
  assert.strictEqual(offerTotal(DEFAULT_SETTINGS, 6), 7000); // admin edit above 3 keeps the 3-pack rate
});
