'use strict';
// Minimal Telegram Bot API client (no SDK dependency).
// The bot token is never logged; error messages are scrubbed of it.
class TelegramClient {
  constructor({ token, timeoutMs = 10000, fetchImpl = globalThis.fetch }) {
    this.token = token;
    this.timeoutMs = timeoutMs;
    this.fetch = fetchImpl;
  }

  get enabled() {
    return Boolean(this.token);
  }

  async call(method, body) {
    if (!this.enabled) throw new Error('telegram_not_configured');
    const res = await this.fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    let json;
    try { json = await res.json(); } catch (_) { json = null; }
    if (!res.ok || !json || json.ok !== true) {
      const desc = json && json.description ? json.description : `http_${res.status}`;
      throw new Error(`telegram ${method} failed: ${String(desc).replaceAll(this.token, '[token]')}`);
    }
    return json.result;
  }

  sendMessage(chatId, text, replyMarkup) {
    return this.call('sendMessage', {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    });
  }

  answerCallbackQuery(callbackQueryId, text) {
    return this.call('answerCallbackQuery', { callback_query_id: callbackQueryId, text: String(text).slice(0, 180), show_alert: false });
  }

  editMessageText(chatId, messageId, text) {
    return this.call('editMessageText', {
      chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML',
      disable_web_page_preview: true,
    });
  }
}

module.exports = { TelegramClient };
