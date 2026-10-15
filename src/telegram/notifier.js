'use strict';
// Turns outbox rows into Telegram messages. Pure formatting + delivery; it
// never writes business state.
const { buildCallbackData } = require('./callbacks');

const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

function formatRegistrationMessage(p) {
  return [
    '<b>درخواست ثبت‌نام جدید</b>',
    `نام: ${esc(p.fullName)}`,
    `نام کاربری: <code>${esc(p.username)}</code>`,
    `پایه: ${esc(p.grade)}`,
    `رشته: ${esc(p.field)}`,
    `زمان ثبت: ${esc(p.submittedAt)}`,
    `شماره درخواست: ${p.requestId}`,
  ].join('\n');
}

function buildAdminDelivery(row, { client, signingKey }) {
  const payload = JSON.parse(row.payload);
  if (!row.recipient || row.recipient === 'UNCONFIGURED') throw new Error('TELEGRAM_ADMIN_CHAT_ID not configured');
  if (payload.kind === 'appeal_new') {
    return client.sendMessage(row.recipient,
      `<b>اعتراض جدید</b>\nشناسه: ${esc(payload.appealId)}\nآزمون: ${esc(payload.examTitle)}\nدر پنل مدیریت بررسی کنید.`);
  }
  if (payload.kind === 'password_help') {
    return client.sendMessage(row.recipient,
      `<b>درخواست کمک برای رمز عبور</b>\nنام کاربری: <code>${esc(payload.username)}</code>\nزمان: ${esc(payload.requestedAt)}\nدر پنل مدیریت می‌توانید کد بازیابی یک‌بارمصرف صادر کنید.`);
  }
  if (payload.kind !== 'registration_new') throw new Error(`unknown kind ${payload.kind}`);
  const keyboard = {
    inline_keyboard: [[
      { text: '✅ تأیید', callback_data: buildCallbackData(signingKey, payload.requestId, 'accept') },
      { text: '❌ رد', callback_data: buildCallbackData(signingKey, payload.requestId, 'reject') },
    ]],
  };
  return client.sendMessage(row.recipient, formatRegistrationMessage(payload), keyboard);
}

module.exports = { formatRegistrationMessage, buildAdminDelivery, esc };
