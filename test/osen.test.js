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
      if (/SELECT id, status, courier_ref, courier_state FROM orders/.test(sql)) return { rows: store.sentOrders || [] };
      if (/UPDATE orders SET courier_state = /.test(sql)) { (store.updates = store.updates || []).push(params); return { rows: [] }; }
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
    const body = JSON.parse(opts.body);
    if (!Array.isArray(body)) { // object form = read statuses by tracking
      return { ok: true, status: 200, json: async () => body.trackings.map((t) => ({ tracking: t, is_return: false,
        last_status: { code: t === 'T-DEL' ? 'DELIVERED' : 'OUT_FOR_DELIVERY', label: t === 'T-DEL' ? 'Livré' : 'En cours de livraison', date: '2026-11-22T09:00:00Z' } })) };
    }
    if (opts.headers && opts.headers['x-api-token'] === 'rejected-token') return { ok: false, status: 401, json: async () => ({ message: 'Invalid or expired token' }) };
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

test('status mapping only moves the shop status for clear cases', () => {
  assert.equal(osen.shopStatus('confirmed', 'OUT_FOR_DELIVERY'), 'shipped');
  assert.equal(osen.shopStatus('shipped', 'DELIVERED'), 'delivered');
  assert.equal(osen.shopStatus('shipped', 'RETURNED'), 'returned');
  assert.equal(osen.shopStatus('delivered', 'IN_TRANSIT'), 'delivered');
  assert.equal(osen.shopStatus('shipped', 'SOME_NEW_CODE'), 'shipped');
});

test('sync reads statuses with the object form and saves raw + mapped status', async () => {
  await osen.saveIds({ merchant_id: 'm-1', store_id: 's-1', api_token: 'secret-token-123' });
  store.sentOrders = [{ id: 1, status: 'confirmed', courier_ref: 'T-OFD', courier_state: null }, { id: 2, status: 'shipped', courier_ref: 'T-DEL', courier_state: null }];
  store.updates = [];
  calls.length = 0;
  const r = await osen.syncTracking();
  assert.equal(r.checked, 2);
  assert.equal(r.updated, 2);
  const c = calls.find((x) => x.url.endsWith('/v2/ecomanager/orders'));
  assert.deepEqual(JSON.parse(c.opts.body), { trackings: ['T-OFD', 'T-DEL'] });
  assert.deepEqual(store.updates.map((u) => [u[0], u[1], u[4]]), [[1, 'OUT_FOR_DELIVERY', 'shipped'], [2, 'DELIVERED', 'delivered']]);
});

test('a rejected token points to the admin Osen tab, not a Vercel variable', async () => {
  await osen.saveIds({ merchant_id: 'm-1', store_id: 's-1', api_token: 'rejected-token' });
  await assert.rejects(
    osen.createParcel({ id: 8, name: 'Ali', phone: '0551234567', wilaya_code: '16', commune: 'ابن عكنون', delivery_type: 'home', total: 1900 }),
    (e) => /تبويب Osen/.test(e.message) && !/OSEN_API_KEY/.test(e.message) && !e.message.includes('rejected-token')
  );
});
