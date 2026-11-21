const crypto = require('crypto');

function send(res, status, data) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  if (!res.getHeader('cache-control')) res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(data));
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch { return {}; } }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { return {}; }
}

function isAdmin(req) {
  const want = process.env.ADMIN_PASSWORD || '';
  const got = String(req.headers['x-admin-key'] || '');
  if (!want || !got) return false;
  const a = crypto.createHash('sha256').update(want).digest();
  const b = crypto.createHash('sha256').update(got).digest();
  return crypto.timingSafeEqual(a, b);
}

const clean = (v, max = 200) => String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);
const digits = (v) => String(v == null ? '' : v).replace(/\D/g, '').slice(0, 10);

function clientIp(req) {
  return clean(String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0], 60);
}

module.exports = { send, readBody, isAdmin, clean, digits, clientIp };
