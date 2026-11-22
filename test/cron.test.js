// Offline tests for the cron endpoint's access check.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

require.cache[path.resolve(__dirname, '../lib/db.js')] = { id: 'db', filename: 'db', loaded: true, exports: { query: async () => ({ rows: [] }) } };
const { cronAuthorized } = require('../api/cron-osen-sync');

test('cron fails closed without CRON_SECRET, even with Vercel cron headers', () => {
  delete process.env.CRON_SECRET;
  assert.strictEqual(cronAuthorized({ headers: { 'x-vercel-cron': '1', 'user-agent': 'vercel-cron/1.0' } }), false);
  assert.strictEqual(cronAuthorized({ headers: { authorization: 'Bearer ' } }), false);
});

test('cron requires the exact Bearer CRON_SECRET', () => {
  process.env.CRON_SECRET = 'test-cron-secret';
  assert.strictEqual(cronAuthorized({ headers: { authorization: 'Bearer test-cron-secret' } }), true);
  assert.strictEqual(cronAuthorized({ headers: { authorization: 'Bearer wrong' } }), false);
  assert.strictEqual(cronAuthorized({ headers: { 'user-agent': 'vercel-cron/1.0' } }), false);
  delete process.env.CRON_SECRET;
});
