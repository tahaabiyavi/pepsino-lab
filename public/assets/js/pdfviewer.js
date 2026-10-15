'use strict';
/**
 * نمایشگر PDFِ توکارِ برنامه — با دکمه‌های «صفحه قبل / بعد»، بزرگ‌نمایی و شمارنده.
 *
 * چرا به‌جای <iframe> از pdf.js استفاده می‌شود:
 *  ۱) مرورگر هنگام چاپ یک صفحه‌ی HTML فقط «بخشِ دیدنیِ» iframe را می‌آورد و
 *     صفحه‌های بعد را چاپ نمی‌کند.
 *  ۲) رفتن به صفحه‌ی بعد در iframe یعنی بارگذاریِ دوباره‌ی کل فایل.
 *  ۳) رفتار iframe در مرورگرهای موبایل یکسان نیست.
 * با pdf.js هر صفحه روی یک canvas رسم می‌شود؛ بنابراین هم پیمایشِ بین صفحه‌ها
 * فوری است و هم می‌توان همه‌ی صفحه‌ها را به‌صورت تصویر در برگه‌ی چاپ گذاشت
 * (هر تصویر دقیقاً یک صفحه).
 *
 * کتابخانه تنها هنگام نیاز بارگذاری می‌شود (dynamic import)، پس کاربرانی که
 * فایلی باز نمی‌کنند هزینه‌اش را پرداخت نمی‌کنند.
 */
window.PdfViewer = (function () {
  const CSS = `
.pv { display:flex; flex-direction:column; gap:10px; }
.pv-bar { display:flex; align-items:center; gap:8px; flex-wrap:wrap;
  background:#FFF8EA; border:1.5px solid var(--line,#EBD9BC); border-radius:12px; padding:8px 10px; }
.pv-bar .pv-spacer { flex:1; }
.pv-btn { min-width:38px; height:34px; padding:0 10px; border:1.5px solid var(--line,#EBD9BC);
  border-radius:10px; background:#FFFDF6; color:var(--ink,#4A2E1E); font-weight:700;
  font-size:14px; cursor:pointer; display:inline-flex; align-items:center; justify-content:center; gap:5px; }
.pv-btn:hover:not(:disabled) { background:#FFF2D9; }
.pv-btn:disabled { opacity:.45; cursor:not-allowed; }
.pv-count { font-size:13.5px; color:var(--ink-2,#7B5A44); font-weight:700; white-space:nowrap; }
.pv-img { display:block; margin:0 auto; height:auto; max-width:none; }
.pv-stage { overflow:auto; max-height:78vh; border:2px solid var(--line,#EBD9BC);
  border-radius:12px; background:#fff; padding:12px; display:flex; justify-content:center; }
.pv-stage canvas { display:block; border-radius:6px; box-shadow:0 2px 10px rgba(74,46,30,.12); }
.pv-loading,.pv-error { padding:34px 16px; text-align:center; color:var(--ink-2,#7B5A44); font-size:14px; }
.pv-error { color:#B93A1C; }
.pv-fallback { width:100%; height:74vh; min-height:520px; border:0; }
`;

  let cssDone = false;
  function injectCss() {
    if (cssDone) return;
    cssDone = true;
    const el = document.createElement('style');
    el.id = 'pdfviewer-css';
    el.textContent = CSS;
    document.head.appendChild(el);
  }

  let libPromise = null;
  /** بارگذاریِ تنبلِ pdf.js و تنظیمِ مسیر worker (هم‌ origins پس با CSP سازگار است) */
  function lib() {
    if (!libPromise) {
      libPromise = import('/assets/vendor/pdfjs/pdf.min.js').then((m) => {
        const mod = m.default || m;
        mod.GlobalWorkerOptions.workerSrc = '/assets/vendor/pdfjs/pdf.worker.min.js';
        return mod;
      }).catch((e) => { libPromise = null; throw e; });
    }
    return libPromise;
  }

  const faNum = (n) => (typeof window.faNum === 'function'
    ? window.faNum(n)
    : String(n).replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[d]));

  /** یک صفحه را روی canvas رسم می‌کند (با درنظر گرفتنِ تراکم پیکسلی برای وضوح) */
  async function drawPage(page, canvas, scale) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const viewport = page.getViewport({ scale });
    canvas.width = Math.max(1, Math.floor(viewport.width * dpr));
    canvas.height = Math.max(1, Math.floor(viewport.height * dpr));
    canvas.style.width = Math.floor(viewport.width) + 'px';
    canvas.style.height = Math.floor(viewport.height) + 'px';
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, viewport.width, viewport.height);
    await page.render({ canvasContext: ctx, viewport }).promise;
  }

  /**
   * نمایشگر را درون یک المان باز می‌کند.
   * @returns کنترلر { page, pageCount, next, prev, goto, zoomBy, setZoom, destroy }
   */
  /**
   * تشخیص می‌دهد فایلِ پشتِ این نشانی تصویر است یا نه.
   * دانش‌آموزها پاسخ‌برگ را معمولاً با گوشی عکس می‌گیرند (JPG/PNG) و
   * pdf.js نمی‌تواند تصویر را باز کند — برای همین پیش از هر چیز نوع را
   * می‌فهمیم تا به‌جای یک جعبه‌ی خالی، خودِ عکس نمایش داده شود.
   */
  async function isImageUrl(url) {
    if (/\.(jpe?g|png|gif|webp|bmp|heic|heif)(\?|#|$)/i.test(url)) return true;
    try {
      const r = await fetch(url, { method: 'HEAD', credentials: 'same-origin' });
      const ct = (r.headers && r.headers.get('content-type')) || '';
      if (/^image\//i.test(ct)) return true;
      if (/^application\/pdf/i.test(ct) || /%PDF/i.test(ct)) return false;
    } catch (e) { /* در صورت شکست، مسیرِ pdf را امتحان می‌کنیم */ }
    return false;
  }

  /**
   * نمایشگرِ تصویر — همان رابطِ کنترلرِ نمایشگرِ PDF را برمی‌گرداند تا
   * کدهایِ فراخوان (پنل دانش‌آموز، مصحح، چاپ) نیازی به تغییر نداشته باشند.
   */
  function openImage(box, url, { onState } = {}) {
    const bar = document.createElement('div');
    bar.className = 'pv-bar';
    bar.innerHTML = `
      <span class="pv-count" data-pv="count">تصویر</span>
      <span class="pv-spacer"></span>
      <button type="button" class="pv-btn" data-pv="out" title="کوچک‌تر">−</button>
      <span class="pv-count" data-pv="zoom"></span>
      <button type="button" class="pv-btn" data-pv="in" title="بزرگ‌تر">+</button>
      <a class="pv-btn" href="${url}" target="_blank" rel="noopener" title="در تب جدید">تب جدید</a>
    `;
    const stage = document.createElement('div');
    stage.className = 'pv-stage';
    const img = document.createElement('img');
    img.className = 'pv-img';
    img.src = url;
    img.alt = 'پاسخ‌برگ';
    stage.appendChild(img);

    box.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'pv';
    wrap.appendChild(bar);
    wrap.appendChild(stage);
    box.appendChild(wrap);

    const zoomEl = bar.querySelector('[data-pv="zoom"]');
    const state = { page: 1, pageCount: 1, scale: 1, isImage: true };

    function emit() {
      zoomEl.textContent = faNum(Math.round(state.scale * 100)) + '٪';
      if (onState) onState(state);
    }
    function setZoom(s) {
      state.scale = Math.max(0.3, Math.min(3, s));
      img.style.width = (state.scale * 100) + '%';
      emit();
    }
    img.addEventListener('load', () => {
      const avail = (stage.clientWidth || box.clientWidth || 800) - 28;
      if (img.naturalWidth > avail) { state.scale = Math.max(0.3, avail / img.naturalWidth); }
      img.style.width = (state.scale * 100) + '%';
      emit();
    });
    bar.addEventListener('click', (e) => {
      const b = e.target.closest('[data-pv]');
      if (!b) return;
      if (b.dataset.pv === 'in') setZoom(state.scale + 0.25);
      else if (b.dataset.pv === 'out') setZoom(state.scale - 0.25);
    });
    img.style.width = '100%';
    emit();

    return {
      page: 1, pageCount: 1, isImage: true,
      next() {}, prev() {}, goto() {},
      zoomBy: (d) => setZoom(state.scale + (typeof d === 'number' ? d : 0.25)),
      setZoom: (s) => setZoom(s),
      destroy() {},
    };
  }

  async function open(box, url, { onState, fitWidth = true } = {}) {
    injectCss();
    box.innerHTML = '<div class="pv-loading">در حال آماده‌سازی فایل…</div>';

    // عکس (عکسِ پاسخ‌برگ) مستقیماً نمایش داده می‌شود؛ pdf.js آن را باز نمی‌کند
    if (await isImageUrl(url)) return openImage(box, url, { onState });

    let pdfjs;
    try {
      pdfjs = await lib();
    } catch (e) {
      // اگر بارگذاریِ ماژول شکست خورد، به همان iframe برمی‌گردیم تا چیزی نمایش داده شود
      box.innerHTML = `<iframe class="pv-fallback" src="${url}" title="فایل"></iframe>`;
      if (onState) onState({ page: 1, pageCount: 1, scale: 1 });
      return { page: 1, pageCount: 1, next() {}, prev() {}, goto() {}, zoomBy() {}, setZoom() {}, destroy() {} };
    }

    let doc;
    try {
      doc = await pdfjs.getDocument({ url }).promise;
    } catch (e) {
      box.innerHTML = `<div class="pv-error">فایل باز نشد. <a href="${url}" target="_blank" rel="noopener">دانلود مستقیم</a></div>`;
      if (onState) onState({ page: 1, pageCount: 1, scale: 1 });
      return { page: 1, pageCount: 1, next() {}, prev() {}, goto() {}, zoomBy() {}, setZoom() {}, destroy() {} };
    }

    const bar = document.createElement('div');
    bar.className = 'pv-bar';
    bar.innerHTML = `
      <button type="button" class="pv-btn" data-pv="prev" title="صفحه قبل">› قبلی</button>
      <span class="pv-count" data-pv="count"></span>
      <button type="button" class="pv-btn" data-pv="next" title="صفحه بعد">بعدی ‹</button>
      <span class="pv-spacer"></span>
      <button type="button" class="pv-btn" data-pv="out" title="کوچک‌تر">−</button>
      <span class="pv-count" data-pv="zoom"></span>
      <button type="button" class="pv-btn" data-pv="in" title="بزرگ‌تر">+</button>
    `;
    const stage = document.createElement('div');
    stage.className = 'pv-stage';
    const canvas = document.createElement('canvas');

    box.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'pv';
    wrap.appendChild(bar);
    stage.appendChild(canvas);
    wrap.appendChild(stage);
    box.appendChild(wrap);

    const countEl = bar.querySelector('[data-pv="count"]');
    const zoomEl = bar.querySelector('[data-pv="zoom"]');
    const prevBtn = bar.querySelector('[data-pv="prev"]');
    const nextBtn = bar.querySelector('[data-pv="next"]');

    const state = { page: 1, pageCount: doc.numPages, scale: 1, rendering: false, pages: {} };

    async function getPage(n) {
      if (!state.pages[n]) state.pages[n] = await doc.getPage(n);
      return state.pages[n];
    }

    /** مقیاسِ پیش‌فرض: پهنای صفحه در عرضِ موجود جا شود */
    async function fitScale(n) {
      const p = await getPage(n);
      const base = p.getViewport({ scale: 1 });
      const avail = (stage.clientWidth || box.clientWidth || 800) - 28;
      return Math.max(0.4, Math.min(2.2, avail / base.width));
    }

    function emit() {
      countEl.textContent = `صفحه ${faNum(state.page)} از ${faNum(state.pageCount)}`;
      zoomEl.textContent = faNum(Math.round(state.scale * 100)) + '٪';
      prevBtn.disabled = state.page <= 1;
      nextBtn.disabled = state.page >= state.pageCount;
      if (onState) onState(state);
    }

    async function draw() {
      if (state.rendering) return;
      state.rendering = true;
      try {
        const p = await getPage(state.page);
        await drawPage(p, canvas, state.scale);
        emit();
      } finally { state.rendering = false; }
    }

    async function goto(n) {
      const target = Math.min(state.pageCount, Math.max(1, n | 0));
      if (target === state.page) return;
      state.page = target;
      stage.scrollTop = 0;
      await draw();
    }

    async function setZoom(s) {
      state.scale = Math.max(0.4, Math.min(3, s));
      await draw();
    }

    bar.addEventListener('click', (e) => {
      const b = e.target.closest('[data-pv]');
      if (!b) return;
      const act = b.dataset.pv;
      if (act === 'prev') goto(state.page - 1);
      else if (act === 'next') goto(state.page + 1);
      else if (act === 'in') setZoom(state.scale + 0.25);
      else if (act === 'out') setZoom(state.scale - 0.25);
    });

    // کلیدهای جهت‌نما وقتی نمایشگر در دید است
    function onKey(e) {
      if (!document.contains(box)) { document.removeEventListener('keydown', onKey); return; }
      const tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
      if (e.key === 'ArrowLeft') { goto(state.page + 1); e.preventDefault(); }
      else if (e.key === 'ArrowRight') { goto(state.page - 1); e.preventDefault(); }
    }
    document.addEventListener('keydown', onKey);

    if (fitWidth) state.scale = await fitScale(1);
    await draw();

    return {
      get page() { return state.page; },
      get pageCount() { return state.pageCount; },
      next: () => goto(state.page + 1),
      prev: () => goto(state.page - 1),
      goto,
      setZoom,
      zoomBy: (d) => setZoom(state.scale + d),
      destroy() {
        document.removeEventListener('keydown', onKey);
        try { doc.destroy(); } catch (e) {}
      },
    };
  }

  /**
   * همه‌ی صفحه‌های یک PDF را به تصویر تبدیل می‌کند — برای گذاشتن در برگه‌ی چاپ،
   * که در آن هر تصویر دقیقاً یک صفحه‌ی چاپی می‌شود.
   * @returns {Promise<string[]>} آرایه‌ای از data-URL
   */
  async function pagesAsImages(url, { scale = 1.6, maxPages = 60 } = {}) {
    // تصویر (عکسِ پاسخ‌برگ) خودش یک صفحه است — نیازی به pdf.js ندارد
    if (await isImageUrl(url)) {
      return [await new Promise((resolve, reject) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => {
          try {
            const c = document.createElement('canvas');
            c.width = img.naturalWidth; c.height = img.naturalHeight;
            c.getContext('2d').drawImage(img, 0, 0);
            resolve(c.toDataURL('image/jpeg', 0.92));
          } catch (e) { resolve(url); }   // اگر canvas آلوده شد، همان نشانی را برگردان
        };
        img.onerror = () => resolve(url);
        img.src = url;
      })];
    }
    const pdfjs = await lib();
    const doc = await pdfjs.getDocument({ url }).promise;
    const out = [];
    const n = Math.min(doc.numPages, maxPages);
    try {
      for (let i = 1; i <= n; i++) {
        const page = await doc.getPage(i);
        const c = document.createElement('canvas');
        await drawPage(page, c, scale);
        out.push(c.toDataURL('image/jpeg', 0.92));
        c.width = c.height = 0;
        page.cleanup();
      }
    } finally {
      try { doc.destroy(); } catch (e) {}
    }
    return out;
  }

  return { open, pagesAsImages, lib };
})();
