// Telegram notifications — completely separate from the database.
// It never throws: if Telegram is down or not configured, orders still save.
const TIMEOUT_MS = 4000;

function config() {
  const token = process.env.TELEGRAM_BOT_TOKEN || '';
  const chats = (process.env.TELEGRAM_CHAT_ID || '').split(',').map((s) => s.trim()).filter(Boolean);
  return { token, chats };
}

async function call(method, payload) {
  const { token } = config();
  if (!token) return { ok: false, error: 'TELEGRAM_BOT_TOKEN not set' };
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload || {}),
      signal: ctrl.signal,
    });
    return await r.json();
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  } finally {
    clearTimeout(t);
  }
}

// Send a message to every configured chat. Resolves to { ok, sent, errors }.
async function notify(text) {
  const { token, chats } = config();
  if (!token || !chats.length) return { ok: false, sent: 0, errors: ['Telegram not configured'] };
  const results = await Promise.allSettled(
    chats.map((chat_id) => call('sendMessage', { chat_id, text, parse_mode: 'HTML', disable_web_page_preview: true }))
  );
  const errors = [];
  let sent = 0;
  results.forEach((r) => {
    if (r.status === 'fulfilled' && r.value && r.value.ok) sent++;
    else errors.push(r.status === 'fulfilled' ? (r.value && (r.value.description || r.value.error)) : String(r.reason));
  });
  return { ok: sent > 0, sent, errors };
}

// Lists chats that wrote to the bot (send /start to the bot first). Used by the admin page to find your chat id.
async function findChats() {
  const r = await call('getUpdates', {});
  if (!r.ok) return { ok: false, error: r.description || r.error };
  const seen = new Map();
  for (const u of r.result || []) {
    const m = u.message || u.channel_post || u.my_chat_member || {};
    const c = m.chat;
    if (c && !seen.has(c.id)) seen.set(c.id, { id: c.id, title: c.title || [c.first_name, c.last_name].filter(Boolean).join(' ') || c.username, type: c.type });
  }
  return { ok: true, chats: [...seen.values()] };
}

const esc = (s) => String(s == null ? '' : s).replace(/[&<>]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch]));

function orderMessage(o, savedInDb) {
  return [
    `🍅 <b>طلب جديد${o.id ? ' #' + o.id : ''}</b>`,
    `👤 ${esc(o.name)}`,
    `📞 <code>${esc(o.phone)}</code>`,
    `📍 ${esc(o.wilaya_code)} - ${esc(o.wilaya)} / ${esc(o.commune)}`,
    o.reference ? `🏠 ${esc(o.reference)}` : null,
    `📦 الكمية: ${o.qty} — المجموع: ${o.total} دج`,
    savedInDb ? null : '⚠️ لم يُحفظ في قاعدة البيانات — احفظه يدوياً',
  ].filter(Boolean).join('\n');
}

module.exports = { notify, findChats, orderMessage };
