// Offline tests for the Osen client: no network, no real credentials.
// Run: npm test
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

process.env.ADMIN_PASSWORD = 'test-admin-password';
delete process.env.OSEN_API_KEY;

// In-memory stand-in for the settings table
const store = {};
require.cache[path.resolve(__dirname, '../lib/db.js')] = {
  id: 'db', filename: 'db', loaded: true,
  exports: {
    query: async (sql, params) => {
      if (/SELECT value FROM settings WHERE key = 'osen'/.test(sql)) return { rows: store.osen ? [{ value: store.osen }] : [] };
      if (/INSERT INTO settings/.test(sql)) { store.osen = JSON.parse(params[0]); return { rows: [] }; }
      if (/UPDATE orders/.test(sql)) return { rows: [{ id: params[0], courier_status: 'sent', courier_ref: params[1] }] };
      throw new Error('unexpected query ' + sql);
    },
  },
};
const osen = require('../lib/osen');

const calls = [];
global.fetch = async (url, opts = {}) => {
  calls.push({ url, opts });
  if (url.endsWith('/geo/provinces')) {
    return { ok: true, status: 200, json: async () => [{ id: 16, code: '16', municipalities: [{ id: 562, name_arabic: 'ابن عكنون', servingStopdesk: { name: 'Bureau Alger 16B' } }] }] };
  }
  if (url.endsWith('/v2/ecomanager/orders')) {
    return { ok: true, status: 200, json: async () => [{ index: 0, success: true, tracking: 'OS-TEST-1' }] };
  }
  return { ok: false, status: 404, json: async () => ({}) };
};

test('token entered in admin is stored encrypted and never returned', async () => {
  const ids = await osen.saveIds({ merchant_id: 'm-1', store_id: 's-1', api_token: 'secret-token-123' });
  assert.equal(ids.token_saved, true);
  assert.ok(!JSON.stringify(ids).includes('secret-token-123'));
  assert.ok(store.osen.token_enc && !store.osen.token_enc.includes('secret-token-123'));
  assert.equal(await osen.apiConfigured(), true);
});

test('saving without a token keeps the saved one; clear_token removes it', async () => {
  await osen.saveIds({ merchant_id: 'm-1', store_id: 's-1' });
  assert.equal((await osen.getIds()).token_saved, true);
  await osen.saveIds({ merchant_id: 'm-1', store_id: 's-1', clear_token: true });
  assert.equal(await osen.apiConfigured(), false);
});

test('create parcel uses the official v2 contract and headers', async () => {
  await osen.saveIds({ merchant_id: 'm-1', store_id: 's-1', api_token: 'secret-token-123' });
  calls.length = 0;
  const r = await osen.createParcel({ id: 7, name: 'Ali', phone: '0551234567', wilaya_code: '16', commune: 'ابن عكنون', reference: 'near school', delivery_type: 'desk', total: 1900, unit_price: 1600, qty: 1 });
  assert.equal(r.tracking, 'OS-TEST-1');
  const c = calls.find((x) => x.url.endsWith('/v2/ecomanager/orders'));
  assert.equal(c.opts.method, 'POST');
  assert.equal(c.opts.headers['x-api-id'], 'm-1');
  assert.equal(c.opts.headers['x-api-token'], 'secret-token-123');
  const body = JSON.parse(c.opts.body);
  assert.ok(Array.isArray(body) && body.length === 1);
  assert.deepEqual(
    { order_id: body[0].order_id, wilaya_id: body[0].wilaya_id, commune_id: body[0].commune_id, is_stopdesk: body[0].is_stopdesk, cod_amount: body[0].cod_amount },
    { order_id: 'CMD-7', wilaya_id: '16', commune_id: '562', is_stopdesk: true, cod_amount: 1900 }
  );
});
