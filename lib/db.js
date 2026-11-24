// Postgres access (works with Neon, Supabase, or any Postgres).
// Tables are created automatically on first use — no migration step needed.
const { Pool } = require('pg');

let pool;

// Vercel's Neon / Supabase integrations use different variable names (sometimes with a prefix).
function dbUrl() {
  const env = process.env;
  const names = ['DATABASE_URL', 'POSTGRES_URL', 'DATABASE_URL_UNPOOLED', 'POSTGRES_URL_NON_POOLING', 'POSTGRES_PRISMA_URL', 'NEON_DATABASE_URL'];
  for (const n of names) if (env[n]) return env[n];
  const k = Object.keys(env).find((n) => /(_|^)(DATABASE_URL|POSTGRES_URL)$/.test(n) && env[n]);
  return k ? env[k] : '';
}
let ready;

function getPool() {
  if (!pool) {
    const url = dbUrl();
    if (!url) throw new Error('No database connected (DATABASE_URL / POSTGRES_URL not set)');
    const local = /localhost|127\.0\.0\.1/.test(url);
    pool = new Pool({
      connectionString: url,
      ssl: local ? false : { rejectUnauthorized: false },
      max: 3,
      idleTimeoutMillis: 10000,
      connectionTimeoutMillis: 8000,
    });
  }
  return pool;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS leads (
  id          SERIAL PRIMARY KEY,
  session_id  TEXT UNIQUE NOT NULL,
  phone       TEXT NOT NULL,
  name        TEXT,
  wilaya      TEXT,
  commune     TEXT,
  reference   TEXT,
  status      TEXT NOT NULL DEFAULT 'lead',   -- lead | ordered | called | no_answer | not_interested
  order_id    INTEGER,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS leads_created_idx ON leads (created_at);

CREATE TABLE IF NOT EXISTS orders (
  id             SERIAL PRIMARY KEY,
  session_id     TEXT,
  name           TEXT NOT NULL,
  phone          TEXT NOT NULL,
  wilaya_code    TEXT NOT NULL,
  wilaya         TEXT NOT NULL,
  commune        TEXT NOT NULL,
  reference      TEXT,
  qty            INTEGER NOT NULL DEFAULT 1,
  unit_price     INTEGER NOT NULL,
  total          INTEGER NOT NULL,
  status         TEXT NOT NULL DEFAULT 'new', -- new | confirmed | no_answer | cancelled | shipped | delivered | returned
  note           TEXT,
  ip             TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  confirmed_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS orders_created_idx ON orders (created_at);
CREATE INDEX IF NOT EXISTS orders_phone_idx ON orders (phone);

ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_type TEXT NOT NULL DEFAULT 'home'; -- home | desk
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_fee INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS courier_ref TEXT;     -- tracking number from the delivery company
ALTER TABLE orders ADD COLUMN IF NOT EXISTS courier_status TEXT;  -- queued | exported | sent | error
ALTER TABLE orders ADD COLUMN IF NOT EXISTS courier_at TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS courier_error TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS courier_state TEXT;        -- Osen last_status.code (raw)
ALTER TABLE orders ADD COLUMN IF NOT EXISTS courier_state_label TEXT;  -- Osen last_status.label
ALTER TABLE orders ADD COLUMN IF NOT EXISTS courier_state_at TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS courier_synced_at TIMESTAMPTZ;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS tg_msgs JSONB;  -- Telegram messages sent for this lead [{chat_id, message_id}]

CREATE TABLE IF NOT EXISTS settings (
  key    TEXT PRIMARY KEY,
  value  JSONB NOT NULL
);

-- One row per week: ad spend in USD and the dollar rate you bought at.
CREATE TABLE IF NOT EXISTS weekly_ads (
  week_start     DATE PRIMARY KEY,
  ad_spend_usd   NUMERIC(12,2) NOT NULL DEFAULT 0,
  usd_rate       NUMERIC(12,2) NOT NULL DEFAULT 0,
  other_costs    INTEGER NOT NULL DEFAULT 0,
  note           TEXT
);
`;

async function query(text, params) {
  const p = getPool();
  if (!ready) ready = p.query(SCHEMA).catch((e) => { ready = null; throw e; });
  await ready;
  return p.query(text, params);
}

// Default price sheet (editable from the admin page)
const DEFAULT_SETTINGS = {
  sell_price: 1600,     // DA, price of 1 pack shown to the customer
  price_2: 2700,        // DA, offer price for 2 packs (total)
  price_3: 3500,        // DA, offer price for 3 packs (total)
  product_cost: 0,      // DA, your cost per pack (seeds + gift + packaging)
  delivery_cost: 0,     // DA you pay per delivered parcel (0 if the customer pays delivery)
  return_cost: 0,       // DA you lose per returned parcel
  usd_rate: 0,          // default DA per $1 (used when a week has no rate)
};

// Offer prices: total for 1, 2 or 3 packs (DA). More than 3 (admin edits only) keeps the 3-pack rate.
function offerTotal(s, qty) {
  const t = { 1: s.sell_price, 2: s.price_2 || s.sell_price * 2, 3: s.price_3 || s.sell_price * 3 };
  return t[qty] != null ? t[qty] : Math.round((t[3] / 3) * qty);
}
function offers(s) { return { 1: offerTotal(s, 1), 2: offerTotal(s, 2), 3: offerTotal(s, 3) }; }

async function getSettings() {
  const r = await query(`SELECT value FROM settings WHERE key = 'prices'`);
  return { ...DEFAULT_SETTINGS, ...(r.rows[0] ? r.rows[0].value : {}) };
}

async function saveSettings(patch) {
  const cur = await getSettings();
  const next = { ...cur };
  for (const k of Object.keys(DEFAULT_SETTINGS)) {
    if (patch[k] !== undefined && patch[k] !== '') next[k] = Number(patch[k]) || 0;
  }
  await query(
    `INSERT INTO settings (key, value) VALUES ('prices', $1)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [JSON.stringify(next)]
  );
  return next;
}

// Delivery fees per wilaya: { "16": { "home": 500, "desk": 300 }, ... }  (null = not available)
async function getDeliveryFees() {
  const r = await query(`SELECT value FROM settings WHERE key = 'delivery_fees'`);
  return (r.rows[0] && r.rows[0].value) || {};
}

async function saveDeliveryFees(fees) {
  const clean = {};
  const num = (v) => (v === '' || v == null || isNaN(Number(v)) ? null : Math.max(0, Math.round(Number(v))));
  for (const [code, f] of Object.entries(fees || {})) {
    if (!/^\d{2}$/.test(code)) continue;
    const dc = Array.isArray(f && f.desk_communes) ? f.desk_communes.map((s) => String(s).trim().slice(0, 80)).filter(Boolean) : [];
    clean[code] = { home: num(f && f.home), desk: num(f && f.desk), desk_communes: [...new Set(dc)] };
  }
  await query(
    `INSERT INTO settings (key, value) VALUES ('delivery_fees', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [JSON.stringify(clean)]
  );
  return clean;
}

// Is stop-desk delivery available for this wilaya + commune?
// Desk price must be set. If the admin ticked desk communes, the commune must be in that list;
// otherwise Osen's own list of communes served by a stop desk decides (osenDesks = {commune: deskName}).
function deskAvailable(f, commune, osenDesks) {
  if (!f || f.desk == null) return false;
  const list = f.desk_communes || [];
  if (list.length) return list.includes(commune);
  if (osenDesks) return !!osenDesks[commune];
  return true;
}

module.exports = { offerTotal, offers, deskAvailable, dbUrl, query, getSettings, saveSettings, getDeliveryFees, saveDeliveryFees, DEFAULT_SETTINGS };
