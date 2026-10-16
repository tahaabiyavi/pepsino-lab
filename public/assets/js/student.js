
let ME = null;
let META = { grades: [], fields: [] };
let MY_EXAMS = [];
let Q_VIEWER = null;   // کنترلرِ نمایشگرِ PDFِ برگهٔ سؤالات

function views() { return document.querySelectorAll('main > section'); }
function go(name) {
  views().forEach((s) => s.classList.toggle('hidden', s.id !== 'view-' + name));
  setActiveNav(name);
  if (name === 'home') loadHome();
  if (name === 'exams') loadExams();
  if (name === 'results') loadResults();
  if (name === 'rankings') loadRankingsInit();
  if (name === 'appeals') loadAppeals();
  if (name === 'practice') loadPractice();
  if (name === 'notifications') loadNotifications();
  if (name === 'strategic') loadStrategicPlan();
  if (name === 'leaderboard') loadLeaderboard();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
document.addEventListener('click', (e) => {
  const g = e.target.closest('[data-go]');
  if (g) go(g.dataset.go);
});

async function boot() {
  ME = await Auth.requireRole('student');
  if (!ME) return;
  document.getElementById('whoami').textContent = ME.fullName || ME.username;
  document.getElementById('logoutBtn').addEventListener('click', Auth.logout);
  try { META = await API.get('/api/meta/options'); } catch (e) {}
  refreshNotifDot();
  decorateNav();
  go('home');
}

function refreshNotifDot() {
  API.get('/api/student/notifications').then((r) => {
    document.getElementById('notifDot').classList.toggle('hidden', !r.unread);
  }).catch(() => {});
}

/* ===================== EXAMS ===================== */
async function loadExams() {
  const box = document.getElementById('examList');
  box.innerHTML = '<div class="skeleton" style="height:84px"></div>';
  try {
    const r = await API.get('/api/student/exams');
    MY_EXAMS = r.exams;
    if (!r.exams.length) { box.innerHTML = '<div class="empty-state card soft"><b>آزمونی موجود نیست</b>فعلاً آزمونی برای پایهٔ شما منتشر نشده است.</div>'; return; }
    box.innerHTML = r.exams.map(examCardHtml).join('');
  } catch (e) { box.innerHTML = `<div class="empty-state card soft">${esc(e.message)}</div>`; }
}

function examCardHtml(ex) {
  const myStatus = ex.my_status || (ex.status === 'results_published' || ex.status === 'archived' ? '—' : 'ارسال‌نشده');
  return `
  <div class="ex-card">
    <div style="flex:1;min-width:220px">
      <b class="ex-title">${esc(ex.title)}</b>
      <div class="meta">
        <span class="tag">${esc(faStatus(ex.status))}</span>
        <span class="tag">وضعیت من: ${esc(faStatus(myStatus))}</span>
        <span class="small muted">مهلت ارسال: ${fmtDateTime(ex.submission_deadline)}</span>
      </div>
    </div>
    <button class="btn sm" data-detail="${ex.id}">مشاهده و ارسال پاسخ</button>
  </div>`;
}

document.getElementById('examList').addEventListener('click', (e) => {
  const b = e.target.closest('[data-detail]');
  if (b) openExamDetail(Number(b.dataset.detail));
});

/**
 * باز کردنِ آزمون با رعایتِ پنجره‌ی زمانی:
 *   before → قفل است؛ اصلاً باز نمی‌شود
 *   open   → ورود عادی (امکانِ آپلود)
 *   after  → شرکت تمرینی (فقط سؤالات، بدون آپلود)
 */
function openExamRespectingWindow(examId) {
  const ex = MY_EXAMS.find((e) => e.id === examId);
  const st = ex && ex.windowState;
  if (st === 'before') { Toast.show('این آزمون قفله 🔒', 'bad'); return; }
  if (st === 'after') { openExamDetail(examId, { practice: true }); return; }
  openExamDetail(examId);
}

async function openExamDetail(examId, opts) {
  go('examDetail');
  // حالت تمرینی: سؤالات دیده می‌شود، بخشِ آپلودِ پاسخ‌نامه اصلاً نمایش داده نمی‌شود
  const practice = !!(opts && opts.practice);
  const card = document.getElementById('examDetailCard');
  card.innerHTML = '<div class="skeleton" style="height:140px"></div>';
  let ex = MY_EXAMS.find((e) => e.id === Number(examId));
  // اگر فهرستِ آزمون‌ها هنوز بارگذاری نشده (مثلاً مستقیم از صفحه‌ی اصلی آمده‌ایم)، بگیرش
  if (!ex) {
    try { await loadExams(); } catch (e) {}
    ex = MY_EXAMS.find((e) => e.id === Number(examId));
  }
  if (!ex) { card.innerHTML = 'آزمون یافت نشد'; return; }

  const now = new Date();
  const open = ['published', 'in_progress'].includes(ex.status) && now < new Date(ex.submission_deadline) && !ex.my_status;
  const canUpload = open && !practice;

  // اگر صوت به‌صورت پیوندِ خارجی ثبت شده، نوعش را بپرس تا درست نمایش داده شود
  let AUDIO_KIND = null;
  if (ex.hasAudio && ex.audioUrl) {
    try {
      const info = await API.get(`/api/student/exams/${examId}/audio`);
      if (info && info.kind) { AUDIO_KIND = info.kind; if (info.url) ex.audioUrl = info.url; }
    } catch (e) { AUDIO_KIND = 'page'; }
  }

  const showQuestions = now >= new Date(ex.starts_at || 0);

  /**
   * پایانِ «مدتِ آزمون» — نه مهلتِ ارسال. دانش‌آموز فقط به اندازه‌ی
   * duration_minutes وقت دارد؛ وقتی این زمان تمام شود از آزمون بیرون می‌رود.
   */
  const allowedUntilIso = ex.allowedUntil
    || (ex.starts_at
      ? new Date(Math.min(
        new Date(ex.starts_at).getTime() + (Number(ex.duration_minutes) || 0) * 60000,
        new Date(ex.submission_deadline || Infinity).getTime(),
      )).toISOString()
      : null);
  const allowedMs = allowedUntilIso ? new Date(allowedUntilIso) - now : 0;
  const timeOver = Boolean(allowedUntilIso) && allowedMs <= 0 && showQuestions;
  // وقتی وقت تمام شده، دیگر اجازه‌ی آپلود نیست
  const mayUpload = canUpload && !timeOver;

  let uploads = [];
  if (mayUpload) {
    try { uploads = (await API.get(`/api/student/exams/${examId}/uploads`)).uploads; } catch (e) {}
  }

  card.innerHTML = `
    <h3>${esc(ex.title)}</h3>
    <div class="row wrap-r" style="margin-top:8px">
      <span class="tag">${esc(faStatus(ex.status))}</span>
      <span class="small muted">شروع: ${fmtDateTime(ex.starts_at || '')}</span>
      <span class="small muted">مدت: ${faNum(ex.duration_minutes || 0)} دقیقه</span>
      <span class="small muted">مهلت ارسال: ${fmtDateTime(ex.submission_deadline)}</span>
    </div>

    ${timeOver ? `
      <div class="card soft" style="margin-top:14px;text-align:center;border:2px solid var(--p10-deep,#B4451F);background:#FFF3EE">
        <b style="font-size:1.15em;color:var(--p10-deep,#B4451F)">مدت زمان مجاز آزمون به اتمام رسیده است ⏳</b>
        <p class="small muted" style="margin-top:6px">زمانِ ${faNum(ex.duration_minutes || 0)} دقیقه‌ایِ این آزمون پایان یافت و دیگر امکان ارسال پاسخ ندارید.</p>
      </div>
    ` : (mayUpload && allowedMs > 0 ? `
      <div class="card soft" style="margin-top:12px;text-align:center">
        <div class="small muted">زمان باقی‌مانده‌ی آزمون</div>
        <b id="examCountdown" data-cd="${allowedMs}" style="font-size:1.25em;font-variant-numeric:tabular-nums">${formatCountdown(allowedMs)}</b>
      </div>
    ` : '')}

    ${showQuestions && ex.hasAudio ? `
      <div class="card soft" style="margin-top:16px">
        <div class="row wrap-r">
          <b>🎧 بخش لیسنینگ</b>
          <span class="spacer"></span>
          ${ex.audioUrl
            ? `<a class="btn sm ghost" href="${esc(ex.audioUrl)}" target="_blank" rel="noopener">باز کردن در تب جدید</a>`
            : `<a class="btn sm ghost" href="/api/student/exams/${examId}/audio" download>دانلود فایل صوتی</a>`}
        </div>
        <p class="small muted" style="margin-top:4px">فایل صوتی را پخش کنید و هم‌زمان به سؤالات پاسخ دهید.</p>
        ${ex.audioUrl
          ? (AUDIO_KIND === 'embed'
              ? `<iframe id="listeningFrame" src="${esc(ex.audioUrl)}" title="فایل صوتی لیسنینگ"
                         style="width:100%;height:220px;border:0;border-radius:8px;margin-top:8px"
                         allow="autoplay; encrypted-media" allowfullscreen></iframe>`
              : AUDIO_KIND === 'page'
                ? `<iframe id="listeningFrame" src="${esc(ex.audioUrl)}" title="فایل صوتی لیسنینگ"
                           style="width:100%;height:260px;border:0;border-radius:8px;margin-top:8px"></iframe>`
                : `<audio id="listeningAudio" controls preload="metadata" src="${esc(ex.audioUrl)}"
                         style="width:100%;margin-top:8px"></audio>`)
          : `<audio id="listeningAudio" controls preload="metadata"
                    src="/api/student/exams/${examId}/audio"
                    style="width:100%;margin-top:8px"></audio>`}
      </div>
    ` : ''}

    ${ex.my_status ? `<div class="badge-lock" style="margin-top:16px">وضعیت ارسال شما: <b>${esc(faStatus(ex.my_status))}</b>${ex.submitted_at ? ' — ' + fmtDateTime(ex.submitted_at) : ''}</div>` : ''}

    ${showQuestions ? `
      <div class="card soft" style="margin-top:16px">
        <div class="row wrap-r">
          <b>سؤالات آزمون</b>
          <span class="spacer"></span>
          <button class="btn sm ghost" id="printQuestionsBtn">🖨 پرینت برگهٔ سؤالات</button>
          <a class="btn sm ghost" href="/api/student/exams/${examId}/questions-file" target="_blank">دانلود فایل</a>
        </div>
        <div id="questionsViewer" style="margin-top:12px"></div>
      </div>
    ` : '<p class="small muted" style="margin-top:12px">فایل سؤالات پس از شروع آزمون نمایش داده می‌شود.</p>'}

    ${mayUpload ? `
      <div class="field" style="margin-top:18px">
        <label>آپلود پاسخنامه دانش‌آموز (عکس یا PDF از برگه دست‌نویس)</label>
        <div class="img-slot" id="dropSlot">
          <span>برای انتخاب فایل(ها) کلیک کنید یا فایل‌ها را اینجا رها کنید</span>
          <span class="hint2">فایل پاسخنامه خود را بارگذاری کنید</span>
        </div>
        <input type="file" id="fileInput" accept="application/pdf,image/*" multiple class="hidden">
      </div>
      <div class="file-list" id="fileList"></div>
      <button class="btn primary block" id="submitExamBtn" style="margin-top:14px">ثبت نهایی پاسخ‌ها</button>
      <p class="small muted" style="margin-top:8px">پس از «ثبت نهایی» امکان تغییر پاسخ وجود ندارد.</p>
    ` : ''}

    ${ex.answer_key_published_at ? `<a class="btn ghost sm" style="margin-top:14px" href="/api/student/exams/${examId}/answer-key" target="_blank">دانلود پاسخنامهٔ رسمی</a>` : ''}
    ${ex.results_published_at ? `<button class="btn sm" style="margin-top:14px" data-go="results">مشاهدهٔ کارنامه</button>` : ''}
  `;
  // شمارش معکوسِ «مدتِ آزمون» — با اتمامش دانش‌آموز از آزمون بیرون می‌رود
  if (mayUpload && allowedMs > 0) {
    if (EXAM_CD_TIMER) clearInterval(EXAM_CD_TIMER);
    let kicked = false;
    EXAM_CD_TIMER = setInterval(() => {
      const cdEl = document.getElementById('examCountdown');
      const onExam = (() => {
        const v = document.getElementById('view-examDetail');
        return Boolean(v) && !v.classList.contains('hidden');
      })();
      // اگر از صفحه‌ی آزمون خارج شده، تایمر را خاموش کن (با بازگشت دوباره ساخته می‌شود)
      if (!cdEl || !onExam) { clearInterval(EXAM_CD_TIMER); EXAM_CD_TIMER = null; return; }
      const ms = Number(cdEl.dataset.cd) - 1000;
      cdEl.dataset.cd = ms;
      if (ms <= 0) {
        clearInterval(EXAM_CD_TIMER); EXAM_CD_TIMER = null;
        if (kicked) return;
        kicked = true;
        // صوت را هم متوقف کن که در پس‌زمینه پخش نماند
        const au = document.getElementById('listeningAudio');
        if (au) { try { au.pause(); } catch (e) {} }
        // بیرون انداختن از صفحه‌ی آزمون + آگاه‌سازی (go خودش loadHome را صدا می‌زند)
        go('home');
        Toast.show('مدت زمان مجاز آزمون به اتمام رسیده است ⏳', 'bad');
        return;
      }
      cdEl.textContent = formatCountdown(ms);
    }, 1000);
  }
  // نمایشگرِ PDF با دکمه‌های صفحه‌ی قبل/بعد و بزرگ‌نمایی
  const qBox = document.getElementById('questionsViewer');
  if (qBox && showQuestions && window.PdfViewer) {
    if (Q_VIEWER) { try { Q_VIEWER.destroy(); } catch (e) {} Q_VIEWER = null; }
    PdfViewer.open(qBox, `/api/student/exams/${examId}/questions-file`)
      .then((v) => { Q_VIEWER = v; })
      .catch(() => {});
  }

  // چاپِ برگهٔ سؤالات (PDF از طریقِ چاپِ مرورگر)
  const pq = document.getElementById('printQuestionsBtn');
  if (pq) {
    pq.addEventListener('click', () => {
      Print.questionPaper({
        title: ex.title,
        gradeLabel: ex.gradeLabel,
        startAt: ex.starts_at || ex.startsAt,
        durationMinutes: ex.duration_minutes || ex.durationMinutes,
        questionsFileUrl: `/api/student/exams/${examId}/questions-file`,
        questionsFileMime: 'application/pdf',
      }, { headerLine: (HOME && HOME.texts && HOME.texts.print_header_line) || '' })
        .catch(() => Print.printFileDirect(`/api/student/exams/${examId}/questions-file`));
    });
  }


  if (mayUpload) {
    renderFileList(uploads, examId);
    const slot = document.getElementById('dropSlot');
    const input = document.getElementById('fileInput');
    slot.addEventListener('click', () => input.click());
    // انتخابِ چندتایی: همه‌ی فایل‌ها پشتِ سر هم فرستاده می‌شوند و تازه در پایان
    // یک بار صفحه بازسازی می‌شود (قبلاً فقط files[0] می‌رفت و بقیه از دست می‌رفت).
    input.addEventListener('change', () => {
      const picked = Array.from(input.files || []);
      input.value = '';                       // تا دوباره بتوان همان فایل را برگزید
      if (picked.length) uploadFiles(examId, picked);
    });
    ['dragover', 'dragleave', 'drop'].forEach((ev) => slot.addEventListener(ev, (e) => {
      e.preventDefault();
      slot.classList.toggle('drag', ev === 'dragover');
      if (ev === 'drop') {
        const dropped = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
        if (dropped.length) uploadFiles(examId, dropped);
      }
    }));
    document.getElementById('submitExamBtn').addEventListener('click', () => submitExam(examId));
  }
}

function renderFileList(uploads, examId) {
  const box = document.getElementById('fileList');
  if (!box) return;
  box.innerHTML = uploads.map((u) => `
    <div class="file-row">
      <span class="name">${esc(u.original_name)}</span>
      <span class="small muted">${fmtBytes(u.size_bytes)}</span>
      <button class="btn sm ghost" data-del="${u.id}">حذف</button>
    </div>`).join('') || '<p class="small muted">هنوز فایلی بارگذاری نشده است.</p>';
  box.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
    try { await API.del(`/api/student/exams/${examId}/uploads/${b.dataset.del}`); openExamDetail(examId); }
    catch (e) { Toast.show(e.message, 'bad'); }
  }));
}

async function uploadFile(examId, file) {
  const fd = new FormData();
  fd.append('file', file);
  await API.post(`/api/student/exams/${examId}/uploads`, fd);
}

/**
 * چند فایل را یکی‌یکی می‌فرستد و فقط در پایان یک بار صفحه را بازسازی می‌کند.
 * (بازسازی میانِ هر فایل، فایل‌هایِ در صف را از دست می‌داد.)
 */
async function uploadFiles(examId, files) {
  const slot = document.getElementById('dropSlot');
  let ok = 0; let failed = 0; let lastErr = '';
  if (slot) { slot.style.opacity = '.55'; slot.style.pointerEvents = 'none'; }
  try {
    for (const f of files) {
      try { await uploadFile(examId, f); ok += 1; } catch (e) { failed += 1; lastErr = e.message || ''; }
    }
  } finally {
    if (slot) { slot.style.opacity = ''; slot.style.pointerEvents = ''; }
  }
  if (ok && !failed) Toast.show(faNum(ok) + ' فایل بارگذاری شد', 'good');
  else if (ok && failed) Toast.show(faNum(ok) + ' فایل رفت، ' + faNum(failed) + ' ناموفق' + (lastErr ? ' — ' + lastErr : ''), 'bad');
  else Toast.show(lastErr || 'هیچ فایلی بارگذاری نشد', 'bad');
  openExamDetail(examId);
}

async function submitExam(examId) {
  const ok = await confirmModal({ title: 'ثبت نهایی پاسخ', body: 'پس از ثبت نهایی، امکان تغییر یا افزودن فایل وجود نخواهد داشت. ادامه می‌دهید؟', okText: 'ثبت نهایی', danger: true });
  if (!ok) return;
  try {
    await API.post(`/api/student/exams/${examId}/submit`, {});
    Toast.show('پاسخ شما ثبت شد', 'good');
    openExamDetail(examId);
  } catch (e) { Toast.show(e.message, 'bad'); }
}

/* ===================== RESULTS ===================== */
async function loadResults() {
  // جدول وضعیت حاضر/غایب
  const statusBox = document.getElementById('resultList');
  if (statusBox) {
    try {
      const r = await API.get('/api/student/exams');
      const exams = r.exams || MY_EXAMS || [];
      statusBox.innerHTML = `
        <table class="table" style="width:100%;margin-bottom:16px">
          <thead><tr><th>مرحله آزمون</th><th>وضعیت</th><th>عملیات</th></tr></thead>
          <tbody>
            ${exams.map((ex) => {
              const st = ex.my_status || '';
              const isAbsent = st === 'absent' || st === 'missing';
              const isPresent = st === 'submitted' || !!ex.results_published_at;
              let statusLabel = isAbsent ? 'غایب' : (isPresent || st === 'submitted' ? 'حاضر' : '—');
              let action = (isPresent && ex.results_published_at)
                ? `<button class="btn sm" data-report="${ex.id}">مشاهده کارنامه</button>`
                : '—';
              if (isAbsent) action = '—';
              return `<tr><td>${esc(ex.title)}</td><td><span class="tag">${statusLabel}</span></td><td>${action}</td></tr>`;
            }).join('') || '<tr><td colspan="3" class="muted">آزمونی نیست</td></tr>'}
          </tbody>
        </table>`;
      statusBox.querySelectorAll('[data-report]').forEach((b) => b.addEventListener('click', () => {
        const sel = document.getElementById('reportExamSelect');
        if (sel) { sel.value = b.dataset.report; showReportCard(Number(b.dataset.report)); }
      }));
    } catch (e) { statusBox.innerHTML = `<p class="muted">${esc(e.message)}</p>`; }
  }

  const sel = document.getElementById('reportExamSelect');
  if (sel) {
    const published = MY_EXAMS.filter((e) => e.results_published_at);
    sel.innerHTML = '<option value="">انتخاب کنید…</option>' + published.map((e) => `<option value="${e.id}">${esc(e.title)}</option>`).join('');
    sel.onchange = () => showReportCard(Number(sel.value));
  }
  const box = document.getElementById('reportCardBox');
  if (box) box.classList.add('hidden');

  try {
    const r = await API.get('/api/student/score-history');
    const tbody = document.querySelector('#historyTable tbody');
    if (tbody) tbody.innerHTML = r.history.map((h) => `<tr><td>${esc(h.examTitle)}</td><td>${fmtDate(h.publishedAt)}</td><td><b>${faNum(h.totalMark)}</b></td></tr>`).join('') || '<tr><td colspan="3" class="muted">هنوز نتیجه‌ای منتشر نشده است</td></tr>';
  } catch (e) {}
}

async function showReportCard(examId) {
  const box = document.getElementById('reportCardBox');
  if (!examId) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  box.innerHTML = '<div class="skeleton" style="height:120px"></div>';
  try {
    const r = await API.get(`/api/student/report-cards/${examId}`);
    const c = r.reportCard;
    box.innerHTML = `
      <div class="score-card">
        <div class="ring"><svg viewBox="0 0 120 120" width="148" height="148">
          <circle cx="60" cy="60" r="52" fill="none" stroke="#F3E7CE" stroke-width="12"/>
          <circle cx="60" cy="60" r="52" fill="none" stroke="#C99012" stroke-width="12" stroke-dasharray="326" stroke-dashoffset="0" stroke-linecap="round"/>
        </svg><div class="val"><b>${faNum(c.totalMark)}</b><span>نمرهٔ کل</span></div></div>
        <div>
          <h3>${esc(c.examTitle)}</h3>
          <p class="small muted">${esc(c.studentName)} — ${esc(c.grade)} / ${esc(c.field)}</p>
          ${c.rank ? `<span class="tag solid">رتبه ${faNum(c.rank)}</span>` : ''}
        </div>
      </div>
      <div class="table-wrap" style="margin-top:16px"><table class="plan">
        <thead><tr><th>درس</th><th>نمره</th></tr></thead>
        <tbody>${c.subjects.map((s) => `<tr><td>${esc(s.subject)}</td><td>${faNum(s.totalMark)}</td></tr>`).join('')}</tbody>
      </table></div>
      <div class="row wrap-r" style="margin-top:14px">
        <button class="btn sm" id="printCardBtn">🖨 چاپ کارنامه / PDF</button>
        <button class="btn sm ghost" id="openAppealBtn">ثبت اعتراض به این نمره</button>
      </div>
    `;
    document.getElementById('printCardBtn').addEventListener('click', () => {
      Print.reportCard({
        examTitle: c.examTitle,
        studentName: c.studentName,
        grade: c.grade,
        field: c.field,
        totalMark: c.totalMark,
        maxTotalMark: c.maxTotalMark,
        rank: c.rank,
        status: c.status,
        subjects: c.subjects,
        publishedAt: c.publishedAt,
      }, { headerLine: (HOME && HOME.texts && HOME.texts.print_header_line) || '' });
    });
  } catch (e) { box.innerHTML = `<p class="muted">${esc(e.message)}</p>`; }
}

async function openAppealForm(examId) {
  // We need the submission id: derive it is not directly exposed here, so ask backend indirectly via appeals list is not possible pre-creation.
  // The report card does not return submissionId, so we ask the student to confirm the exam and send reason; submissionId must be looked up server-side.
  // Work-around: fetch via exam's own submission state is not exposed either, so request the id via rankings exam endpoint's own record isn't present too.
  // We fall back to prompting is avoided: use a hidden lookup through score-history (also no submissionId). As a pragmatic approach we ask admin-safe path:
  const out = await formModal({
    title: 'ثبت اعتراض',
    fieldsHtml: `
      <div class="field"><label>شمارهٔ سؤال (اختیاری)</label><input class="inp" name="questionId" type="number" min="1"></div>
      <div class="field"><label>متن اعتراض</label><textarea class="inp" name="reason" required minlength="10" maxlength="1000"></textarea></div>`,
    okText: 'ثبت اعتراض',
    onSubmit: async (obj) => {
      const sid = await resolveSubmissionId(examId);
      await API.post(`/api/student/submissions/${sid}/appeals`, { questionId: obj.questionId || undefined, reason: obj.reason });
    },
  });
  if (out) Toast.show('اعتراض شما ثبت شد', 'good');
}

// The submission id for the signed-in student + exam is not returned by any
// student-facing endpoint directly; we recover it from the exam ranking list
// (which includes studentId, not submissionId) — so instead we keep a small
// client-side cache populated right after a successful /submit call this
// session. If unavailable (e.g. page reload), ask once.
const SUBMISSION_CACHE = {};
async function resolveSubmissionId(examId) {
  if (SUBMISSION_CACHE[examId]) return SUBMISSION_CACHE[examId];
  const manual = prompt('شناسهٔ ارسال (submission) برای این آزمون را وارد کنید. این شناسه هنگام ارسال پاسخ به شما نمایش داده می‌شود یا می‌توانید از مدیریت بپرسید:');
  if (!manual) throw { message: 'ثبت اعتراض لغو شد' };
  return Number(manual);
}

/* ===================== RANKINGS ===================== */
function loadRankingsInit() {
  const gSel = document.getElementById('gradeCodeSelect');
  const sgSel = document.getElementById('subjGradeCodeSelect');
  const opts = META.grades.map((g) => `<option value="${g.code}">${esc(g.label)}</option>`).join('');
  gSel.innerHTML = opts; sgSel.innerHTML = opts;

  const examSel = document.getElementById('rankExamSelect');
  const withResults = MY_EXAMS.filter((e) => e.results_published_at);
  examSel.innerHTML = '<option value="">انتخاب کنید…</option>' + withResults.map((e) => `<option value="${e.id}">${esc(e.title)}</option>`).join('');
  examSel.onchange = () => loadExamRanking(Number(examSel.value));

  document.getElementById('loadGradeRanking').onclick = loadGradeRanking;
  document.getElementById('loadSubjectRanking').onclick = loadSubjectRanking;
}

document.querySelectorAll('[data-rtab]').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('[data-rtab]').forEach((x) => x.classList.remove('on'));
  b.classList.add('on');
  ['exam', 'grade', 'subject'].forEach((k) => document.getElementById('rk-' + k).classList.toggle('hidden', k !== b.dataset.rtab));
}));

async function loadExamRanking(examId) {
  const tbody = document.querySelector('#rankExamTable tbody');
  if (!examId) { tbody.innerHTML = ''; return; }
  tbody.innerHTML = '<tr><td colspan="5" class="muted">در حال بارگذاری…</td></tr>';
  try {
    const r = await API.get(`/api/student/rankings/exams/${examId}`);
    tbody.innerHTML = r.ranking.ranked.map(rowRankHtml).join('') || '<tr><td colspan="5" class="muted">نتیجه‌ای نیست</td></tr>';
  } catch (e) { tbody.innerHTML = `<tr><td colspan="5">${esc(e.message)}</td></tr>`; }
}
function rowRankHtml(r) {
  return `<tr><td><span class="rankb">${faNum(r.rank)}</span></td><td>${esc(r.fullName)}</td><td>${esc(r.grade)}</td><td>${esc(r.field)}</td><td><b>${faNum(r.totalMark)}</b></td></tr>`;
}

async function loadGradeRanking() {
  const academicYearId = Number(document.getElementById('gradeYearId').value);
  const gradeCode = document.getElementById('gradeCodeSelect').value;
  const tbody = document.querySelector('#rankGradeTable tbody');
  tbody.innerHTML = '<tr><td colspan="4" class="muted">در حال بارگذاری…</td></tr>';
  try {
    const r = await API.get(`/api/student/rankings/grade?academicYearId=${academicYearId}&gradeCode=${gradeCode}`);
    tbody.innerHTML = r.ranking.ranked.map((x) => `<tr><td><span class="rankb">${faNum(x.rank)}</span></td><td>${esc(x.fullName)}</td><td>${faNum(x.examsCounted)}</td><td><b>${faNum(x.averageMark)}</b></td></tr>`).join('') || '<tr><td colspan="4" class="muted">نتیجه‌ای نیست</td></tr>';
  } catch (e) { tbody.innerHTML = `<tr><td colspan="4">${esc(e.message)}</td></tr>`; }
}

async function loadSubjectRanking() {
  const academicYearId = Number(document.getElementById('subjYearId').value);
  const gradeCode = document.getElementById('subjGradeCodeSelect').value;
  const subjectId = Number(document.getElementById('subjSubjectId').value);
  const tbody = document.querySelector('#rankSubjectTable tbody');
  if (!subjectId) { Toast.show('شناسهٔ درس را وارد کنید', 'bad'); return; }
  tbody.innerHTML = '<tr><td colspan="4" class="muted">در حال بارگذاری…</td></tr>';
  try {
    const r = await API.get(`/api/student/rankings/subject?academicYearId=${academicYearId}&gradeCode=${gradeCode}&subjectId=${subjectId}`);
    tbody.innerHTML = r.ranking.ranked.map((x) => `<tr><td><span class="rankb">${faNum(x.rank)}</span></td><td>${esc(x.fullName)}</td><td>${faNum(x.examsCounted)}</td><td><b>${faNum(x.averageMark)}</b></td></tr>`).join('') || '<tr><td colspan="4" class="muted">نتیجه‌ای نیست</td></tr>';
  } catch (e) { tbody.innerHTML = `<tr><td colspan="4">${esc(e.message)}</td></tr>`; }
}

/* ===================== APPEALS ===================== */
async function loadAppeals() {
  const box = document.getElementById('appealsList');
  box.innerHTML = '<div class="skeleton" style="height:60px"></div>';
  try {
    const r = await API.get('/api/student/appeals');
    box.innerHTML = r.appeals.map((a) => `
      <div class="card soft">
        <div class="row wrap-r">
          <b>${esc(a.exam_title)}</b>
          <span class="tag ${a.status === 'accepted' ? 'good' : a.status === 'rejected' ? 'bad' : ''}">${esc(faStatus(a.status))}</span>
          <span class="small muted">${fmtDateTime(a.created_at)}</span>
        </div>
        ${a.decision_note ? `<p class="small" style="margin-top:8px">پاسخ مدیریت: ${esc(a.decision_note)}</p>` : ''}
      </div>`).join('') || '<div class="empty-state card soft"><b>اعتراضی ثبت نشده است</b></div>';
  } catch (e) { box.innerHTML = `<p class="muted">${esc(e.message)}</p>`; }
}

/* ===================== PRACTICE ===================== */
async function loadPractice() {
  const box = document.getElementById('practiceSets');
  box.innerHTML = '<div class="skeleton" style="height:84px"></div>';
  try {
    const r = await API.get('/api/student/practice-sets');
    box.innerHTML = r.sets.map((s) => `
      <div class="ex-card">
        <div style="flex:1;min-width:220px"><b class="ex-title">${esc(s.title)}</b>
          <div class="meta"><span class="tag b">${esc(s.subject)}</span><span class="small muted">${faNum(s.question_count)} سؤال</span></div>
        </div>
        <button class="btn sm" data-practice="${s.id}">شروع تمرین</button>
      </div>`).join('') || '<div class="empty-state card soft"><b>تمرینی موجود نیست</b></div>';
    box.querySelectorAll('[data-practice]').forEach((b) => b.addEventListener('click', () => startPractice(Number(b.dataset.practice))));
  } catch (e) { box.innerHTML = `<p class="muted">${esc(e.message)}</p>`; }
}

async function startPractice(setId) {
  try {
    const started = await API.post(`/api/student/practice-sets/${setId}/attempts`, {});
    await openPracticeAttempt(started.attemptId);
  } catch (e) { Toast.show(e.message, 'bad'); }
}

async function openPracticeAttempt(attemptId) {
  go('practiceAttempt');
  const box = document.getElementById('practiceAttemptBox');
  box.innerHTML = '<div class="skeleton" style="height:160px"></div>';
  const r = await API.get(`/api/student/practice-attempts/${attemptId}`);
  renderPracticeAttempt(r.attempt, attemptId);
}

function renderPracticeAttempt(att, attemptId) {
  const box = document.getElementById('practiceAttemptBox');
  box.innerHTML = `
    ${att.submitted ? `<div class="card"><div class="score-card">
      <div class="ring"><svg viewBox="0 0 120 120" width="120" height="120">
        <circle cx="60" cy="60" r="52" fill="none" stroke="#F3E7CE" stroke-width="12"/></svg>
        <div class="val"><b>${faNum(att.selfTotal)}</b><span>از ${faNum(att.selfMaxTotal)}</span></div></div>
      <div><h3>نتیجهٔ خودارزیابی</h3><p class="small muted">این نمره در کارنامهٔ رسمی شما اثری ندارد.</p></div>
    </div></div>` : ''}
    ${att.questions.map((q) => `
      <div class="q-card ${q.selfMark != null ? 'answered' : ''}" data-q="${q.id}">
        <div class="q-head"><div class="q-num">${faNum(q.position)}</div><div class="q-text">${esc(q.body)}</div></div>
        <div class="row" style="margin-top:12px;max-width:220px">
          <input class="inp" type="text" placeholder="نمرهٔ خودارزیابی (حداکثر ${faNum(q.maxMark)})" value="${q.selfMark != null ? q.selfMark : ''}" ${att.submitted ? 'disabled' : ''} data-mark>
        </div>
        ${att.submitted && q.explanatoryAnswer ? `<div class="exp">${esc(q.explanatoryAnswer)}</div>` : ''}
      </div>`).join('')}
    ${!att.submitted ? `
      <div class="row">
        <button class="btn ghost" id="saveScoresBtn">ذخیرهٔ پیش‌نویس</button>
        <button class="btn primary" id="submitAttemptBtn">پایان و نمایش پاسخ‌نامه</button>
      </div>` : ''}
  `;
  if (!att.submitted) {
    document.getElementById('saveScoresBtn').addEventListener('click', () => savePracticeScores(attemptId));
    document.getElementById('submitAttemptBtn').addEventListener('click', async () => {
      await savePracticeScores(attemptId, true);
      const done = await API.post(`/api/student/practice-attempts/${attemptId}/submit`, {});
      renderPracticeAttempt(done.attempt, attemptId);
    });
  }
}

async function savePracticeScores(attemptId, silent) {
  const scores = [];
  document.querySelectorAll('[data-q]').forEach((card) => {
    const mark = card.querySelector('[data-mark]').value;
    if (mark !== '') scores.push({ questionId: Number(card.dataset.q), mark });
  });
  try {
    await API.put(`/api/student/practice-attempts/${attemptId}/scores`, { scores });
    if (!silent) Toast.show('ذخیره شد', 'good');
  } catch (e) { Toast.show(e.message, 'bad'); }
}

/* ===================== NOTIFICATIONS ===================== */
async function loadNotifications() {
  const box = document.getElementById('notifList');
  box.innerHTML = '<div class="skeleton" style="height:60px"></div>';
  try {
    const r = await API.get('/api/student/notifications');
    box.innerHTML = r.notifications.map((n) => `
      <div class="card soft" style="${n.read_at ? 'opacity:.7' : ''}">
        <div class="row wrap-r"><b>${esc(n.title)}</b><span class="spacer"></span><span class="small muted">${fmtDateTime(n.created_at)}</span></div>
        <p class="small" style="margin-top:6px">${esc(n.body || '')}</p>
        ${!n.read_at ? `<button class="btn sm ghost" style="margin-top:8px" data-read="${n.id}">علامت‌گذاری به‌عنوان خوانده‌شده</button>` : ''}
      </div>`).join('') || '<div class="empty-state card soft"><b>اعلانی موجود نیست</b></div>';
    box.querySelectorAll('[data-read]').forEach((b) => b.addEventListener('click', async () => {
      await API.post(`/api/student/notifications/${b.dataset.read}/read`, {});
      loadNotifications(); refreshNotifDot();
    }));
  } catch (e) { box.innerHTML = `<p class="muted">${esc(e.message)}</p>`; }
}


/* ===================== برنامه راهبردی ===================== */
function formatCountdown(ms) {
  if (ms == null || ms < 0) return '';
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return h + ' ساعت و ' + m + ' دقیقه';
  if (m > 0) return m + ' دقیقه و ' + s + ' ثانیه';
  return s + ' ثانیه';
}

async function loadStrategicPlan() {
  const box = document.getElementById('strategicList');
  if (!box) return;
  box.innerHTML = '<div class="skeleton" style="height:84px"></div>';
  try {
    const r = await API.get('/api/student/strategic-plan');
    if (!r.phases || !r.phases.length) {
      box.innerHTML = '<div class="empty-state card soft"><b>برنامه راهبردی موجود نیست</b>هنوز مرحله‌ای برای پایه شما تعریف نشده است.</div>';
      return;
    }
    box.innerHTML = r.phases.map(function(p) {
      var statusHtml = '';
      if (p.status === 'expired') {
        statusHtml = '<span class="tag" style="background:#fde8e8;color:#b91c1c">' + esc(p.statusText) + '</span>';
      } else if (p.status === 'locked') {
        statusHtml = '<span class="tag" style="background:#fef3c7;color:#92400e">' + esc(p.statusText) + '</span>' +
          '<div class="countdown small muted" data-cd="' + p.countdownMs + '">' + formatCountdown(p.countdownMs) + ' تا شروع آزمون</div>';
      } else {
        statusHtml = '<span class="tag" style="background:#d1fae5;color:#065f46">' + esc(p.statusText) + '</span>' +
          '<div class="countdown small muted" data-cd="' + p.countdownMs + '">' + formatCountdown(p.countdownMs) + ' تا پایان این آزمون</div>';
      }
      var topics = p.topicsText
        ? '<div class="topics-box card soft" style="margin-top:10px"><b>مباحث</b><p class="small" style="margin:6px 0 0;white-space:pre-wrap">' + esc(p.topicsText) + '</p></div>'
        : '';
      return '<div class="ex-card strategic-card" data-phase="' + p.id + '">' +
        '<div style="flex:1;min-width:220px">' +
          '<b class="ex-title">' + esc(p.title) + '</b>' +
          '<div class="meta">' +
            '<span class="small muted">' + fmtDateTime(p.startsAt) + ' — ' + fmtDateTime(p.endsAt) + '</span> ' +
            statusHtml +
          '</div>' + topics +
        '</div></div>';
    }).join('');
    startStrategicCountdowns();
  } catch (e) {
    box.innerHTML = '<div class="empty-state card soft">' + esc(e.message) + '</div>';
  }
}

var _cdTimer = null;
function startStrategicCountdowns() {
  if (_cdTimer) clearInterval(_cdTimer);
  _cdTimer = setInterval(function() {
    document.querySelectorAll('[data-cd]').forEach(function(el) {
      var ms = Number(el.dataset.cd);
      if (!Number.isFinite(ms)) return;
      ms -= 1000;
      el.dataset.cd = ms;
      if (ms <= 0) { el.textContent = 'زمان فرا رسید'; return; }
      var prefix = el.textContent.indexOf('پایان') >= 0 ? ' تا پایان این آزمون' : ' تا شروع آزمون';
      el.textContent = formatCountdown(ms) + prefix;
    });
  }, 1000);
}

/* ===================== لیدربورد ===================== */
async function loadLeaderboard() {
  const box = document.getElementById('leaderboardList');
  if (!box) return;
  box.innerHTML = '<div class="skeleton" style="height:84px"></div>';
  try {
    const r = await API.get('/api/student/leaderboard');
    if (!r.entries || !r.entries.length) {
      box.innerHTML = '<div class="empty-state card soft"><b>هنوز رتبه‌ای ثبت نشده</b></div>';
      return;
    }
    box.innerHTML = '<div class="card soft" style="margin-bottom:12px"><b>نفرات برتر</b> <span class="small muted">(نمایش ' + r.topN + ' نفر اول)</span></div>' +
      '<table class="table" style="width:100%"><thead><tr><th>رتبه</th><th>نام</th><th>پایه</th><th>مجموع نمره</th></tr></thead><tbody>' +
      r.entries.map(function(e) {
        return '<tr><td><b>' + e.rank + '</b></td><td>' + esc(e.fullName) + '</td><td>' + esc(e.grade) + '</td><td>' + esc(e.totalMark) + '</td></tr>';
      }).join('') + '</tbody></table>';
  } catch (e) {
    box.innerHTML = '<div class="empty-state card soft">' + esc(e.message) + '</div>';
  }
}


/* ==================================================================
 * خانه — صفحه‌ی اصلیِ منتقل‌شده از پروژه‌ی قدیمی
 * هرچه روزِ اول روی صفحه‌ی اصلیِ سایت بود (معرفی برنامه، شمارش معکوس،
 * کارتِ مرحله‌ی جاری، آمار، برنامه‌ی مراحل، تقویم، آزمون‌های پیش‌رو،
 * رتبه‌بندی و راهنما) اینجا و در پنل دانش‌آموز زندگی می‌کند.
 * ================================================================== */

const HOME_NAV_ICONS = {
  home: 'home', strategic: 'target', exams: 'exam', results: 'file',
  leaderboard: 'trophy', rankings: 'chart', appeals: 'info', practice: 'practice',
  notifications: 'bell',
};

let HOME = null;
let CAL = null;          // ماهِ در حال نمایشِ تقویم
let CAL_TIMER = null;

function decorateNav() {
  document.querySelectorAll('nav.main [data-nav]').forEach((b) => {
    const name = HOME_NAV_ICONS[b.dataset.nav];
    if (!name || b.querySelector('.ico')) return;
    b.insertAdjacentHTML('afterbegin', icon(name, { size: 17 }));
    b.style.display = 'inline-flex';
    b.style.alignItems = 'center';
    b.style.gap = '6px';
  });
  const out = document.getElementById('logoutBtn');
  if (out && !out.querySelector('.ico')) out.insertAdjacentHTML('afterbegin', icon('logout', { size: 15 }));
}

async function loadHome() {
  if (HOME) { renderHome(HOME); return; }          // کشِ سبک برای جابه‌جایی تب‌ها
  try {
    HOME = await API.get('/api/student/home');
    CAL = HOME.calendar ? { jy: HOME.calendar.jy, jm: HOME.calendar.jm } : null;
    renderHome(HOME);
  } catch (e) {
    const box = document.getElementById('homeExamGrid');
    if (box) box.innerHTML = '<div class="empty-state card soft">' + esc(e.message) + '</div>';
  }
}

function renderHome(d) {
  const t = d.texts || {};
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val || ''; };

  // ---- متن‌های قابل ویرایش ----
  set('homeHead', t.home_head);
  set('homeTitle', t.home_title);
  set('homePlanTitle', t.plan_title);
  set('homePlanSub', t.plan_sub);
  set('homeCalTitle', t.cal_title);
  set('homeCalSub', t.cal_sub);
  set('homeExamsTitle', t.exams_title);
  set('homeExamsSub', t.exams_sub);
  set('homeBoardTitle', t.board_title);
  set('homeBoardSub', t.board_sub);
  set('homeStatsTitle', t.stats_title);
  const lead = document.getElementById('homeLead');
  if (lead) lead.innerHTML = t.home_lead || '';
  const cta = document.getElementById('homeCtaBtn');
  if (cta) {
    cta.innerHTML = icon('play', { size: 17 }) + (t.home_cta || 'ورود به آزمون');
    cta.onclick = () => {
      const running = (d.upcomingExams || []).find((e) => e.windowState === 'open');
      if (running) openExamDetail(running.id); else go('exams');
    };
  }

  renderHomeCurrent(d, t);
  renderHomeStats(d);
  renderHomePlan(d);
  renderHomeCalendar();
  renderHomeExams(d);
  renderHomeBoard(d);
  wireHomePrint(d, t);
}

/* ---------------------------------------------- مرحله‌ی جاری + شمارش معکوس */
/* ------------------------------------- کارت وضعیت آزمون‌ها (چند آزمون همزمان) */
const EXAM_STATE_UI = {
  before: {
    badge: '🔒 قفل',
    tagCls: 'tag b',
    title: 'این آزمون قفله 🔒',
    cdLabel: 'تا شروع آزمون',
    btn: null,
  },
  open: {
    badge: 'در حال برگزاری',
    tagCls: 'tag g12 solid',
    title: 'مهلت ارسال پاسخ‌نامه',
    cdLabel: 'تا پایان مهلت آزمون',
    btn: { label: 'ورود به آزمون', cls: 'btn dark', act: 'enter' },
  },
  after: {
    badge: 'پایان‌یافته',
    tagCls: 'tag b',
    title: 'مدت زمان آزمون به اتمام رسیده ⏳',
    cdLabel: null,
    btn: { label: 'شرکت تمرینی در آزمون', cls: 'btn ghost', act: 'practice' },
  },
};

function cdUnitsHtml(show) {
  if (!show) return '';
  return '<div class="count-nums">' +
    ['d:روز', 'h:ساعت', 'm:دقیقه', 's:ثانیه'].map((x) => {
      const [k, lbl] = x.split(':');
      return '<div class="unit"><div class="u-num" data-u="' + k + '">۰</div>' +
        '<div class="u-lbl">' + lbl + '</div></div>';
    }).join('') + '</div>';
}

function examStateCardHtml(ex, i) {
  const st = ex.windowState || 'before';
  const ui = EXAM_STATE_UI[st] || EXAM_STATE_UI.before;
  const hasCd = !!ex.countdownTarget;
  const btn = ui.btn
    ? '<button class="' + ui.btn.cls + '" data-exam-act="' + ui.btn.act + '" data-exam-id="' + ex.id + '">' +
      (ui.btn.act === 'practice' ? icon('practice', { size: 15 }) + ' ' : '') + ui.btn.label + '</button>'
    : '';
  return '<div class="card tonight" data-cd-card="' + esc(ex.countdownTarget || '') + '">' +
    '<div class="th-top"><h3>' + esc(ex.title || 'آزمون') + '</h3>' +
    '<span class="' + ui.tagCls + '">' + ui.badge + '</span></div>' +
    '<div class="count-box">' +
      '<div class="small muted">' + ui.title + '</div>' +
      (hasCd ? '<div class="small muted" style="margin-top:2px;opacity:.8">' + ui.cdLabel + '</div>' : '') +
      cdUnitsHtml(hasCd) +
    '</div>' +
    '<div class="th-list">' +
      thItem('شروع', Jalali.long(ex.starts_at)) +
      thItem('مهلت ارسال', Jalali.long(ex.submission_deadline)) +
      thItem('مدت', faNum(ex.duration_minutes) + ' دقیقه') +
    '</div>' + btn +
  '</div>';
}

function thItem(k, v) {
  return '<div class="th-item">' + icon('clock', { size: 15 }) +
    '<span class="muted small">' + esc(k) + '</span><span class="spacer"></span><b>' + esc(v) + '</b></div>';
}

function renderHomeCurrent(d, t) {
  const box = document.getElementById('homeCurrentCards');
  setText('homePhasesTag', (d.phases || []).length + ' مرحله');
  setText('homeExamsTag', (d.upcomingExams || []).length + ' آزمون پیش‌رو');
  if (!box) return;

  const up = d.upcomingExams || [];
  if (!up.length) {
    box.innerHTML = '<div class="card tonight"><div class="th-top"><h3>آزمونی نیست</h3>' +
      '<span class="tag b">—</span></div>' +
      '<div class="count-box"><div class="small muted">فعلاً آزمون بازی برای پایه‌ی شما وجود ندارد</div></div></div>';
    return;
  }
  // آزمون‌های در حال برگزاری اول، بعد آن‌هایی که هنوز شروع نشده‌اند
  const order = { open: 0, before: 1, after: 2 };
  box.innerHTML = up.slice()
    .sort((a, b) => (order[a.windowState] - order[b.windowState]) ||
      new Date(a.starts_at) - new Date(b.starts_at))
    .map(examStateCardHtml).join('');

  box.querySelectorAll('[data-exam-act]').forEach((b) => {
    b.addEventListener('click', () => {
      const id = Number(b.dataset.examId);
      if (b.dataset.examAct === 'practice') openExamDetail(id, { practice: true });
      else openExamDetail(id);
    });
  });
  startHomeCountdowns();
}


let HOME_CD_TIMER = null;
let EXAM_CD_TIMER = null;
/** شمارش معکوسِ همه‌ی کارت‌های آزمون (هر تعداد که باشند) را همزمان جلو می‌برد. */
function startHomeCountdowns() {
  if (HOME_CD_TIMER) clearInterval(HOME_CD_TIMER);
  const cards = Array.from(document.querySelectorAll('[data-cd-card]'))
    .filter((c) => c.dataset.cdCard);
  if (!cards.length) return;

  const tick = () => {
    let finished = false;
    cards.forEach((card) => {
      const c = Countdown.diff(card.dataset.cdCard);
      const box = card.querySelector('.count-nums');
      if (!box) return;
      const put = (u, v) => { const el = box.querySelector('[data-u="' + u + '"]'); if (el) el.textContent = v; };
      put('d', faNum(c.d));
      put('h', faNum(String(c.h).padStart(2, '0')));
      put('m', faNum(String(c.m).padStart(2, '0')));
      put('s', faNum(String(c.s).padStart(2, '0')));
      if (c.done) finished = true;
    });
    // وقتی یکی از پنجره‌ها بسته/باز شد، صفحه را از نو بساز تا وضعیت عوض شود
    if (finished) { clearInterval(HOME_CD_TIMER); HOME = null; loadHome(); }
  };
  tick();
  HOME_CD_TIMER = setInterval(tick, 1000);
}

/* -------------------------------------------------------------- آمار */
function renderHomeStats(d) {
  const st = d.stats || {};
  const boxes = [
    ['آزمون‌های شرکت‌کرده', faNum(st.satExams || 0), 'check'],
    ['کارنامه‌های منتشرشده', faNum(st.publishedResults || 0), 'file'],
    ['غیبت‌ها', faNum(st.absentExams || 0), 'expired'],
    ['میانگین نمره', st.averageQuarters == null ? '—' : faNum(quartersToMark(st.averageQuarters)), 'chart'],
    ['بهترین نمره', st.bestQuarters == null ? '—' : faNum(quartersToMark(st.bestQuarters)), 'trophy'],
  ];
  const grid = document.getElementById('homeStatGrid');
  if (grid) {
    grid.innerHTML = boxes.map(([k, v, ic]) =>
      '<div class="sbox"><span class="s-ico">' + icon(ic, { size: 20 }) + '</span>' +
      '<div><div class="s-k">' + esc(k) + '</div><div class="s-v">' + v + '</div></div></div>').join('');
  }
}

/** کوارتر (۱ نمره = ۴ کوارتر) به رشته‌ی نمایشی با حداکثر دو رقم اعشار. */
function quartersToMark(q) {
  if (q == null) return '—';
  const whole = Math.floor(q / 4);
  const r = q % 4;
  return r === 0 ? String(whole) : (whole + (r / 4)).toFixed(2).replace(/0$/, '');
}

/* --------------------------------------------------- برنامه‌ی راهبردی */
function renderHomePlan(d) {
  const box = document.getElementById('homePlanList');
  if (!box) return;
  const phases = d.phases || [];
  if (!phases.length) {
    box.innerHTML = '<div class="empty-state card soft"><b>مرحله‌ای تعریف نشده</b>هنوز مرحله‌ای برای پایه‌ی شما ثبت نشده است.</div>';
  } else {
    box.innerHTML = phases.map(phaseCardHtml).join('');
    startPhaseCountdowns();
  }
  const body = document.getElementById('homePlanTableBody');
  if (body) {
    const rows = d.planTable && d.planTable.length ? d.planTable : phases;
    body.innerHTML = rows.map((p) => {
      const st = p.status || phaseState(p);
      const badge = st === 'open' ? '<span class="tag g12">باز</span>'
        : st === 'expired' ? '<span class="tag b">منقضی</span>'
          : '<span class="tag b">قفل</span>';
      return '<tr><td><b>' + esc(p.title) + '</b></td>' +
        '<td>' + esc(Jalali.short(p.startsAt || p.starts_at)) + ' تا ' + esc(Jalali.short(p.endsAt || p.ends_at)) + '</td>' +
        '<td>' + badge + '</td><td>' + esc(p.topicsText || '—') + '</td></tr>';
    }).join('');
  }
}

/** شمارش معکوسِ کارت‌های مرحله در بخش خانه */
let PHASE_CD_TIMER = null;
function startPhaseCountdowns() {
  if (PHASE_CD_TIMER) clearInterval(PHASE_CD_TIMER);
  PHASE_CD_TIMER = setInterval(() => {
    document.querySelectorAll('#homePlanList [data-cd]').forEach((el) => {
      const ms = Number(el.dataset.cd) - 1000;
      el.dataset.cd = String(ms);
      el.textContent = ms <= 0 ? 'زمان فرا رسید' : faNum(formatCountdown(ms));
      if (ms <= 0 && HOME) { HOME = null; clearInterval(PHASE_CD_TIMER); loadHome(); }
    });
  }, 1000);
}

function phaseState(p) {
  const now = Date.now();
  const s = new Date(p.startsAt || p.starts_at).getTime();
  const e = new Date(p.endsAt || p.ends_at).getTime();
  if (now >= e) return 'expired';
  if (now >= s) return 'open';
  return 'locked';
}

function phaseCardHtml(p) {
  const st = p.status || phaseState(p);
  const cls = st === 'open' ? ' is-open' : st === 'expired' ? ' is-expired' : '';
  const badge = st === 'open' ? '<span class="tag g12 solid">باز</span>'
    : st === 'expired' ? '<span class="tag b">منقضی</span>'
      : '<span class="tag b">قفل</span>';
  const cd = (p.countdownMs != null && st !== 'expired')
    ? '<div class="nc-countdown small muted" data-cd="' + p.countdownMs + '">' + faNum(formatCountdown(p.countdownMs)) + '</div>'
    : '';
  const topics = p.topicsText
    ? '<div class="nc-topics"><b class="small">مباحث:</b> ' + esc(p.topicsText) + '</div>' : '';
  return '<div class="night-card' + cls + '">' +
    '<div class="nc-head"><span class="nc-num">' + faNum(p.sortOrder || p.sort_order || '') + '</span>' +
    '<div><div class="nc-title">' + esc(p.title) + '</div>' +
    '<div class="nc-meta">' + esc(Jalali.short(p.startsAt || p.starts_at)) + ' تا ' + esc(Jalali.short(p.endsAt || p.ends_at)) + '</div></div></div>' +
    '<div>' + badge + '</div>' + cd + topics +
    (p.examId ? '<div class="nc-actions"><button class="btn sm" data-open-exam="' + p.examId + '">' +
      icon('play', { size: 15 }) + 'ورود به آزمون</button></div>' : '') +
    '</div>';
}

/* --------------------------------------------------------- تقویم شمسی */
async function renderHomeCalendar() {
  const box = document.getElementById('homeCalBody');
  if (!box) return;
  if (!CAL) { box.innerHTML = ''; return; }
  box.innerHTML = '<div class="skeleton" style="height:200px"></div>';
  try {
    const r = await API.get('/api/student/calendar?jy=' + CAL.jy + '&jm=' + CAL.jm);
    box.innerHTML = calendarHtml(r.calendar);
  } catch (e) {
    box.innerHTML = '<div class="empty-state card soft">' + esc(e.message) + '</div>';
  }
}

function calendarHtml(cal) {
  const week = Jalali.WEEKDAYS_FA.map((w) => '<div>' + esc(w) + '</div>').join('');
  const cells = (cal.days || []).map((d, i) => {
    if (!d) return '<div class="cal-cell empty"></div>';
    const isToday = cal.today && cal.today.jy === cal.jy && cal.today.jm === cal.jm && cal.today.jd === d.day;
    const has = d.exams && d.exams.length;
    return '<div class="cal-cell' + (isToday ? ' today' : '') + (has ? ' exam' : '') + '"' +
      (has ? ' data-cal-exam="' + d.exams[0].id + '"' : '') + '>' +
      '<span class="d">' + faNum(d.day) + '</span>' +
      (has ? '<span class="badge">' + faNum(d.exams.length) + ' آزمون</span>' : '') +
      (isToday ? '<span class="today-tag">امروز</span>' : '') +
      '</div>';
  }).join('');
  return '<div class="cal-wrap">' +
    '<div class="cal-head">' +
      '<button class="btn ghost sm" data-cal-shift="-1">' + icon('chevron', { size: 15, cls: 'flip' }) + ' ماه قبل</button>' +
      '<span class="cal-month">' + esc(cal.monthName) + ' ' + faNum(cal.jy) + '</span>' +
      '<button class="btn ghost sm" data-cal-shift="1">ماه بعد ' + icon('chevron', { size: 15 }) + '</button>' +
    '</div>' +
    '<div class="cal-dow">' + week + '</div>' +
    '<div class="cal-grid">' + cells + '</div>' +
    '<div class="cal-legend">' +
      '<span><i style="background:#F1FBF4;border:1.5px solid var(--p11)"></i>روز آزمون</span>' +
      '<span><i style="background:#fff;border:2.5px solid #E0512F"></i>امروز</span>' +
      '<span class="spacer"></span>' +
      '<span class="small muted">امروز: ' + esc(HOME && HOME.jalaliToday ? HOME.jalaliToday.weekday + ' ' + faNum(HOME.jalaliToday.jd) + ' ' + HOME.jalaliToday.monthName : '') + '</span>' +
    '</div></div>';
}

/* --------------------------------------------------- آزمون‌های پیش‌رو */
function renderHomeExams(d) {
  const grid = document.getElementById('homeExamGrid');
  const expWrap = document.getElementById('homeExpiredWrap');
  const expGrid = document.getElementById('homeExpiredGrid');
  if (grid) {
    const up = d.upcomingExams || [];
    grid.innerHTML = up.length
      ? up.map(homeExamCardHtml).join('')
      : '<div class="empty-state card soft"><b>آزمون بازی نداری</b>وقتی آزمونی برای پایه‌ی تو منتشر شود، اینجا ظاهر می‌شود.</div>';
    wireExamCards(grid);
    startWindowCountdowns();
  }
  if (expWrap && expGrid) {
    const gone = d.expiredExams || [];
    expWrap.classList.toggle('hidden', !gone.length);
    expGrid.innerHTML = gone.map(homeExamCardHtml).join('');
    wireExamCards(expGrid);
  }
}

function homeExamCardHtml(ex) {
  const st = ex.windowState || 'before';
  const ui = EXAM_STATE_UI[st] || EXAM_STATE_UI.before;
  const cls = st === 'open' ? ' is-open' : st === 'after' ? ' is-expired' : ' is-locked';

  const cd = ex.countdownTarget
    ? '<div class="nc-countdown small muted" data-win="' + esc(ex.countdownTarget) + '"></div>'
    : '';

  // پیش از شروع: دکمه‌ی ورودی وجود ندارد (آزمون قفل است)
  const act = ui.btn
    ? '<button class="btn sm' + (ui.btn.act === 'practice' ? ' ghost' : '') + '" ' +
      'data-exam-act="' + ui.btn.act + '" data-exam-id="' + ex.id + '">' +
      (ui.btn.act === 'practice' ? icon('practice', { size: 15 }) + ' ' : icon('play', { size: 15 })) +
      ui.btn.label + '</button>'
    : '';

  return '<div class="night-card' + cls + '">' +
    '<div class="nc-head"><span class="nc-num">' + icon('exam', { size: 18 }) + '</span>' +
    '<div><div class="nc-title">' + esc(ex.title) + '</div>' +
    '<div class="nc-meta">' + esc(Jalali.long(ex.starts_at)) + '</div></div></div>' +
    '<div><span class="' + ui.tagCls + '">' + ui.badge + '</span></div>' +
    (st === 'after' ? '' : cd) +
    '<div class="nc-meta">' + ui.title + '</div>' +
    '<div class="nc-meta">مهلت ارسال: ' + esc(Jalali.long(ex.submission_deadline)) + '</div>' +
    '<div class="nc-actions">' + act + '</div></div>';
}

/** وصل کردنِ دکمه‌های «ورود به آزمون» / «شرکت تمرینی» روی کارت‌ها. */
function wireExamCards(root) {
  if (!root) return;
  root.querySelectorAll('[data-exam-act]').forEach((b) => {
    b.addEventListener('click', () => {
      const id = Number(b.dataset.examId);
      if (b.dataset.examAct === 'practice') openExamDetail(id, { practice: true });
      else openExamDetail(id);
    });
  });
}

let WIN_TIMER = null;
function startWindowCountdowns() {
  if (WIN_TIMER) clearInterval(WIN_TIMER);
  WIN_TIMER = setInterval(() => {
    document.querySelectorAll('[data-win]').forEach((el) => {
      const t = el.dataset.win;
      const c = Countdown.diff(t);
      el.textContent = c.done ? 'زمان به پایان رسید' : Countdown.format(t) + ' باقی‌مانده';
      if (c.done && HOME) { HOME = null; clearInterval(WIN_TIMER); loadHome(); }
    });
  }, 1000);
}

/* ------------------------------------------------------------ رتبه‌بندی */
function renderHomeBoard(d) {
  const box = document.getElementById('homeBoardBody');
  if (!box) return;
  const lb = d.leaderboard || {};
  if (!lb.rows || !lb.rows.length) {
    box.innerHTML = '<div class="empty-state card soft"><b>هنوز رتبه‌ای ثبت نشده</b>' +
      'وقتی نتایج یک آزمون منتشر شود، برترین‌ها اینجا می‌آیند.</div>';
    return;
  }
  const head = lb.exam ? '<div class="card soft" style="margin-bottom:12px">' +
    icon('trophy', { size: 18 }) + ' <b>' + esc(lb.exam.title) + '</b>' +
    (lb.excluded ? ' <span class="small muted">(' + faNum(lb.excluded.absent || 0) + ' غایب)</span>' : '') + '</div>' : '';
  box.innerHTML = head + '<div class="top-list">' + lb.rows.map((r) =>
    '<div class="top-row' + (r.medal ? ' gold' : '') + (r.isMe ? ' me' : '') + '">' +
    '<span class="top-medal">' + (r.medal || faNum(r.rank)) + '</span>' +
    '<span class="top-name">' + esc(r.fullName || '—') + (r.isMe ? ' <span class="small muted">(شما)</span>' : '') + '</span>' +
    '<span class="top-score">' + faNum(r.totalMark) + '</span></div>').join('') + '</div>';
}

function setText(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val == null ? '' : String(val);
}

/* ------------------------------------------------------------------ چاپ */
function wireHomePrint(d, t) {
  const planBtn = document.getElementById('homePrintPlanBtn');
  const tableBtn = document.getElementById('homePrintPlanTableBtn');
  const toggle = document.getElementById('homeTableToggle');
  const tableView = document.getElementById('homeTableView');

  if (toggle && tableView) {
    toggle.onclick = () => {
      tableView.classList.toggle('hidden');
      toggle.textContent = tableView.classList.contains('hidden') ? 'نمای جدولی (مثل PDF)' : 'بستن نمای جدولی';
    };
  }
  const rows = (d.planTable && d.planTable.length ? d.planTable : d.phases || []);
  const doPrint = () => Print.planTable(rows.map((p) => ({
    title: p.title,
    startsAt: p.startsAt || p.starts_at,
    endsAt: p.endsAt || p.ends_at,
    status: p.status || phaseState(p),
    topicsText: p.topicsText,
  })), { headerLine: t.print_header_line, title: t.plan_title });
  if (planBtn) planBtn.onclick = doPrint;
  if (tableBtn) tableBtn.onclick = doPrint;
}

/* رویدادهای کلیِ بخشِ خانه */
document.addEventListener('click', (e) => {
  const open = e.target.closest('[data-open-exam]');
  if (open) { openExamRespectingWindow(Number(open.dataset.openExam)); return; }

  const calExam = e.target.closest('[data-cal-exam]');
  if (calExam) { openExamRespectingWindow(Number(calExam.dataset.calExam)); return; }

  const shift = e.target.closest('[data-cal-shift]');
  if (shift && CAL) {
    CAL = Jalali.g2j ? shiftJalaliMonth(CAL, Number(shift.dataset.calShift)) : CAL;
    renderHomeCalendar();
  }
});

function shiftJalaliMonth(c, delta) {
  let y = c.jy;
  let m = c.jm + delta;
  while (m < 1) { m += 12; y -= 1; }
  while (m > 12) { m -= 12; y += 1; }
  return { jy: y, jm: m };
}

boot();
