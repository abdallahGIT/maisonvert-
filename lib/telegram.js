// Telegram notifications — completely separate from the database.
// It never throws: if Telegram is down or not configured, orders still save.
const TIMEOUT_MS = 4000;

function config() {
  // Accept the raw token, or a pasted URL like https://api.telegram.org/bot<TOKEN>/getUpdates
  const raw = String(process.env.TELEGRAM_BOT_TOKEN || '');
  const m = raw.match(/\d{6,}:[A-Za-z0-9_-]{30,}/);
  const token = m ? m[0] : raw.trim();
  const chats = (process.env.TELEGRAM_CHAT_ID || '').split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
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
async function notify(text, extra) {
  const { token, chats } = config();
  if (!token || !chats.length) return { ok: false, sent: 0, errors: ['Telegram not configured'] };
  const results = await Promise.allSettled(
    chats.map((chat_id) => call('sendMessage', { chat_id, text, parse_mode: 'HTML', disable_web_page_preview: true, ...(extra || {}) }))
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
// When the buttons webhook is active, getUpdates is disabled by Telegram, so we use the chats the webhook has seen.
async function findChats(seenByWebhook) {
  const r = await call('getUpdates', {});
  if (!r.ok) {
    if (seenByWebhook && seenByWebhook.length) return { ok: true, chats: seenByWebhook };
    return { ok: false, error: r.description || r.error };
  }
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

// Checks the token and each chat id without sending anything.
async function check() {
  const { token, chats } = config();
  const me = await call('getMe', {});
  const out = { token_ok: !!me.ok, bot: me.ok ? '@' + me.result.username : undefined, token_error: me.ok ? undefined : (me.description || me.error), token_length: token.length, token_looks_valid: /^\d{6,}:[A-Za-z0-9_-]{30,}$/.test(token), chats: [] };
  for (const chat_id of chats) {
    const c = await call('getChat', { chat_id });
    out.chats.push({ chat_id_length: String(chat_id).length, ok: !!c.ok, type: c.ok ? c.result.type : undefined, error: c.ok ? undefined : (c.description || c.error) });
  }
  return out;
}

// ---- Order buttons ----
const STATUS_LABEL = { new: '🆕 جديد', confirmed: '✅ مؤكد', cancelled: '❌ ملغى', no_answer: '📵 لا يرد', shipped: '🚚 تم الشحن', delivered: '📦 تم التسليم', returned: '↩️ مرتجع' };

function orderKeyboard(id) {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: '✅ تأكيد', callback_data: `st:${id}:confirmed` }, { text: '❌ إلغاء', callback_data: `st:${id}:cancelled` }],
        [{ text: '📵 لا يرد', callback_data: `st:${id}:no_answer` }, { text: '🚚 تم الشحن', callback_data: `st:${id}:shipped` }],
      ],
    },
  };
}

// Secret Telegram sends back with every webhook call, derived from the token (no extra setting needed).
function webhookSecret() {
  const { token } = config();
  return token ? require('crypto').createHash('sha256').update('wh:' + token).digest('hex').slice(0, 48) : '';
}

module.exports = { call, config, check, notify, findChats, orderMessage, orderKeyboard, webhookSecret, STATUS_LABEL, esc };
