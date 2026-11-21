// GET /api/health — shows whether the database and Telegram are configured (never shows secrets).
const { query, dbUrl } = require('../lib/db');
const { send } = require('../lib/http');
const telegram = require('../lib/telegram');

module.exports = async (req, res) => {
  const out = {
    database_configured: !!dbUrl(),
    admin_password_set: !!process.env.ADMIN_PASSWORD,
    telegram_token_set: !!process.env.TELEGRAM_BOT_TOKEN,
    telegram_chat_set: !!process.env.TELEGRAM_CHAT_ID,
    db_env_names: Object.keys(process.env).filter((n) => /DATABASE|POSTGRES|PG(HOST|USER|DATABASE)/.test(n)),
  };
  try {
    const r = await query('SELECT (SELECT count(*) FROM orders)::int AS orders, (SELECT count(*) FROM leads)::int AS leads');
    out.database_ok = true;
    out.counts = r.rows[0];
  } catch (e) {
    out.database_ok = false;
    out.database_error = String(e.message || e).replace(/postgres(ql)?:\/\/[^\s]+/g, '[url]');
  }
  out.telegram = await telegram.check().catch((e) => ({ error: String(e.message || e) }));
  send(res, 200, out);
};
