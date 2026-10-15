'use strict';
/* pepsino LAB — موتورِ چاپ / تولید PDF
   ---------------------------------------------------------------
   روشِ کار همان روشِ پروژه‌ی قدیمی است (با کیفیتِ بهتر): یک لایه‌ی چاپِ
   اختصاصی با استایلِ RTL و فونتِ فارسی ساخته می‌شود و مرورگر «Save as PDF»
   را انجام می‌دهد. دلیلِ انتخاب این روش به‌جای تولید PDF روی سرور:
   کتابخانه‌های PDFِ سمت سرور اتصالِ حروف و راست‌چینِ فارسی را درست انجام
   نمی‌دهند و خروجی حروف را جدا می‌اندازد؛ مرورگر فارسی را بی‌نقص حروف‌چینی
   می‌کند و خروجی یک فایل PDF واقعی است.

   خروجی‌ها: کارنامه، کارنامه‌ی دسته‌جمعی، برگه‌ی سؤالات، پاسخنامه،
   برنامه‌ی راهبردی (نمای جدولی) و فهرست شرکت‌کنندگان.
*/

const Print = (() => {
  let restoreTimer = null;

  function areaEl() {
    let el = document.getElementById('printArea');
    if (!el) {
      el = document.createElement('div');
      el.id = 'printArea';
      el.className = 'print-area';
      el.setAttribute('aria-hidden', 'true');
      document.body.appendChild(el);
    }
    return el;
  }

  function brandHeader(line) {
    return `
      <div class="p-head">
        <div class="p-logo" aria-hidden="true"></div>
        <div class="p-brand">
          <b class="bn-inline bn-lg"><span class="bn-main">pepsino</span><span class="bn-sub">LAB</span></b>
          <div class="p-slogan">${esc(line || 'Get Active to Grow')}</div>
        </div>
        <div class="p-stamp">تاریخ چاپ: ${esc(Jalali.long(new Date()))}</div>
      </div>`;
  }

  function signatureFooter() {
    return `
      <div class="p-foot">
        <span class="sig">
          <svg class="sig-swash" viewBox="0 0 220 26" aria-hidden="true"><path d="M4 19c36 9 104 7 152-3 18-4 40-10 58-19" fill="none" stroke="#E0512F" stroke-width="2.4" stroke-linecap="round" opacity=".8"/></svg>
          <span class="sig-name">Dr.haji</span>
          <svg class="sig-heart" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z" fill="#E0512F"/></svg>
        </span>
      </div>`;
  }

  /**
   * یک برگه‌ی چاپی می‌سازد و پنجره‌ی چاپ را باز می‌کند.
   * sheet({ title, sub, body, headerLine, landscape, note })
   */
  function sheet({ title, sub = '', body, headerLine = '', landscape = false, note = '' }) {
    const el = areaEl();
    el.innerHTML = `
      <div class="p-toolbar no-print">
        <button class="btn primary" data-pact="print">🖨 چاپ کن / ذخیره‌ی PDF</button>
        <button class="btn ghost" data-pact="close">← بازگشت</button>
        <span class="small muted">${esc(note || 'در پنجره‌ی چاپ، «ذخیره به‌عنوان PDF» را انتخاب کن.')}</span>
      </div>
      <div class="p-page${landscape ? ' landscape' : ''}">
        ${brandHeader(headerLine)}
        ${title ? `<h1 class="p-title">${esc(title)}</h1>` : ''}
        ${sub ? `<div class="p-sub">${sub}</div>` : ''}
        ${body}
        ${signatureFooter()}
      </div>`;

    el.querySelector('[data-pact="print"]').addEventListener('click', () => window.print());
    el.querySelector('[data-pact="close"]').addEventListener('click', close);

    document.body.classList.add('printing');
    window.scrollTo(0, 0);
    clearTimeout(restoreTimer);
    restoreTimer = setTimeout(() => { try { window.print(); } catch (e) { /* مرورگر اجازه نداد */ } }, 200);
    return el;
  }

  function close() {
    document.body.classList.remove('printing');
    const el = document.getElementById('printArea');
    if (el) el.innerHTML = '';
  }

  /* ------------------------------------------------------------------ helpers */

  /** جدولِ چاپی ساده. columns: ['عنوان','...'] rows: آرایه‌ی آرایه (HTML مجاز) */
  function table(columns, rows, { empty = 'موردی برای نمایش نیست' } = {}) {
    if (!rows || !rows.length) return `<p class="muted center">${esc(empty)}</p>`;
    return `<table class="p-table">
      <thead><tr>${columns.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead>
      <tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody>
    </table>`;
  }

  /** کارتِ آمار (مثل باکس‌های پروژه‌ی قدیمی) */
  function stats(pairs) {
    return `<div class="p-stats">${pairs.map(([k, v]) =>
      `<div class="p-stat"><span class="k">${esc(k)}</span><span class="v">${v}</span></div>`).join('')}</div>`;
  }

  /** جداکننده‌ی صفحه برای چاپِ چندبرگه‌ای */
  const pageBreak = '<div class="p-break"></div>';

  /* ------------------------------------------------------------- خروجی‌ها */

  /** کارنامه‌ی یک دانش‌آموز برای یک آزمون */
  function reportCard(rc, { headerLine } = {}) {
    const rowsQ = (rc.subjects || []).flatMap((s) => (s.questions || []).map((q) => [
      esc(s.subject), faNum(q.position), esc(q.body || '—'),
      q.mark === null || q.mark === undefined ? '—' : faNum(q.mark),
      faNum(q.maxMark),
    ]));
    const body = `
      <div class="p-meta">
        <div><span>نام:</span> <b>${esc(rc.studentName || '—')}</b></div>
        <div><span>پایه / رشته:</span> <b>${esc([rc.grade, rc.field].filter(Boolean).join(' — ') || '—')}</b></div>
        <div><span>آزمون:</span> <b>${esc(rc.examTitle || '—')}</b></div>
        <div><span>تاریخ انتشار:</span> <b>${esc(rc.publishedAt ? Jalali.long(rc.publishedAt) : '—')}</b></div>
      </div>
      ${stats([
        ['نمره‌ی کل', `<b>${faNum(rc.totalMark || '0')}</b> از ${faNum(rc.maxTotalMark || '20')}`],
        ['درصد', faNum(rc.percent != null ? Math.round(rc.percent) : 0) + '٪'],
        ['رتبه در آزمون', rc.rank ? faNum(rc.rank) : '—'],
        ['وضعیت', rc.status === 'absent' ? 'غایب' : 'حاضر'],
      ])}
      ${rowsQ.length ? table(['درس', 'شماره', 'صورت سؤال', 'نمره', 'بارم'], rowsQ) : ''}
      ${rc.notes ? `<div class="p-note">${esc(rc.notes)}</div>` : ''}`;
    return sheet({
      title: 'کارنامهٔ آزمون',
      sub: esc(rc.examTitle || ''),
      body,
      headerLine,
      note: 'کارنامه آماده است؛ «ذخیره به‌عنوان PDF» را بزن.',
    });
  }

  /** کارنامه‌ی چند دانش‌آموز، هرکدام در یک صفحه */
  function reportCards(list, { headerLine } = {}) {
    const body = list.map((rc) => {
      const rowsQ = (rc.subjects || []).flatMap((s) => (s.questions || []).map((q) => [
        esc(s.subject), faNum(q.position), esc(q.body || '—'),
        q.mark === null || q.mark === undefined ? '—' : faNum(q.mark), faNum(q.maxMark),
      ]));
      return `<div class="p-page mini">
        ${brandHeader(headerLine)}
        <h2 class="p-title sm">کارنامهٔ آزمون — ${esc(rc.examTitle || '')}</h2>
        <div class="p-meta">
          <div><span>نام:</span> <b>${esc(rc.studentName || '—')}</b></div>
          <div><span>پایه:</span> <b>${esc(rc.grade || '—')}</b></div>
        </div>
        ${stats([['نمره‌ی کل', `<b>${faNum(rc.totalMark || '0')}</b> از ${faNum(rc.maxTotalMark || '20')}`],
          ['رتبه', rc.rank ? faNum(rc.rank) : '—']])}
        ${rowsQ.length ? table(['درس', 'شماره', 'صورت سؤال', 'نمره', 'بارم'], rowsQ) : ''}
      </div>${pageBreak}`;
    }).join('');
    return sheet({
      title: `کارنامه‌ها — ${list.length} برگه`,
      sub: 'هر کارنامه در یک صفحه‌ی جدا چاپ می‌شود.',
      body,
      headerLine,
    });
  }

  /** برگه‌ی سؤالات یک آزمون (فایل PDF/تصویر توکار، یا فهرست سؤالات) */
  function questionPaper(exam, { headerLine } = {}) {
    let body = '';
    if (exam.questionsFileUrl) {
      const isImage = /^image\//.test(exam.questionsFileMime || '');
      body += isImage
        ? `<div class="p-embed"><img src="${esc(exam.questionsFileUrl)}" alt="برگه سؤالات"></div>`
        : `<div class="p-embed"><iframe src="${esc(exam.questionsFileUrl)}#toolbar=0&view=FitH" title="برگه سؤالات"></iframe></div>`;
    }
    const qs = exam.questions || [];
    if (qs.length) {
      body += table(['شماره', 'صورت سؤال', 'بارم', 'پاسخ'],
        qs.map((q) => [faNum(q.position), esc(q.body || '—'), faNum(q.maxMark),
          `<span class="p-blank"></span>`]));
    }
    if (!qs.length && !exam.questionsFileUrl) {
      body += '<p class="muted center">برای این آزمون هنوز فایل یا فهرست سؤالاتی ثبت نشده است.</p>';
    }
    return sheet({
      title: exam.title || 'برگهٔ سؤالات',
      sub: [exam.gradeLabel, exam.startAt ? Jalali.long(exam.startAt) : '', exam.durationMinutes ? `${faNum(exam.durationMinutes)} دقیقه` : ''].filter(Boolean).map(esc).join(' • '),
      body, headerLine, landscape: true,
      note: 'برگهٔ سؤالات؛ در پنجره‌ی چاپ «ذخیره به‌عنوان PDF» را بزن.',
    });
  }

  /** پاسخنامهٔ رسمی */
  function answerKey(exam, { headerLine } = {}) {
    let body = '';
    if (exam.answerKeyUrl) {
      const isImage = /^image\//.test(exam.answerKeyMime || '');
      body += isImage
        ? `<div class="p-embed"><img src="${esc(exam.answerKeyUrl)}" alt="پاسخنامه"></div>`
        : `<div class="p-embed"><iframe src="${esc(exam.answerKeyUrl)}#toolbar=0&view=FitH" title="پاسخنامه"></iframe></div>`;
    } else {
      body += '<p class="muted center">پاسخنامه‌ی رسمی برای این آزمون ثبت نشده است.</p>';
    }
    return sheet({
      title: `پاسخنامه — ${exam.title || ''}`,
      sub: esc(exam.gradeLabel || ''),
      body, headerLine, landscape: true,
    });
  }

  /** برنامهٔ راهبردی به‌صورت جدول (معادلِ «نمای جدولی» پروژه‌ی قدیمی) */
  function planTable(rows, { headerLine, title = 'برنامه راهبردی' } = {}) {
    const body = table(
      ['مرحله', 'بازه', 'وضعیت', 'مباحث'],
      rows.map((p) => [
        esc(p.title || '—'),
        `${esc(Jalali.short(p.startsAt))} تا ${esc(Jalali.short(p.endsAt))}`,
        p.status === 'open' ? '<span class="p-badge ok">باز</span>'
          : p.status === 'expired' ? '<span class="p-badge off">منقضی</span>'
            : '<span class="p-badge wait">قفل</span>',
        esc(p.topicsText || '—'),
      ]),
      { empty: 'مرحله‌ای تعریف نشده است' }
    );
    return sheet({ title, sub: 'هر مرحله یک آزمون تشریحی است.', body, headerLine });
  }

  /** فهرست شرکت‌کنندگان یک آزمون */
  function participants(exam, list, { headerLine } = {}) {
    const body = table(
      ['رتبه', 'نام', 'پایه', 'رشته', 'نمره', 'وضعیت'],
      list.map((p) => [
        p.rank ? faNum(p.rank) : '—',
        esc(p.fullName || '—'),
        esc(p.grade || '—'),
        esc(p.field || '—'),
        p.totalMark ? faNum(p.totalMark) : '—',
        p.status === 'absent' ? '<span class="p-badge off">غایب</span>' : '<span class="p-badge ok">حاضر</span>',
      ]),
      { empty: 'شرکت‌کننده‌ای ثبت نشده است' }
    );
    return sheet({ title: `فهرست شرکت‌کنندگان — ${exam.title || ''}`, body, headerLine });
  }

  return {
    sheet, close, table, stats, pageBreak,
    reportCard, reportCards, questionPaper, answerKey, planTable, participants,
  };
})();

if (typeof window !== 'undefined') {
  window.Print = Print;
  window.addEventListener('afterprint', () => Print.close());
}
