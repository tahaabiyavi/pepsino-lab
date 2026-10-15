'use strict';
/* pepsino LAB — مجموعه آیکون inline (SVG)
   هیچ وابستگی خارجی و هیچ فونت آیکونی ندارد؛ همه‌چیز داخل فایل است تا
   آیکون‌ها آفلاین و بدون CDN هم درست نمایش داده شوند.
   سبک: خطی (stroke)، گِرد، سازگار با پالتِ سایت. */

const ICON_STROKE = 'currentColor';

/* هر آیکون یک تابع است که مسیرهای SVG را برمی‌گرداند (viewBox 24×24) */
const ICON_PATHS = {
  home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5.5 9.5V20h13V9.5"/><path d="M9.5 20v-5.5h5V20"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M8 3v4M16 3v4M3 10.5h18"/><path d="M8 15h3M13 15h3"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  trophy: '<path d="M8 4h8v5a4 4 0 0 1-8 0V4Z"/><path d="M8 5H5.5V7a3 3 0 0 0 3 3M16 5h2.5V7a3 3 0 0 1-3 3"/><path d="M12 13v3"/><path d="M9 20h6"/><path d="M10 16h4l.5 4h-5l.5-4Z"/>',
  book: '<path d="M4 5.5A2 2 0 0 1 6 4h13v13H6a2 2 0 0 0-2 2V5.5Z"/><path d="M4 19a2 2 0 0 0 2 2h13V4"/><path d="M8.5 8.5h7M8.5 12h5"/>',
  exam: '<path d="M6 3h8l5 5v13H6z"/><path d="M14 3v5h5"/><path d="M9.5 13.5h5M9.5 17h3"/>',
  practice: '<path d="M4 9v6M20 9v6M7 6v12M17 6v12M7 12h10"/>',
  bell: '<path d="M6.5 9a5.5 5.5 0 0 1 11 0c0 4 1.5 5.5 1.5 5.5H5S6.5 13 6.5 9Z"/><path d="M10 18a2 2 0 0 0 4 0"/>',
  logout: '<path d="M15 4h3.5A1.5 1.5 0 0 1 20 5.5v13A1.5 1.5 0 0 1 18.5 20H15"/><path d="M10 8l-4 4 4 4"/><path d="M6 12h9"/>',
  print: '<path d="M7 8V3h10v5"/><path d="M7 17H5a1 1 0 0 1-1-1v-5a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-2"/><path d="M7 14h10v7H7z"/>',
  chevron: '<path d="M9 6l6 6-6 6"/>',
  check: '<path d="M4.5 12.5l5 5 10-11"/>',
  lock: '<rect x="4.5" y="10.5" width="15" height="10" rx="3"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/>',
  unlock: '<rect x="4.5" y="10.5" width="15" height="10" rx="3"/><path d="M8 10.5V8a4 4 0 0 1 7.5-1.8"/>',
  expired: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3.5 2"/><path d="M4.5 19.5 19.5 4.5"/>',
  download: '<path d="M12 4v11"/><path d="M7.5 10.5 12 15l4.5-4.5"/><path d="M4.5 19.5h15"/>',
  zoom: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/><path d="M11 8.5v5M8.5 11h5"/>',
  star: '<path d="M12 3.5l2.7 5.5 6 .9-4.3 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1L3.3 9.9l6-.9L12 3.5Z"/>',
  users: '<circle cx="9" cy="8" r="3.2"/><path d="M3.5 19.5a5.5 5.5 0 0 1 11 0"/><path d="M16 5.5a3 3 0 0 1 0 5.9"/><path d="M17 14.4a5.5 5.5 0 0 1 3.5 5.1"/>',
  target: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r="1"/>',
  medal: '<circle cx="12" cy="14.5" r="5.5"/><path d="M9 9L6.5 3h11L15 9"/>',
  refresh: '<path d="M20 12a8 8 0 1 1-2.6-5.9"/><path d="M20 4v4.5h-4.5"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5"/><path d="M12 7.8v.6"/>',
  play: '<path d="M7.5 4.8 19 12 7.5 19.2V4.8Z"/>',
  file: '<path d="M6 3h8l5 5v13H6z"/><path d="M14 3v5h5"/>',
  arrowLeft: '<path d="M19 12H5"/><path d="M11 6l-6 6 6 6"/>',
  grid: '<rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/>',
};

/**
 * یک آیکون SVG را برمی‌گرداند.
 * icon(name, { size = 20, cls = '', stroke = 2.2, fill = 'none' })
 */
function icon(name, opts = {}) {
  const { size = 20, cls = '', stroke = 2.2, title = '' } = opts;
  const paths = ICON_PATHS[name];
  if (!paths) return '';
  return `<svg class="ico ${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none"
    stroke="${ICON_STROKE}" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round"
    aria-hidden="${title ? 'false' : 'true'}"${title ? ` role="img" aria-label="${esc(title)}"` : ''}>${paths}</svg>`;
}

/** نام‌های موجود (برای ساخت خودکار فرم‌ها در پنل ادمین). */
const ICON_NAMES = Object.keys(ICON_PATHS);

/* در مرورگر در دسترسِ سراسری است؛ در تست‌های Node تعریف نمی‌شود. */
if (typeof window !== 'undefined') {
  window.icon = icon;
  window.ICON_NAMES = ICON_NAMES;
}
