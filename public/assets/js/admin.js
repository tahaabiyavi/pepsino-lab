
let META = { grades: [], fields: [] };

async function boot() {
  const subj = await Auth.requireRole('admin');
  if (!subj) return;
  document.getElementById('logoutBtn').addEventListener('click', Auth.logout);
  const mob = document.getElementById('logoutBtnMobile');
  if (mob) mob.addEventListener('click', Auth.logout);
  try { META = await API.get('/api/meta/options'); } catch (e) {}
  fillGradeSelects();
  wirePanelNav();
  loadRegistrations('pending');
}

function wirePanelNav() {
  document.querySelectorAll('.anav').forEach((b) => b.addEventListener('click', () => showPanel(b.dataset.panel)));
}
function showPanel(name) {
  document.querySelectorAll('.anav').forEach((b) => b.classList.toggle('active', b.dataset.panel === name));
  document.querySelectorAll('.panel[id^="panel-"]').forEach((p) => p.classList.toggle('hidden', p.id !== 'panel-' + name));
  document.getElementById('examDetailPanel').classList.add('hidden');
  const loaders = {
    registrations: () => loadRegistrations('pending'),
    students: loadStudents, graders: loadGraders, exams: loadExams,
    appeals: () => loadAppealsAdmin('open'), rankings: loadRankingsAdmin, practice: loadPractice,
    outbox: loadOutbox, audit: loadAudit,
    strategic: loadStrategicAdmin,
    settings: () => { loadSettingsAdmin(); loadExpiredExamsAdmin(); },
  };
  if (loaders[name]) loaders[name]();
}

function fillGradeSelects() {
  const opts = META.grades.map((g) => `<option value="${g.code}">${esc(g.label)}</option>`).join('');
  ['arkGradeCode', 'arkSubjGrade'].forEach((id) => { const el = document.getElementById(id); if (el) el.innerHTML = opts; });
}

/* ===================== REGISTRATIONS ===================== */
document.querySelectorAll('[data-rstatus]').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('[data-rstatus]').forEach((x) => x.classList.remove('on'));
  b.classList.add('on');
  loadRegistrations(b.dataset.rstatus);
}));

async function loadRegistrations(status) {
  const box = document.getElementById('regList');
  box.innerHTML = '<div class="skeleton" style="height:60px"></div>';
  try {
    const r = await API.get(`/api/admin/registrations?status=${status}`);
    box.innerHTML = r.registrations.map((x) => `
      <div class="card soft">
        <div class="row wrap-r">
          <b>${esc(x.full_name)}</b><span class="tag">${esc(x.username)}</span>
          <span class="tag g10">${esc(x.grade)}</span><span class="tag">${esc(x.field)}</span>
          <span class="spacer"></span><span class="small muted">${fmtDateTime(x.created_at)}</span>
        </div>
        ${status === 'pending' ? `
        <div class="row" style="margin-top:10px">
          <button class="btn sm" data-accept="${x.id}">تأیید</button>
          <button class="btn sm danger" data-reject="${x.id}">رد</button>
        </div>` : `<p class="small muted" style="margin-top:6px">تصمیم: ${esc(faStatus(x.status))} — ${fmtDateTime(x.decided_at)}</p>`}
      </div>`).join('') || '<div class="empty-state card soft"><b>موردی نیست</b></div>';
    box.querySelectorAll('[data-accept]').forEach((b) => b.addEventListener('click', () => decideRegistration(b.dataset.accept, 'accept')));
    box.querySelectorAll('[data-reject]').forEach((b) => b.addEventListener('click', () => decideRegistration(b.dataset.reject, 'reject')));
  } catch (e) { box.innerHTML = `<p class="muted">${esc(e.message)}</p>`; }
}
async function decideRegistration(id, action) {
  if (action === 'reject') { const ok = await confirmModal({ title: 'رد درخواست', danger: true, okText: 'رد درخواست' }); if (!ok) return; }
  try {
    await API.post(`/api/admin/registrations/${id}/decision`, { action });
    Toast.show('ثبت شد', 'good');
    loadRegistrations(document.querySelector('[data-rstatus].on').dataset.rstatus);
  } catch (e) { Toast.show(e.message, 'bad'); }
}

/* ===================== STUDENTS ===================== */
async function loadStudents() {
  const tbody = document.querySelector('#studentsTable tbody');
  tbody.innerHTML = '<tr><td colspan="6" class="muted">در حال بارگذاری…</td></tr>';
  try {
    const r = await API.get('/api/admin/students');
    tbody.innerHTML = r.students.map((s) => `
      <tr>
        <td>${esc(s.full_name)}</td><td>${esc(s.username)}</td><td>${esc(s.grade)}</td><td>${esc(s.field)}</td>
        <td><span class="tag ${s.status === 'active' ? 'good' : 'bad'}">${esc(faStatus(s.status))}</span></td>
        <td class="row" style="gap:6px">
          <button class="btn sm ghost" data-edit="${s.id}" data-name="${esc(s.full_name)}">ویرایش</button>
          <button class="btn sm ghost" data-toggle="${s.id}" data-status="${s.status}">${s.status === 'active' ? 'غیرفعال‌سازی' : 'فعال‌سازی'}</button>
          <button class="btn sm ghost" data-reset="${s.id}">بازیابی رمز</button>
        </td>
      </tr>`).join('') || '<tr><td colspan="6" class="muted">دانش‌آموزی نیست</td></tr>';
    tbody.querySelectorAll('[data-toggle]').forEach((b) => b.addEventListener('click', async () => {
      const next = b.dataset.status === 'active' ? 'disabled' : 'active';
      try { await API.post(`/api/admin/students/${b.dataset.toggle}/status`, { status: next }); loadStudents(); }
      catch (e) { Toast.show(e.message, 'bad'); }
    }));
    tbody.querySelectorAll('[data-reset]').forEach((b) => b.addEventListener('click', async () => {
      try {
        const out = await API.post(`/api/admin/students/${b.dataset.reset}/password-reset`, {});
        await confirmModal({ title: 'کد بازیابی یک‌بارمصرف', body: `کد: ${out.token}\nاین کد فقط یک‌بار قابل استفاده است و تا ${fmtDateTime(out.expiresAt)} معتبر است.`, okText: 'باشه', cancelText: 'بستن' });
      } catch (e) { Toast.show(e.message, 'bad'); }
    }));
    tbody.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', async () => {
      const out = await formModal({
        title: 'ویرایش دانش‌آموز',
        okText: 'ذخیره',
        fieldsHtml: `
          <div class="field"><label>نام و نام خانوادگی</label><input class="inp" name="fullName" value="${b.dataset.name}" required minlength="3" maxlength="100"></div>
          <div class="field"><label>پایه (اختیاری — خالی بگذارید اگر تغییری نیست)</label><select class="inp" name="gradeCode"><option value="">—</option>${META.grades.map((g) => `<option value="${g.code}">${esc(g.label)}</option>`).join('')}</select></div>
          <div class="field"><label>رشته (اختیاری — خالی بگذارید اگر تغییری نیست)</label><select class="inp" name="fieldCode"><option value="">—</option>${META.fields.map((f) => `<option value="${f.code}">${esc(f.label)}</option>`).join('')}</select></div>`,
        onSubmit: async (obj) => {
          const payload = { fullName: obj.fullName };
          if (obj.gradeCode) payload.gradeCode = obj.gradeCode;
          if (obj.fieldCode) payload.fieldCode = obj.fieldCode;
          await API.patch(`/api/admin/students/${b.dataset.edit}`, payload);
        },
      });
      if (out) { Toast.show('ذخیره شد', 'good'); loadStudents(); }
    }));
  } catch (e) { tbody.innerHTML = `<tr><td colspan="6">${esc(e.message)}</td></tr>`; }
}

/* ===================== GRADERS ===================== */
async function loadGraders() {
  const tbody = document.querySelector('#gradersTable tbody');
  tbody.innerHTML = '<tr><td colspan="5" class="muted">در حال بارگذاری…</td></tr>';
  try {
    const r = await API.get('/api/admin/graders');
    tbody.innerHTML = r.graders.map((g) => `
      <tr>
        <td>${esc(g.icon || '')} ${esc(g.display_name)}</td><td>${esc(g.username || '—')}</td>
        <td><span class="tag ${g.active ? 'good' : 'bad'}">${g.active ? 'فعال' : 'غیرفعال'}</span></td>
        <td class="small">باز: ${faNum(g.open_count || 0)} / تمام: ${faNum(g.completed_count || 0)}</td>
        <td class="row" style="gap:6px">
          <button class="btn sm ghost" data-gtoggle="${g.id}" data-active="${g.active}">${g.active ? 'غیرفعال‌سازی' : 'فعال‌سازی'}</button>
          <button class="btn sm ghost" data-greset="${g.id}">بازیابی رمز</button>
        </td>
      </tr>`).join('') || '<tr><td colspan="5" class="muted">تصحیح‌کننده‌ای نیست</td></tr>';
    tbody.querySelectorAll('[data-gtoggle]').forEach((b) => b.addEventListener('click', async () => {
      const active = b.dataset.active === '1' || b.dataset.active === 'true';
      try { await API.post(`/api/admin/graders/${b.dataset.gtoggle}/active`, { active: !active }); loadGraders(); }
      catch (e) { Toast.show(e.message, 'bad'); }
    }));
    tbody.querySelectorAll('[data-greset]').forEach((b) => b.addEventListener('click', async () => {
      try {
        const out = await API.post(`/api/admin/graders/${b.dataset.greset}/password-reset`, {});
        await confirmModal({ title: 'کد بازیابی یک‌بارمصرف', body: `کد: ${out.token}\nتا ${fmtDateTime(out.expiresAt)} معتبر است.`, okText: 'باشه', cancelText: 'بستن' });
      } catch (e) { Toast.show(e.message, 'bad'); }
    }));
  } catch (e) { tbody.innerHTML = `<tr><td colspan="5">${esc(e.message)}</td></tr>`; }
}

document.getElementById('newGraderBtn').addEventListener('click', async () => {
  const out = await formModal({
    title: 'تصحیح‌کنندهٔ جدید',
    fieldsHtml: `
      <div class="field"><label>نام نمایشی</label><input class="inp" name="displayName" required></div>
      <div class="field"><label>نام کاربری</label><input class="inp" name="username" required pattern="[a-z0-9_]{3,32}"></div>
      <div class="field"><label>رمز عبور</label><input class="inp" type="password" name="password" required></div>
      <div class="field"><label>آیکون (اختیاری)</label><input class="inp" name="icon" maxlength="8" placeholder="🧑‍🏫"></div>`,
    okText: 'ایجاد',
    onSubmit: async (obj) => { await API.post('/api/admin/graders', obj); },
  });
  if (out) { Toast.show('ایجاد شد', 'good'); loadGraders(); }
});

/* ===================== EXAMS ===================== */
async function loadExams() {
  const tbody = document.querySelector('#examsTable tbody');
  tbody.innerHTML = '<tr><td colspan="5" class="muted">در حال بارگذاری…</td></tr>';
  try {
    const r = await API.get('/api/admin/exams');
    tbody.innerHTML = r.exams.map((e) => `
      <tr>
        <td>${esc(e.title)}</td><td><span class="tag">${esc(faStatus(e.status))}</span></td>
        <td class="small">${fmtDateTime(e.starts_at)}</td><td class="small">${fmtDateTime(e.submission_deadline)}</td>
        <td class="row" style="gap:6px">
          <button class="btn sm" data-examopen="${e.id}">مدیریت</button>
          <button class="btn sm ghost" data-print-participants="${e.id}" title="چاپ فهرست شرکت‌کنندگان">🖨</button>
        </td>
      </tr>`).join('') || '<tr><td colspan="5" class="muted">آزمونی نیست</td></tr>';
    tbody.querySelectorAll('[data-examopen]').forEach((b) => b.addEventListener('click', () => openExamDetail(Number(b.dataset.examopen))));
    tbody.querySelectorAll('[data-print-participants]').forEach((b) => b.addEventListener('click', () => printParticipants(Number(b.dataset.printParticipants))));
  } catch (e) { tbody.innerHTML = `<tr><td colspan="5">${esc(e.message)}</td></tr>`; }
}

document.getElementById('newExamBtn').addEventListener('click', async () => {
  const gradeChks = META.grades.map((g) => `<label class="chk"><input type="checkbox" name="gradeCodes" value="${g.code}">${esc(g.label)}</label>`).join('');
  const fieldChks = META.fields.map((f) => `<label class="chk"><input type="checkbox" name="fieldCodes" value="${f.code}">${esc(f.label)}</label>`).join('');
  const out = await formModal({
    title: 'آزمون جدید',
    okText: 'ایجاد آزمون (پیش‌نویس)',
    fieldsHtml: `
      <div class="field"><label>عنوان</label><input class="inp" name="title" required minlength="3" maxlength="150"></div>
      <div class="grid-2">
        <div class="field"><label>مدت (دقیقه)</label><input class="inp" type="number" name="durationMinutes" min="5" max="300" required></div>
        <div class="field"><label>سال تحصیلی</label><select class="inp" name="academicYearId" required>${(META.academicYears||[]).map((y)=>`<option value="${y.id}">${esc(y.label)}</option>`).join('')}</select></div>
      </div>
      <div class="field"><label>پایه‌های مجاز</label><div class="chk-row">${gradeChks}</div></div>
      <div class="field"><label>رشته‌های مجاز (اختیاری — خالی یعنی همه)</label><div class="chk-row">${fieldChks}</div></div>
      <div class="field"><label>درس‌ها (اختیاری)</label><div class="chk-row">${(META.subjects||[]).map((s)=>`<label class="chk"><input type="checkbox" name="subjectIds" value="${s.id}">${esc(s.label)}</label>`).join('')}</div></div>
      <div class="field"><label>زمان شروع</label><input class="inp" type="datetime-local" name="startsAt" required></div>
      <div class="field"><label>مهلت ارسال پاسخ</label><input class="inp" type="datetime-local" name="submissionDeadline" required></div>
      <div class="field"><label>زمان انتشار پاسخنامه</label><input class="inp" type="datetime-local" name="answerKeyPublishAt" required></div>
      <div class="field"><label>زمان انتشار نتایج</label><input class="inp" type="datetime-local" name="resultsPublishAt" required></div>
      <div class="field"><label>توضیحات (اختیاری)</label><textarea class="inp" name="instructions"></textarea></div>
      <p class="small muted">پس از ایجاد، فایل واحد سؤالات و پاسخنامه رسمی را در جزئیات آزمون بارگذاری کنید.</p>
    `,
    onSubmit: async (obj, form) => {
      const gradeCodes = [...form.querySelectorAll('[name="gradeCodes"]:checked')].map((x) => x.value);
      const fieldCodes = [...form.querySelectorAll('[name="fieldCodes"]:checked')].map((x) => x.value);
      const subjectIds = [...form.querySelectorAll('[name="subjectIds"]:checked')].map((x) => Number(x.value));
      await API.post('/api/admin/exams', {
        title: obj.title, durationMinutes: Number(obj.durationMinutes), academicYearId: Number(obj.academicYearId),
        gradeCodes, fieldCodes, subjectIds,
        startsAt: new Date(obj.startsAt).toISOString(), submissionDeadline: new Date(obj.submissionDeadline).toISOString(),
        answerKeyPublishAt: new Date(obj.answerKeyPublishAt).toISOString(), resultsPublishAt: new Date(obj.resultsPublishAt).toISOString(),
        instructions: obj.instructions || undefined,
      });
    },
  });
  if (out) { Toast.show('آزمون ایجاد شد', 'good'); loadExams(); }
});

async function openExamDetail(examId) {
  const panel = document.getElementById('examDetailPanel');
  document.querySelectorAll('.panel[id^="panel-"]').forEach((p) => p.classList.add('hidden'));
  panel.classList.remove('hidden');
  panel.innerHTML = '<div class="skeleton" style="height:240px"></div>';
  panel.scrollIntoView({ behavior: 'smooth' });
  try {
    const r = await API.get(`/api/admin/exams/${examId}`);
    renderExamDetail(r, examId);
  } catch (e) { panel.innerHTML = `<p class="muted">${esc(e.message)}</p>`; }
}

function renderExamDetail(data, examId) {
  const { exam, questions, hasAnswerKey, publicationProblems } = data;
  const panel = document.getElementById('examDetailPanel');
  const TRANSITIONS = {
    draft: ['published'], published: ['in_progress', 'submission_closed'], in_progress: ['submission_closed'],
    submission_closed: ['grading'], grading: ['results_published'], results_published: ['archived'], archived: [],
  };
  const next = TRANSITIONS[exam.status] || [];

  panel.innerHTML = `
    <div class="row wrap-r">
      <h3>${esc(exam.title)}</h3><span class="tag">${esc(faStatus(exam.status))}</span>
      <span class="spacer"></span>
      ${exam.status !== 'archived' ? `
        <button class="btn sm ghost" id="editExamBtn">✏️ ویرایش عنوان و مدت</button>
        <button class="btn sm danger" id="deleteExamBtn">🗑 حذف آزمون</button>` : ''}
      <button class="btn sm ghost" id="backToExams">← بستن</button>
    </div>

    ${publicationProblems.length ? `<div class="badge-lock" style="margin-top:12px">موارد ناقص برای انتشار: ${publicationProblems.map((p) => esc(p.message)).join('، ')}</div>` : ''}

    <div class="row wrap-r" style="margin-top:14px">
      ${next.map((to) => `<button class="btn sm" data-transition="${to}">تغییر وضعیت به: ${esc(faStatus(to))}</button>`).join('')}
      ${exam.status === 'submission_closed' || exam.status === 'grading' ? `<button class="btn sm ghost" id="distributeBtn">توزیع برگه‌ها بین تصحیح‌کنندگان</button>` : ''}
    </div>

    <div class="grid-2" style="margin-top:20px">
      <div class="panel soft">
        <h3>زمان‌بندی</h3>
        <div class="field small"><label>شروع</label><span>${fmtDateTime(exam.starts_at)}</span></div>
        <div class="field small"><label>مهلت ارسال</label><span>${fmtDateTime(exam.submission_deadline)}</span></div>
        <div class="field small"><label>انتشار پاسخنامه</label><span>${fmtDateTime(exam.answer_key_publish_at)}</span></div>
        <div class="field small"><label>انتشار نتایج</label><span>${fmtDateTime(exam.results_publish_at)}</span></div>
        <div class="field small"><label>مدت آزمون</label><span>${faNum(exam.duration_minutes)} دقیقه</span></div>
        <button class="btn sm ghost" id="editScheduleBtn">ویرایش زمان‌بندی</button>
      </div>
      <div class="panel soft">
        <h3>پاسخنامهٔ رسمی</h3>
        <p class="small muted">${hasAnswerKey ? 'پاسخنامه بارگذاری شده است.' : 'هنوز بارگذاری نشده است.'}</p>
        ${!exam.answer_key_published_at ? `
          <input type="file" id="akFile" accept="application/pdf,image/*">
          <button class="btn sm primary" id="akUploadBtn" style="margin-top:8px">بارگذاری / جایگزینی</button>
        ` : `<span class="tag good">منتشرشده — دیگر قابل تغییر نیست</span>`}
      </div>
    </div>

    <div class="panel soft" style="margin-top:16px">
      <h3>فایل سؤالات کامل آزمون</h3>
      <p class="hint">یک فایل واحد (PDF یا تصویر) حاوی تمام سؤالات. بارم داخل خود فایل نوشته شده است.</p>
      ${data.hasQuestionsFile ? `<p class="small">فایل فعلی: <b>${esc(data.questionsFile.original_name)}</b> (${fmtBytes(data.questionsFile.size_bytes)})</p>
        <a class="btn sm ghost" href="/api/admin/exams/${examId}/questions-file" target="_blank">مشاهده فایل سؤالات</a>` : '<p class="small muted">هنوز فایل سؤالات بارگذاری نشده.</p>'}
      ${exam.status === 'draft' || exam.status === 'published' ? `
        <div class="field" style="margin-top:10px">
          <label>تعداد سؤالات (برای تصحیح — هر سؤال حداکثر ۲ نمره)</label>
          <input class="inp" type="number" id="qCountInput" min="1" max="100" value="${exam.question_count || questions.length || 10}">
        </div>
        <input type="file" id="qfFile" accept="application/pdf,image/*">
        <button class="btn sm primary" id="qfUploadBtn" style="margin-top:8px">بارگذاری / جایگزینی فایل سؤالات</button>
      ` : ''}
      ${questions.length ? `<p class="small muted" style="margin-top:8px">${faNum(questions.length)} سؤال برای تصحیح تعریف شده (هر کدام حداکثر ۲ نمره).</p>` : ''}
    </div>

    <div class="panel soft" style="margin-top:16px">
      <h3>🎧 فایل صوتیِ لیسنینگ (ویژهٔ زبان انگلیسی)</h3>
      ${data.hasEnglish ? `
        <p class="hint">فایل صوتیِ بخشِ لیسنینگ. دانش‌آموز هنگامِ آزمون آن را در همان صفحه پخش می‌کند.</p>
        ${data.hasAudioFile
    ? `<p class="small">فایل فعلی: <b>${esc(data.audioFile.original_name)}</b> (${fmtBytes(data.audioFile.size_bytes)})</p>
             <audio controls preload="metadata" src="/api/admin/exams/${examId}/audio" style="width:100%;margin:8px 0"></audio>
             <div class="row wrap-r">
               <a class="btn sm ghost" href="/api/admin/exams/${examId}/audio" target="_blank">دانلود</a>
               ${exam.status !== 'archived' ? '<button class="btn sm danger" id="audioDelBtn">حذف فایل صوتی</button>' : ''}
             </div>`
    : '<p class="small muted">هنوز فایل صوتی بارگذاری نشده است.</p>'}
        ${exam.status !== 'archived' ? `
          <div class="field" style="margin-top:10px">
            <label>${data.hasAudioFile ? 'جایگزینی فایل صوتی' : 'انتخاب فایل صوتی'} (MP3، M4A، OGG یا WAV — حداکثر ۲۰ مگابایت)</label>
            <input type="file" id="audioFile" accept="audio/*,.mp3,.m4a,.aac,.ogg,.oga,.opus,.wav,.weba">
          </div>
          <button class="btn sm primary" id="audioUploadBtn" style="margin-top:8px">بارگذاری فایل صوتی</button>
        ` : ''}
      ` : `
        <p class="small muted">این آزمون درسِ «زبان انگلیسی» ندارد، پس بخشِ لیسنینگ برایش معنا ندارد.</p>
        <p class="small muted">درس‌های این آزمون: ${(data.subjects || []).map((s) => esc(s.label)).join('، ') || '—'}</p>
      `}
    </div>

    <div class="panel soft" style="margin-top:16px">
      <h3>وضعیت دانش‌آموزان</h3>
      <button class="btn sm ghost" id="markAbsentBtn">ثبت غیبت دانش‌آموز</button>
    </div>

    <div class="grid-2" style="margin-top:16px">
      <div class="panel soft">
        <h3>واگذاری مجدد برگه</h3>
        <p class="hint">برگهٔ باز یک پاسخ را به تصحیح‌کنندهٔ دیگری منتقل می‌کند.</p>
        <button class="btn sm ghost" id="reassignBtn">واگذاری مجدد</button>
      </div>
      <div class="panel soft">
        <h3>اصلاح نمرهٔ یک سؤال</h3>
        <p class="hint">فقط برای برگه‌های نهایی‌شده؛ تاریخچهٔ اصلاح ثبت می‌شود.</p>
        <button class="btn sm ghost" id="correctBtn">اصلاح نمره</button>
      </div>
    </div>
  `;

  document.getElementById('backToExams').addEventListener('click', () => { panel.classList.add('hidden'); showPanel('exams'); });

  panel.querySelectorAll('[data-transition]').forEach((b) => b.addEventListener('click', async () => {
    const to = b.dataset.transition;
    const ok = await confirmModal({ title: 'تغییر وضعیت آزمون', body: `وضعیت به «${faStatus(to)}» تغییر کند؟`, okText: 'تأیید' });
    if (!ok) return;
    try { await API.post(`/api/admin/exams/${examId}/transition`, { to }); Toast.show('انجام شد', 'good'); openExamDetail(examId); }
    catch (e) {
      const details = e.details && e.details.problems ? ' — ' + e.details.problems.map((p) => p.message).join('، ') : '';
      Toast.show((e.message || 'خطا') + details, 'bad');
    }
  }));

  const distBtn = document.getElementById('distributeBtn');
  if (distBtn) distBtn.addEventListener('click', async () => {
    try { const r = await API.post(`/api/admin/exams/${examId}/distribute`, {}); Toast.show(`${faNum(r.created)} برگه توزیع شد`, 'good'); }
    catch (e) { Toast.show(e.message, 'bad'); }
  });

  const akBtn = document.getElementById('akUploadBtn');
  if (akBtn) akBtn.addEventListener('click', async () => {
    const file = document.getElementById('akFile').files[0];
    if (!file) { Toast.show('فایل را انتخاب کنید', 'bad'); return; }
    const fd = new FormData(); fd.append('file', file);
    try { await API.post(`/api/admin/exams/${examId}/answer-key`, fd); Toast.show('بارگذاری شد', 'good'); openExamDetail(examId); }
    catch (e) { Toast.show(e.message, 'bad'); }
  });

  document.getElementById('editScheduleBtn').addEventListener('click', async () => {
    const toLocal = (iso) => iso ? new Date(iso).toISOString().slice(0, 16) : '';
    const out = await formModal({
      title: 'ویرایش زمان‌بندی',
      okText: 'ذخیره',
      fieldsHtml: `
        <div class="field"><label>شروع</label><input class="inp" type="datetime-local" name="startsAt" value="${toLocal(exam.starts_at)}" required></div>
        <div class="field"><label>مهلت ارسال</label><input class="inp" type="datetime-local" name="submissionDeadline" value="${toLocal(exam.submission_deadline)}" required></div>
        <div class="field"><label>انتشار پاسخنامه</label><input class="inp" type="datetime-local" name="answerKeyPublishAt" value="${toLocal(exam.answer_key_publish_at)}" required></div>
        <div class="field"><label>انتشار نتایج</label><input class="inp" type="datetime-local" name="resultsPublishAt" value="${toLocal(exam.results_publish_at)}" required></div>`,
      onSubmit: async (obj) => {
        await API.patch(`/api/admin/exams/${examId}/schedule`, {
          startsAt: new Date(obj.startsAt).toISOString(), submissionDeadline: new Date(obj.submissionDeadline).toISOString(),
          answerKeyPublishAt: new Date(obj.answerKeyPublishAt).toISOString(), resultsPublishAt: new Date(obj.resultsPublishAt).toISOString(),
        });
      },
    });
    if (out) { Toast.show('بروزرسانی شد', 'good'); openExamDetail(examId); }
  });

  // ---- ویرایشِ عنوان و مدت آزمون ----
  const editExamBtn = document.getElementById('editExamBtn');
  if (editExamBtn) editExamBtn.addEventListener('click', async () => {
    const out = await formModal({
      title: 'ویرایش مشخصات آزمون',
      okText: 'ذخیره تغییرات',
      fieldsHtml: `
        <div class="field"><label>عنوان آزمون</label>
          <input class="inp" type="text" name="title" value="${esc(exam.title)}" minlength="3" maxlength="150" required></div>
        <div class="field"><label>مدت آزمون (دقیقه)</label>
          <input class="inp" type="number" name="durationMinutes" value="${exam.duration_minutes}" min="5" max="300" step="1" required>
          <span class="hint">بین ۵ تا ۳۰۰ دقیقه</span></div>
        <div class="field"><label>توضیحات (اختیاری)</label>
          <textarea class="inp" name="instructions" rows="4" maxlength="5000">${esc(exam.instructions || '')}</textarea></div>`,
      onSubmit: async (obj) => {
        await API.patch(`/api/admin/exams/${examId}`, {
          title: obj.title.trim(),
          durationMinutes: Number(obj.durationMinutes),
          instructions: obj.instructions,
        });
      },
    });
    if (out) { Toast.show('آزمون ویرایش شد', 'good'); openExamDetail(examId); loadExams(); }
  });

  // ---- حذفِ آزمون (با تأییدِ دو مرحله‌ای) ----
  const deleteExamBtn = document.getElementById('deleteExamBtn');
  if (deleteExamBtn) deleteExamBtn.addEventListener('click', async () => {
    const stats = await API.get(`/api/admin/exams/${examId}`);
    const nQ = (stats.questions || []).length;
    const out = await formModal({
      title: 'حذف آزمون',
      okText: 'حذف قطعی',
      fieldsHtml: `
        <p class="hint" style="margin:0 0 12px">
          آزمون «<b>${esc(exam.title)}</b>» برای همیشه حذف می‌شود.</p>
        <ul class="small" style="margin:0 18px 14px;line-height:2">
          <li>${faNum(nQ)} سؤال</li>
          <li>پاسخ‌برگ‌ها، نمره‌ها و فایل‌های آپلود‌شده</li>
          <li>تکالیفِ تصحیح و مجموعه‌های تمرینیِ ساخته‌شده از این آزمون</li>
        </ul>
        <p class="small muted" style="margin:0 0 8px">این کار <b>قابل بازگشت نیست</b>.</p>
        <div class="field"><label>برای تأیید، عبارت «حذف» را تایپ کنید</label>
          <input class="inp" type="text" name="confirm" placeholder="حذف" autocomplete="off"></div>`,
      onSubmit: async (obj) => {
        if (String(obj.confirm || '').trim() !== 'حذف') throw new Error('برای تأیید باید عبارت «حذف» را تایپ کنید');
        await API.del(`/api/admin/exams/${examId}`);
      },
    });
    if (out) {
      Toast.show('آزمون حذف شد', 'good');
      document.getElementById('examDetailPanel').classList.add('hidden');
      loadExams();
      if (document.getElementById('panel-exams')) document.getElementById('panel-exams').classList.remove('hidden');
    }
  });

  // ---- فایل صوتیِ لیسنینگ (فقط آزمونِ زبان انگلیسی) ----
  const audioUp = document.getElementById('audioUploadBtn');
  if (audioUp) audioUp.addEventListener('click', async () => {
    const file = document.getElementById('audioFile').files[0];
    if (!file) { Toast.show('فایل صوتی را انتخاب کنید', 'bad'); return; }
    const fd = new FormData();
    fd.append('file', file);
    try {
      await API.post(`/api/admin/exams/${examId}/audio`, fd);
      Toast.show('فایل صوتی بارگذاری شد', 'good');
      openExamDetail(examId);
    } catch (e) { Toast.show(e.message, 'bad'); }
  });

  const audioDel = document.getElementById('audioDelBtn');
  if (audioDel) audioDel.addEventListener('click', async () => {
    const ok = await confirmModal({
      title: 'حذف فایل صوتی',
      body: 'فایل صوتیِ لیسنینگ از این آزمون حذف می‌شود. ادامه می‌دهید؟',
      okText: 'حذف', danger: true,
    });
    if (!ok) return;
    try {
      await API.del(`/api/admin/exams/${examId}/audio`);
      Toast.show('فایل صوتی حذف شد', 'good');
      openExamDetail(examId);
    } catch (e) { Toast.show(e.message, 'bad'); }
  });

  const qfBtn = document.getElementById('qfUploadBtn');
  if (qfBtn) qfBtn.addEventListener('click', async () => {
    const file = document.getElementById('qfFile').files[0];
    if (!file) { Toast.show('فایل سؤالات را انتخاب کنید', 'bad'); return; }
    const qCount = Number(document.getElementById('qCountInput').value) || 10;
    const fd = new FormData();
    fd.append('file', file);
    fd.append('questionCount', String(qCount));
    try {
      await API.post(`/api/admin/exams/${examId}/questions-file`, fd);
      Toast.show('فایل سؤالات بارگذاری شد', 'good');
      openExamDetail(examId);
    } catch (e) { Toast.show(e.message, 'bad'); }
  });

  document.getElementById('markAbsentBtn').addEventListener('click', async () => {
    let studentOpts = '<option value="">انتخاب کنید…</option>';
    try {
      const r = await API.get('/api/admin/students');
      studentOpts += (r.students || []).filter((s) => s.status === 'active')
        .map((s) => `<option value="${s.id}">${esc(s.full_name)} (${esc(s.username)})</option>`).join('');
    } catch (e) {}
    const out = await formModal({
      title: 'ثبت غیبت',
      okText: 'ثبت',
      fieldsHtml: `<div class="field"><label>دانش‌آموز</label><select class="inp" name="studentId" required>${studentOpts}</select></div>`,
      onSubmit: async (obj) => { await API.post(`/api/admin/exams/${examId}/absent`, { studentId: Number(obj.studentId) }); },
    });
    if (out) Toast.show('غیبت ثبت شد', 'good');
  });

  document.getElementById('reassignBtn').addEventListener('click', async () => {
    let graderOpts = '<option value="">انتخاب کنید…</option>';
    try {
      const r = await API.get('/api/admin/graders');
      graderOpts += (r.graders || []).filter((g) => g.active)
        .map((g) => `<option value="${g.id}">${esc(g.display_name)}</option>`).join('');
    } catch (e) {}
    const out = await formModal({
      title: 'واگذاری مجدد برگه',
      okText: 'واگذاری',
      fieldsHtml: `
        <div class="field"><label>شماره پرونده (submission)</label><input class="inp" type="number" name="submissionId" required></div>
        <div class="field"><label>تصحیح‌کنندهٔ مقصد</label><select class="inp" name="graderId" required>${graderOpts}</select></div>
        <div class="field"><label>دلیل (اختیاری)</label><input class="inp" name="reason" placeholder="manual"></div>`,
      onSubmit: async (obj) => {
        await API.post(`/api/admin/submissions/${obj.submissionId}/reassign`, { graderId: Number(obj.graderId), reason: obj.reason || undefined });
      },
    });
    if (out) Toast.show('واگذار شد', 'good');
  });

  document.getElementById('correctBtn').addEventListener('click', async () => {
    const out = await formModal({
      title: 'اصلاح نمرهٔ سؤال',
      okText: 'اصلاح',
      fieldsHtml: `
        <div class="field"><label>شناسهٔ ارسال (submission)</label><input class="inp" type="number" name="submissionId" required></div>
        <div class="field"><label>شناسهٔ سؤال</label><input class="inp" type="number" name="questionId" required></div>
        <div class="field"><label>نمرهٔ جدید</label><input class="inp" name="mark" placeholder="مثلاً 1.5" required></div>
        <div class="field"><label>دلیل اصلاح</label><textarea class="inp" name="reason" required minlength="3"></textarea></div>`,
      onSubmit: async (obj) => {
        await API.post(`/api/admin/submissions/${obj.submissionId}/corrections`, { questionId: Number(obj.questionId), mark: obj.mark, reason: obj.reason });
      },
    });
    if (out) Toast.show('نمره اصلاح شد', 'good');
  });
}

/* ===================== APPEALS ===================== */
document.querySelectorAll('[data-astatus]').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('[data-astatus]').forEach((x) => x.classList.remove('on'));
  b.classList.add('on');
  loadAppealsAdmin(b.dataset.astatus);
}));

async function loadAppealsAdmin(status) {
  const box = document.getElementById('appealsAdminList');
  box.innerHTML = '<div class="skeleton" style="height:60px"></div>';
  try {
    const r = await API.get(`/api/admin/appeals?status=${status}`);
    box.innerHTML = r.appeals.map((a) => `
      <div class="card soft">
        <div class="row wrap-r">
          <b>${esc(a.full_name)}</b><span class="tag">${esc(a.exam_title)}</span>
          <span class="spacer"></span><span class="small muted">${fmtDateTime(a.created_at)}</span>
        </div>
        <p class="small" style="margin-top:6px">${esc(a.reason)}</p>
        ${status === 'open' ? `<button class="btn sm" data-decide="${a.id}" data-qid="${a.question_id || ''}">بررسی و تصمیم</button>` : `<p class="small muted">یادداشت: ${esc(a.decision_note || '')}</p>`}
      </div>`).join('') || '<div class="empty-state card soft"><b>موردی نیست</b></div>';
    box.querySelectorAll('[data-decide]').forEach((b) => b.addEventListener('click', () => decideAppealAdmin(b.dataset.decide, b.dataset.qid)));
  } catch (e) { box.innerHTML = `<p class="muted">${esc(e.message)}</p>`; }
}

async function decideAppealAdmin(appealId, questionId) {
  const out = await formModal({
    title: 'تصمیم دربارهٔ اعتراض',
    okText: 'ثبت تصمیم',
    fieldsHtml: `
      <div class="field"><label>تصمیم</label>
        <select class="inp" name="decision" required>
          <option value="accept">پذیرش</option><option value="reject">رد</option>
        </select>
      </div>
      <div class="field"><label>شناسهٔ سؤال (در صورت پذیرش)</label><input class="inp" name="questionId" type="number" value="${questionId || ''}"></div>
      <div class="field"><label>نمرهٔ اصلاح‌شده (در صورت پذیرش)</label><input class="inp" name="newMark" placeholder="مثلاً 1.5"></div>
      <div class="field"><label>توضیح تصمیم</label><textarea class="inp" name="note" required minlength="3"></textarea></div>`,
    onSubmit: async (obj) => {
      await API.post(`/api/admin/appeals/${appealId}/decision`, {
        decision: obj.decision, note: obj.note,
        questionId: obj.questionId ? Number(obj.questionId) : undefined,
        newMark: obj.newMark || undefined,
      });
    },
  });
  if (out) { Toast.show('ثبت شد', 'good'); loadAppealsAdmin('open'); }
}

/* ===================== RANKINGS ===================== */
async function loadRankingsAdmin() {
  try {
    const r = await API.get('/api/admin/exams');
    const sel = document.getElementById('arkExamId');
    if (sel && sel.tagName === 'SELECT') {
      sel.innerHTML = '<option value="">انتخاب آزمون…</option>' + (r.exams||[]).map((e)=>`<option value="${e.id}">${esc(e.title)}</option>`).join('');
    }
    // سال تحصیلی
    ['arkGradeYear','arkSubjYear'].forEach((id) => {
      const el = document.getElementById(id);
      if (el && (META.academicYears||[]).length) {
        el.innerHTML = (META.academicYears||[]).map((y)=>`<option value="${y.id}">${esc(y.label)}</option>`).join('');
      }
    });
    // درس
    const subj = document.getElementById('arkSubjId');
    if (subj) {
      if (subj.tagName !== 'SELECT') {
        const parent = subj.parentNode;
        const s = document.createElement('select');
        s.className = 'inp'; s.id = 'arkSubjId';
        s.innerHTML = '<option value="">انتخاب درس…</option>' + (META.subjects||[]).map((x)=>`<option value="${x.id}">${esc(x.label)}</option>`).join('');
        parent.replaceChild(s, subj);
      } else {
        subj.innerHTML = '<option value="">انتخاب درس…</option>' + (META.subjects||[]).map((x)=>`<option value="${x.id}">${esc(x.label)}</option>`).join('');
      }
    }
  } catch (e) {}
}

document.querySelectorAll('[data-artab]').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('[data-artab]').forEach((x) => x.classList.remove('on'));
  b.classList.add('on');
  ['exam', 'grade', 'subject'].forEach((k) => document.getElementById('ark-' + k).classList.toggle('hidden', k !== b.dataset.artab));
}));

document.getElementById('arkExamBtn').addEventListener('click', async () => {
  const id = Number(document.getElementById('arkExamId').value);
  const tbody = document.querySelector('#arkExamTable tbody');
  if (!id) return;
  tbody.innerHTML = '<tr><td colspan="5" class="muted">در حال بارگذاری…</td></tr>';
  try {
    const r = await API.get(`/api/admin/rankings/exams/${id}`);
    tbody.innerHTML = r.ranking.ranked.map((x) => `<tr><td><span class="rankb">${faNum(x.rank)}</span></td><td>${esc(x.fullName)}</td><td>${esc(x.grade)}</td><td>${esc(x.field)}</td><td><b>${faNum(x.totalMark)}</b></td></tr>`).join('') || '<tr><td colspan="5" class="muted">نتیجه‌ای نیست</td></tr>';
  } catch (e) { tbody.innerHTML = `<tr><td colspan="5">${esc(e.message)}</td></tr>`; }
});

document.getElementById('arkGradeBtn').addEventListener('click', async () => {
  const academicYearId = Number(document.getElementById('arkGradeYear').value);
  const gradeCode = document.getElementById('arkGradeCode').value;
  const tbody = document.querySelector('#arkGradeTable tbody');
  tbody.innerHTML = '<tr><td colspan="4" class="muted">در حال بارگذاری…</td></tr>';
  try {
    const r = await API.get(`/api/admin/rankings/grade?academicYearId=${academicYearId}&gradeCode=${gradeCode}`);
    tbody.innerHTML = r.ranking.ranked.map((x) => `<tr><td><span class="rankb">${faNum(x.rank)}</span></td><td>${esc(x.fullName)}</td><td>${faNum(x.examsCounted)}</td><td><b>${faNum(x.averageMark)}</b></td></tr>`).join('') || '<tr><td colspan="4" class="muted">نتیجه‌ای نیست</td></tr>';
  } catch (e) { tbody.innerHTML = `<tr><td colspan="4">${esc(e.message)}</td></tr>`; }
});

document.getElementById('arkSubjBtn').addEventListener('click', async () => {
  const academicYearId = Number(document.getElementById('arkSubjYear').value);
  const gradeCode = document.getElementById('arkSubjGrade').value;
  const subjectId = Number(document.getElementById('arkSubjId').value);
  const tbody = document.querySelector('#arkSubjTable tbody');
  if (!subjectId) { Toast.show('درس را انتخاب کنید', 'bad'); return; }
  tbody.innerHTML = '<tr><td colspan="4" class="muted">در حال بارگذاری…</td></tr>';
  try {
    const r = await API.get(`/api/admin/rankings/subject?academicYearId=${academicYearId}&gradeCode=${gradeCode}&subjectId=${subjectId}`);
    tbody.innerHTML = r.ranking.ranked.map((x) => `<tr><td><span class="rankb">${faNum(x.rank)}</span></td><td>${esc(x.fullName)}</td><td>${faNum(x.examsCounted)}</td><td><b>${faNum(x.averageMark)}</b></td></tr>`).join('') || '<tr><td colspan="4" class="muted">نتیجه‌ای نیست</td></tr>';
  } catch (e) { tbody.innerHTML = `<tr><td colspan="4">${esc(e.message)}</td></tr>`; }
});

/* ===================== PRACTICE ===================== */
async function loadPractice() {
  const tbody = document.querySelector('#practiceTable tbody');
  tbody.innerHTML = '<tr><td colspan="6" class="muted">در حال بارگذاری…</td></tr>';
  try {
    const r = await API.get('/api/admin/practice-sets');
    tbody.innerHTML = r.sets.map((s) => `
      <tr>
        <td>${esc(s.title)}</td><td>${esc(s.grade_code)}</td><td>${esc(s.subject)}</td><td>${faNum(s.question_count)}</td>
        <td><span class="tag ${s.active ? 'good' : 'bad'}">${s.active ? 'فعال' : 'غیرفعال'}</span></td>
        <td><button class="btn sm ghost" data-ptoggle="${s.id}" data-active="${s.active}">${s.active ? 'غیرفعال‌سازی' : 'فعال‌سازی'}</button></td>
      </tr>`).join('') || '<tr><td colspan="6" class="muted">موردی نیست</td></tr>';
    tbody.querySelectorAll('[data-ptoggle]').forEach((b) => b.addEventListener('click', async () => {
      const active = b.dataset.active === '1' || b.dataset.active === 'true';
      try { await API.patch(`/api/admin/practice-sets/${b.dataset.ptoggle}`, { active: !active }); loadPractice(); }
      catch (e) { Toast.show(e.message, 'bad'); }
    }));
  } catch (e) { tbody.innerHTML = `<tr><td colspan="6">${esc(e.message)}</td></tr>`; }
}

document.getElementById('newPracticeBtn').addEventListener('click', async () => {
  const out = await formModal({
    title: 'مجموعهٔ تمرین جدید',
    okText: 'ایجاد',
    fieldsHtml: `
      <div class="field"><label>عنوان</label><input class="inp" name="title" required minlength="3" maxlength="150"></div>
      <div class="grid-2">
        <div class="field"><label>پایه</label><select class="inp" name="gradeCode" required>${META.grades.map((g) => `<option value="${g.code}">${esc(g.label)}</option>`).join('')}</select></div>
        <div class="field"><label>درس</label><select class="inp" name="subjectId" required>${(META.subjects||[]).map((s)=>`<option value="${s.id}">${esc(s.label)}</option>`).join('')}</select></div>
      </div>
      <div class="field"><label>سؤال‌ها (هر خط: متن سؤال | حداکثر نمره | پاسخ تشریحی)</label>
        <textarea class="inp" name="questionsRaw" rows="5" placeholder="چند جمع است؟ | 1 | پاسخ: چهار" required></textarea>
      </div>`,
    onSubmit: async (obj) => {
      const questions = obj.questionsRaw.split('\n').map((l) => l.trim()).filter(Boolean).map((line) => {
        const [body, maxMark, explanatoryAnswer] = line.split('|').map((s) => (s || '').trim());
        return { body, maxMark, explanatoryAnswer: explanatoryAnswer || undefined };
      });
      await API.post('/api/admin/practice-sets', { title: obj.title, gradeCode: obj.gradeCode, subjectId: Number(obj.subjectId), questions });
    },
  });
  if (out) { Toast.show('ایجاد شد', 'good'); loadPractice(); }
});

/* ===================== OUTBOX ===================== */
async function loadOutbox() {
  const status = document.getElementById('outboxStatus').value;
  const tbody = document.querySelector('#outboxTable tbody');
  tbody.innerHTML = '<tr><td colspan="5" class="muted">در حال بارگذاری…</td></tr>';
  try {
    const r = await API.get(`/api/admin/outbox?status=${status}`);
    tbody.innerHTML = r.items.map((i) => `
      <tr><td>${esc(i.channel)}</td><td>${esc(faStatus(i.status))}</td><td>${faNum(i.attempts)}</td>
      <td class="small">${esc(i.last_error || '—')}</td><td class="small">${fmtDateTime(i.created_at)}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">موردی نیست</td></tr>';
  } catch (e) { tbody.innerHTML = `<tr><td colspan="5">${esc(e.message)}</td></tr>`; }
}
document.getElementById('outboxRefresh').addEventListener('click', loadOutbox);
document.getElementById('outboxStatus').addEventListener('change', loadOutbox);
document.getElementById('outboxRetry').addEventListener('click', async () => {
  try { const r = await API.post('/api/admin/outbox/retry', {}); Toast.show(`${faNum(r.requeued)} مورد مجدداً صف‌بندی شد`, 'good'); loadOutbox(); }
  catch (e) { Toast.show(e.message, 'bad'); }
});

/* ===================== AUDIT ===================== */
async function loadAudit() {
  const tbody = document.querySelector('#auditTable tbody');
  tbody.innerHTML = '<tr><td colspan="4" class="muted">در حال بارگذاری…</td></tr>';
  try {
    const r = await API.get('/api/admin/audit?limit=150');
    tbody.innerHTML = r.entries.map((e) => `
      <tr><td class="small">${fmtDateTime(e.created_at)}</td><td class="small">${esc(e.actor)}</td>
      <td class="small">${esc(e.action)}</td><td class="small">${esc(e.entity_type || '')} ${e.entity_id ? '#' + faNum(e.entity_id) : ''}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">موردی نیست</td></tr>';
  } catch (e) { tbody.innerHTML = `<tr><td colspan="4">${esc(e.message)}</td></tr>`; }
}

boot();


/* ===================== برنامه راهبردی (ادمین) ===================== */
async function loadStrategicAdmin() {
  const box = document.getElementById('strategicAdminList');
  if (!box) return;
  box.innerHTML = '<div class="skeleton" style="height:60px"></div>';
  try {
    const r = await API.get('/api/admin/strategic-phases');
    const phases = r.phases || [];
    box.innerHTML = phases.map((p) => `
      <div class="card soft">
        <div class="row wrap-r">
          <b>${esc(p.title)}</b>
          <span class="tag">${esc(p.gradeLabel)}</span>
          ${p.active ? '<span class="tag good">فعال</span>' : '<span class="tag">غیرفعال</span>'}
          <span class="spacer"></span>
          <button class="btn sm ghost" data-sp-edit="${p.id}">ویرایش</button>
          <button class="btn sm ghost" data-sp-del="${p.id}">حذف</button>
        </div>
        <div class="small muted" style="margin-top:6px">${fmtDateTime(p.startsAt)} — ${fmtDateTime(p.endsAt)}</div>
        ${p.topicsText ? `<p class="small" style="margin-top:6px;white-space:pre-wrap">${esc(p.topicsText)}</p>` : ''}
      </div>`).join('') || '<div class="empty-state card soft"><b>مرحله‌ای تعریف نشده</b></div>';
    box.querySelectorAll('[data-sp-edit]').forEach((b) => b.addEventListener('click', () => editStrategicPhase(Number(b.dataset.spEdit))));
    box.querySelectorAll('[data-sp-del]').forEach((b) => b.addEventListener('click', async () => {
      const ok = await confirmModal({ title: 'حذف مرحله', body: 'این مرحله حذف شود؟', okText: 'حذف', danger: true });
      if (!ok) return;
      try { await API.del(`/api/admin/strategic-phases/${b.dataset.spDel}`); Toast.show('حذف شد', 'good'); loadStrategicAdmin(); }
      catch (e) { Toast.show(e.message, 'bad'); }
    }));
  } catch (e) { box.innerHTML = `<p class="muted">${esc(e.message)}</p>`; }
}

async function editStrategicPhase(id) {
  let phase = null;
  if (id) {
    try { phase = (await API.get(`/api/admin/strategic-phases/${id}`)).phase; } catch (e) { Toast.show(e.message, 'bad'); return; }
  }
  const gradeOpts = (META.grades || []).map((g) => `<option value="${g.code}" ${phase && phase.gradeCode === g.code ? 'selected' : ''}>${esc(g.label)}</option>`).join('');
  const toLocal = (iso) => iso ? new Date(iso).toISOString().slice(0, 16) : '';
  const out = await formModal({
    title: id ? 'ویرایش مرحله' : 'مرحله جدید',
    okText: 'ذخیره',
    fieldsHtml: `
      <div class="field"><label>عنوان</label><input class="inp" name="title" required minlength="2" maxlength="120" value="${phase ? esc(phase.title) : ''}"></div>
      <div class="field"><label>پایه</label><select class="inp" name="gradeCode" required>${gradeOpts}</select></div>
      <div class="grid-2">
        <div class="field"><label>شروع</label><input class="inp" type="datetime-local" name="startsAt" required value="${phase ? toLocal(phase.startsAt) : ''}"></div>
        <div class="field"><label>پایان</label><input class="inp" type="datetime-local" name="endsAt" required value="${phase ? toLocal(phase.endsAt) : ''}"></div>
      </div>
      <div class="field"><label>ترتیب نمایش</label><input class="inp" type="number" name="sortOrder" value="${phase ? phase.sortOrder : 0}"></div>
      <div class="field"><label>مباحث</label><textarea class="inp" name="topicsText" rows="3">${phase && phase.topicsText ? esc(phase.topicsText) : ''}</textarea></div>
      ${id ? `<div class="field"><label>فعال</label><select class="inp" name="active"><option value="1" ${phase && phase.active ? 'selected' : ''}>بله</option><option value="0" ${phase && !phase.active ? 'selected' : ''}>خیر</option></select></div>` : ''}
    `,
    onSubmit: async (obj) => {
      const body = {
        title: obj.title,
        gradeCode: obj.gradeCode,
        startsAt: new Date(obj.startsAt).toISOString(),
        endsAt: new Date(obj.endsAt).toISOString(),
        sortOrder: Number(obj.sortOrder) || 0,
        topicsText: obj.topicsText || null,
      };
      if (id) {
        body.active = obj.active === '1';
        await API.patch(`/api/admin/strategic-phases/${id}`, body);
      } else {
        await API.post('/api/admin/strategic-phases', body);
      }
    },
  });
  if (out) { Toast.show('ذخیره شد', 'good'); loadStrategicAdmin(); }
}

document.addEventListener('click', (e) => {
  if (e.target && e.target.id === 'newStrategicBtn') editStrategicPhase(null);
});

/* ===================== تنظیمات سامانه =====================
   فرم به‌صورت خودکار از روی schema ساخته می‌شود؛ هر کلیدی که در
   services/settings.js تعریف شود، اینجا بدون تغییرِ دستی ظاهر می‌شود. */
const SETTINGS_GROUPS = {
  home: { label: 'متن‌های صفحه‌ی اصلیِ دانش‌آموز', icon: 'home' },
  ranking: { label: 'رتبه‌بندی', icon: 'trophy' },
  exams: { label: 'آزمون‌ها', icon: 'exam' },
  brand: { label: 'برند', icon: 'star' },
  print: { label: 'چاپ و PDF', icon: 'print' },
};

async function loadSettingsAdmin() {
  const box = document.getElementById('settingsAdminBox');
  if (!box) return;
  box.innerHTML = '<div class="skeleton" style="height:120px"></div>';
  try {
    const r = await API.get('/api/admin/settings');
    const schema = r.schema || [];
    const current = r.settings || {};

    const byGroup = {};
    schema.forEach((s) => { (byGroup[s.group] = byGroup[s.group] || []).push(s); });

    const html = Object.keys(byGroup).map((g) => {
      const meta = SETTINGS_GROUPS[g] || { label: g, icon: 'info' };
      return `<div class="card soft" style="margin-bottom:14px">
        <h4 style="margin:0 0 12px;display:flex;align-items:center;gap:7px">
          ${icon(meta.icon, { size: 18 })} ${esc(meta.label)}
        </h4>
        <div class="grid-2">
          ${byGroup[g].map((s) => settingsFieldHtml(s, current[s.key])).join('')}
        </div>
      </div>`;
    }).join('');

    box.innerHTML = html + `
      <div class="row wrap-r" style="margin-top:6px">
        <button class="btn primary" id="saveSettingsBtn">ذخیره تنظیمات</button>
        <button class="btn ghost" id="resetSettingsBtn">بازگشت به پیش‌فرض‌ها</button>
        <span id="settingsSaved" class="small muted"></span>
      </div>`;

    document.getElementById('saveSettingsBtn').addEventListener('click', saveSettings);
    document.getElementById('resetSettingsBtn').addEventListener('click', resetSettings);
  } catch (e) { box.innerHTML = `<p class="muted">${esc(e.message)}</p>`; }
}

function settingsFieldHtml(s, value) {
  const id = 'set_' + s.key;
  const wide = s.type === 'string' && (s.max || 0) > 300;
  const wrap = (inner) => `<div class="field"${wide ? ' style="grid-column:1/-1"' : ''}>
      <label>${esc(s.label)}</label>${inner}
      <div class="small muted" style="margin-top:3px"><code>${esc(s.key)}</code></div>
    </div>`;
  if (s.type === 'bool') {
    return wrap(`<select class="inp" id="${id}">
      <option value="1"${value ? ' selected' : ''}>فعال</option>
      <option value="0"${value ? '' : ' selected'}>غیرفعال</option></select>`);
  }
  if (s.type === 'number') {
    return wrap(`<input class="inp" type="number" id="${id}"
      ${s.min !== undefined ? `min="${s.min}"` : ''} ${s.max !== undefined ? `max="${s.max}"` : ''}
      value="${esc(value)}">`);
  }
  const long = (s.max || 0) > 300;
  return wrap(long
    ? `<textarea class="inp" id="${id}" rows="3" style="min-height:76px">${esc(value || '')}</textarea>`
    : `<input class="inp" type="text" id="${id}" value="${esc(value || '')}">`);
}

async function saveSettings() {
  const btn = document.getElementById('saveSettingsBtn');
  btn.disabled = true;
  try {
    const r = await API.get('/api/admin/settings');
    const patch = {};
    (r.schema || []).forEach((s) => {
      const el = document.getElementById('set_' + s.key);
      if (!el) return;
      patch[s.key] = s.type === 'bool' ? el.value === '1' : el.value;
    });
    await API.patch('/api/admin/settings', { settings: patch });
    Toast.show('تنظیمات ذخیره شد', 'good');
    const note = document.getElementById('settingsSaved');
    if (note) note.textContent = 'ذخیره شد ✓';
  } catch (e) {
    Toast.show(e.message, 'bad');
    const note = document.getElementById('settingsSaved');
    if (note) note.textContent = e.message;
  } finally { btn.disabled = false; }
}

async function resetSettings() {
  if (!confirm('همه‌ی تنظیمات به مقدار پیش‌فرض برمی‌گردد. ادامه می‌دهی؟')) return;
  try {
    // مقدارِ خالی یعنی «از پیش‌فرضِ schema استفاده کن»
    const r = await API.get('/api/admin/settings');
    const patch = {};
    (r.schema || []).forEach((s) => { patch[s.key] = ''; });
    await API.patch('/api/admin/settings', { settings: patch });
    Toast.show('تنظیمات به پیش‌فرض برگشت', 'good');
    loadSettingsAdmin();
  } catch (e) { Toast.show(e.message, 'bad'); }
}

/* ===================== چاپ / PDF ===================== */
async function printParticipants(examId) {
  try {
    const r = await API.get(`/api/admin/exams/${examId}/participants`);
    const settings = await API.get('/api/admin/settings');
    Print.participants(r.exam, r.participants, {
      headerLine: settings.settings.print_header_line,
    });
  } catch (e) { Toast.show(e.message || 'چاپ انجام نشد', 'bad'); }
}

/** چاپِ کارنامه‌ی یک دانش‌آموز (از پنل ادمین) */
async function printAdminReportCard(examId, studentId) {
  try {
    const r = await API.get(`/api/admin/report-cards/${examId}/${studentId}`);
    const settings = await API.get('/api/admin/settings');
    Print.reportCard(r.reportCard, { headerLine: settings.settings.print_header_line });
  } catch (e) { Toast.show(e.message || 'چاپ انجام نشد', 'bad'); }
}

/** چاپِ پاسخنامه‌ی رسمی یک آزمون (همه‌ی صفحه‌ها) */
function printAnswerKey(exam) {
  const url = `/api/admin/exams/${exam.id}/answer-key`;
  Print.answerKey({
    title: exam.title,
    gradeLabel: exam.gradeLabel,
    answerKeyUrl: url,
    answerKeyMime: 'application/pdf',
  }, { headerLine: '' }).catch(() => Print.printFileDirect(url));
}

/* ===================== آزمون‌های منقضی → تمرین ===================== */
async function loadExpiredExamsAdmin() {
  const box = document.getElementById('expiredExamsBox');
  if (!box) return;
  box.innerHTML = '<div class="skeleton" style="height:70px"></div>';
  try {
    const r = await API.get('/api/admin/exams/expired');
    const list = r.exams || [];
    if (!list.length) {
      box.innerHTML = '<p class="muted small">هیچ آزمون منقضی‌شده‌ای نداری.</p>';
      return;
    }
    box.innerHTML = '<div class="table-wrap"><table class="plan"><thead><tr>' +
      '<th>آزمون</th><th>مهلت ارسال</th><th>تعداد سؤال</th><th>وضعیت</th><th></th>' +
      '</tr></thead><tbody>' + list.map((e) => `<tr>
        <td><b>${esc(e.title)}</b></td>
        <td>${esc(fmtDateTime(e.submissionDeadline))}</td>
        <td>${esc(e.questionCount == null ? '—' : faNum(e.questionCount))}</td>
        <td>${e.converted
          ? '<span class="tag g12">تبدیل‌شده</span>'
          : '<span class="tag b">تبدیل‌نشده</span>'}</td>
        <td><button class="btn sm${e.converted ? ' ghost' : ' primary'}" data-to-practice="${e.id}"
              ${e.converted ? 'disabled' : ''}>
              ${icon('practice', { size: 15 })} تبدیل به تمرین
            </button></td></tr>`).join('') + '</tbody></table></div>';
  } catch (e) { box.innerHTML = `<p class="muted">${esc(e.message)}</p>`; }
}

document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-to-practice]');
  if (!btn) return;
  const examId = Number(btn.dataset.toPractice);
  btn.disabled = true;
  try {
    const r = await API.post(`/api/admin/exams/${examId}/to-practice`);
    Toast.show(r.alreadyConverted
      ? 'این آزمون قبلاً تبدیل شده بود'
      : `${faNum(r.sets.length)} مجموعه تمرین ساخته شد`, 'good');
    loadExpiredExamsAdmin();
  } catch (err) {
    Toast.show(err.message || 'تبدیل انجام نشد', 'bad');
    btn.disabled = false;
  }
});
