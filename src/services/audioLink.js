'use strict';
// تشخیص می‌دهد یک پیوندِ صوتی، فایلِ مستقیم است یا صفحه‌ی یک سرویسِ میزبان.
// خروجی تعیین می‌کند دانش‌آموز آن را با <audio> بشنود یا در <iframe> ببیند.

const DIRECT_EXT = /\.(mp3|m4a|aac|ogg|oga|opus|wav|weba|webm|flac|mp4)(\?|#|$)/i;

/** سرویس‌هایی که لینکِ صفحه می‌دهند و باید به لینکِembed تبدیل شوند. */
const EMBEDDERS = [
  {
    name: 'youtube',
    test: (u) => /(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com)$/i.test(u.hostname),
    videoId: (u) => {
      if (u.hostname.endsWith('youtu.be')) return u.pathname.slice(1);
      if (u.pathname === '/watch') return u.searchParams.get('v');
      const m = /^\/(embed|shorts|v)\/([^/?#]+)/.exec(u.pathname);
      return m ? m[2] : null;
    },
    embed: (id) => `https://www.youtube-nocookie.com/embed/${id}`,
  },
  {
    name: 'aparat',
    test: (u) => /(^|\.)aparat\.com$/i.test(u.hostname),
    videoId: (u) => (/\/v\/([^/?#]+)/.exec(u.pathname) || [])[1] || null,
    embed: (id) => `https://www.aparat.com/video/video/embed/videohash/${id}/vt/frame`,
  },
];

/**
 * پیوند را تحلیل می‌کند.
 * @returns {{kind:'direct'|'embed'|'page', url:string, host:string}|null}
 *   kind='direct' → فایلِ صوتیِ مستقیم (قابل پخش با <audio>)
 *   kind='embed'  → صفحه‌ی سرویس که لینکِ embed آن ساخته شده (نمایش در <iframe>)
 *   kind='page'   → صفحه‌ای ناشناس که فقط باید در iframe باز شود
 */
function classifyAudioUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  let u;
  try { u = new URL(s); } catch (_) { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;

  for (const e of EMBEDDERS) {
    if (e.test(u)) {
      const vid = e.videoId(u);
      if (vid) return { kind: 'embed', url: e.embed(vid), host: e.name };
      return { kind: 'page', url: u.toString(), host: e.name };
    }
  }
  if (DIRECT_EXT.test(u.pathname)) return { kind: 'direct', url: u.toString(), host: u.hostname };
  return { kind: 'page', url: u.toString(), host: u.hostname };
}

module.exports = { classifyAudioUrl };
