// /api/telegram — Telegram webhook for the order buttons (confirm / cancel / no answer / shipped).
//   POST: called by Telegram when a button is pressed or someone writes /start or /id to the bot.
//   GET : (re)registers this webhook with Telegram and shows its status.
const { query } = require('../lib/db');
const telegram = require('../lib/telegram');
const osen = require('../lib/osen');
const { send, readBody } = require('../lib/http');

const ALLOWED = ['confirmed', 'cancelled', 'no_answer', 'shipped', 'delivered', 'returned'];

function baseUrl(req) {
  const prod = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  const host = prod || req.headers['x-forwarded-host'] || req.headers.host;
  return 'https://' + String(host).replace(/^https?:\/\//, '').replace(/\/.*$/, '');
}

async function ensureWebhook(req) {
  const url = baseUrl(req) + '/api/telegram';
  const info = await telegram.call('getWebhookInfo', {});
  if (info.ok && info.result.url === url) return { ok: true, url, already: true, pending: info.result.pending_update_count, last_error: info.result.last_error_message };
  const r = await telegram.call('setWebhook', { url, secret_token: telegram.webhookSecret(), allowed_updates: ['callback_query', 'message'], drop_pending_updates: false });
  return { ok: !!r.ok, url, error: r.ok ? undefined : (r.description || r.error) };
}

async function rememberChat(chat) {
  try {
    const r = await query(`SELECT value FROM settings WHERE key = 'tg_chats'`);
    const list = (r.rows[0] && r.rows[0].value) || [];
    if (!list.find((c) => String(c.id) === String(chat.id))) {
      list.push({ id: chat.id, title: chat.title || [chat.first_name, chat.last_name].filter(Boolean).join(' ') || chat.username, type: chat.type });
      await query(`INSERT INTO settings (key, value) VALUES ('tg_chats', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify(list.slice(-20))]);
    }
  } catch (_) { /* not important */ }
}

async function handleButton(cb) {
  const msg = cb.message || {};
  const chatId = msg.chat && msg.chat.id;
  const { chats } = telegram.config();
  if (!chats.map(String).includes(String(chatId))) {
    return telegram.call('answerCallbackQuery', { callback_query_id: cb.id, text: 'غير مسموح', show_alert: true });
  }
  const who = [cb.from && cb.from.first_name, cb.from && cb.from.last_name].filter(Boolean).join(' ');
  const time = new Date().toLocaleTimeString('fr-DZ', { timeZone: 'Africa/Algiers', hour: '2-digit', minute: '2-digit' });
  const data = cb.data || '';
  if (data.startsWith('ld:')) return handleLeadButton(cb, chatId, msg, who, time);
  if (data.startsWith('os:')) return handleOsenButton(cb, chatId, msg, who, time);

  const m = /^st:(\d+):([a-z_]+)$/.exec(data);
  if (!m || !ALLOWED.includes(m[2])) return telegram.call('answerCallbackQuery', { callback_query_id: cb.id });
  const id = parseInt(m[1], 10);
  const status = m[2];

  let order;
  try {
    const r = await query(
      `UPDATE orders SET status = $2, updated_at = now(),
         confirmed_at = CASE WHEN $2 = 'confirmed' THEN COALESCE(confirmed_at, now()) ELSE confirmed_at END
       WHERE id = $1 RETURNING *`,
      [id, status]
    );
    order = r.rows[0];
  } catch (e) {
    return telegram.call('answerCallbackQuery', { callback_query_id: cb.id, text: 'خطأ في قاعدة البيانات، حاول مرة أخرى', show_alert: true });
  }
  if (!order) return telegram.call('answerCallbackQuery', { callback_query_id: cb.id, text: 'الطلب غير موجود', show_alert: true });

  const text = telegram.orderMessage(order, true).replace('طلب جديد', 'طلب') +
    `\n\n<b>الحالة: ${telegram.STATUS_LABEL[status]}</b>\n<i>${telegram.esc(who)} — ${time}</i>`;

  await Promise.allSettled([
    telegram.call('answerCallbackQuery', { callback_query_id: cb.id, text: `طلب #${id}: ${telegram.STATUS_LABEL[status]}` }),
    telegram.call('editMessageText', { chat_id: chatId, message_id: msg.message_id, text, parse_mode: 'HTML', ...telegram.orderKeyboard(id) }),
  ]);
}

const LEAD_ALLOWED = ['called', 'no_answer', 'not_interested'];

async function handleLeadButton(cb, chatId, msg, who, time) {
  const m = /^ld:(\d+):([a-z_]+)$/.exec(cb.data);
  if (!m || !LEAD_ALLOWED.includes(m[2])) return telegram.call('answerCallbackQuery', { callback_query_id: cb.id });
  const id = parseInt(m[1], 10);
  let lead;
  try {
    const r = await query(`UPDATE leads SET status = $2, updated_at = now() WHERE id = $1 AND status <> 'ordered' RETURNING *`, [id, m[2]]);
    lead = r.rows[0];
    if (!lead) {
      const x = await query(`SELECT * FROM leads WHERE id = $1`, [id]);
      if (x.rows[0] && x.rows[0].status === 'ordered') {
        return telegram.call('answerCallbackQuery', { callback_query_id: cb.id, text: 'هذا الزبون أكمل الطلب بالفعل ✅', show_alert: true });
      }
      return telegram.call('answerCallbackQuery', { callback_query_id: cb.id, text: 'Lead غير موجود', show_alert: true });
    }
  } catch (e) {
    return telegram.call('answerCallbackQuery', { callback_query_id: cb.id, text: 'خطأ في قاعدة البيانات، حاول مرة أخرى', show_alert: true });
  }
  const label = telegram.LEAD_LABEL[m[2]];
  await Promise.allSettled([
    telegram.call('answerCallbackQuery', { callback_query_id: cb.id, text: `Lead #${id}: ${label}` }),
    telegram.call('editMessageText', {
      chat_id: chatId, message_id: msg.message_id, parse_mode: 'HTML',
      text: telegram.leadMessage(lead, m[2]) + `\n<i>${telegram.esc(who)} — ${time}</i>`, ...telegram.leadKeyboard(id),
    }),
  ]);
}

// "📤 إرسال إلى Osen": puts the order in the Osen send list (admin → الطلبات → Osen).
async function handleOsenButton(cb, chatId, msg, who, time) {
  const m = /^os:(\d+)$/.exec(cb.data);
  if (!m) return telegram.call('answerCallbackQuery', { callback_query_id: cb.id });
  const id = parseInt(m[1], 10);
  let r;
  try {
    r = await osen.queueOrders([id]);
  } catch (e) {
    return telegram.call('answerCallbackQuery', { callback_query_id: cb.id, text: 'خطأ في قاعدة البيانات، حاول مرة أخرى', show_alert: true });
  }
  const order = r.orders[0];
  if (!order) return telegram.call('answerCallbackQuery', { callback_query_id: cb.id, text: 'الطلب غير موجود أو ملغى', show_alert: true });
  const text = telegram.orderMessage(order, true).replace('طلب جديد', 'طلب') +
    `\n\n<b>الحالة: ${telegram.STATUS_LABEL[order.status] || order.status}</b>\n<i>${telegram.esc(who)} — ${time}</i>`;
  await Promise.allSettled([
    telegram.call('answerCallbackQuery', { callback_query_id: cb.id, show_alert: true, text: r.message }),
    telegram.call('editMessageText', { chat_id: chatId, message_id: msg.message_id, text, parse_mode: 'HTML', ...telegram.orderKeyboard(id) }),
  ]);
}

async function handleMessage(msg) {
  const chat = msg.chat;
  if (!chat) return;
  const text = String(msg.text || '');
  if (!/^\/(start|id)(@\w+)?\b/.test(text)) return; // ignore normal group chatter
  await rememberChat(chat);
  await telegram.call('sendMessage', {
    chat_id: chat.id,
    text: `Chat ID: <code>${chat.id}</code>\nضع هذا الرقم في TELEGRAM_CHAT_ID على Vercel لتصلك الطلبات هنا.`,
    parse_mode: 'HTML',
  });
}

module.exports = async (req, res) => {
  if (req.method === 'GET') {
    const r = await ensureWebhook(req).catch((e) => ({ ok: false, error: e.message }));
    return send(res, 200, r);
  }
  if (req.headers['x-telegram-bot-api-secret-token'] !== telegram.webhookSecret() || !telegram.webhookSecret()) {
    return send(res, 401, { ok: false });
  }
  const update = await readBody(req);
  try {
    if (update.callback_query) await handleButton(update.callback_query);
    else if (update.message) await handleMessage(update.message);
  } catch (e) {
    console.error('telegram webhook error', e.message);
  }
  return send(res, 200, { ok: true }); // always 200 so Telegram doesn't retry forever
};

module.exports.ensureWebhook = ensureWebhook;
