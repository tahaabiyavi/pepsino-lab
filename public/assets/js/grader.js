
let ME = null;
let ASSIGNMENTS = [];
let ACTIVE_TAB = 'active';

function views() { return document.querySelectorAll('main > section'); }
function go(name) {
  views().forEach((s) => s.classList.toggle('hidden', s.id !== 'view-' + name));
  setActiveNav(name);
  if (name === 'assignments') loadAssignments();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
document.addEventListener('click', (e) => {
  const g = e.target.closest('[data-go]');
  if (g) go(g.dataset.go);
});

async function boot() {
  ME = await Auth.requireRole('grader');
  if (!ME) return;
  document.getElementById('whoami').textContent = ME.displayName || ME.username;
  document.getElementById('logoutBtn').addEventListener('click', Auth.logout);
  go('assignments');
}

document.querySelectorAll('[data-atab]').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('[data-atab]').forEach((x) => x.classList.remove('on'));
  b.classList.add('on');
  ACTIVE_TAB = b.dataset.atab;
  renderAssignList();
}));

async function loadAssignments() {
  const box = document.getElementById('assignList');
  box.innerHTML = '<div class="skeleton" style="height:84px"></div>';
  try {
    const r = await API.get('/api/grader/assignments');
    ASSIGNMENTS = r.assignments;
    const stats = r.stats || { total: ASSIGNMENTS.length, completed: ASSIGNMENTS.filter(a=>a.state==='completed').length, remaining: ASSIGNMENTS.filter(a=>a.state==='active').length };
    const statsEl = document.getElementById('graderStats');
    if (statsEl) {
      statsEl.innerHTML = `
        <div class="mini-stats" style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:14px">
          <div class="card soft" style="text-align:center"><div class="small muted">برگه‌های باقی‌مانده</div><b style="font-size:1.4em">${faNum(stats.remaining)}</b></div>
          <div class="card soft" style="text-align:center"><div class="small muted">تصحیح‌شده</div><b style="font-size:1.4em">${faNum(stats.completed)}</b></div>
          <div class="card soft" style="text-align:center"><div class="small muted">کل برگه‌های من</div><b style="font-size:1.4em">${faNum(stats.total)}</b></div>
        </div>`;
    }
    renderAssignList();
  } catch (e) { box.innerHTML = `<p class="muted">${esc(e.message)}</p>`; }
}

function renderAssignList() {
  const box = document.getElementById('assignList');
  const list = ASSIGNMENTS.filter((a) => a.state === ACTIVE_TAB);
  box.innerHTML = list.map((a) => `
    <div class="ex-card">
      <div style="flex:1;min-width:220px">
        <b class="ex-title">${esc(a.exam_title)}</b>
        <div class="meta">
          <span class="tag ${a.state === 'completed' ? 'good' : ''}">${esc(faStatus(a.state))}</span>
          ${a.has_appeal ? '<span class="tag" style="background:#fecaca;color:#991b1b;font-weight:800">اعتراض</span>' : ''}
          <span class="small muted">تخصیص: ${fmtDateTime(a.assigned_at)}</span>
          ${a.completed_at ? `<span class="small muted">پایان: ${fmtDateTime(a.completed_at)}</span>` : ''}
        </div>
      </div>
      <button class="btn sm" data-open="${a.id}">${a.state === 'completed' ? 'مشاهده' : 'ادامهٔ تصحیح'}</button>
    </div>`).join('') || `<div class="empty-state card soft"><b>برگه‌ای در این بخش نیست</b></div>`;
  box.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => openAssignment(Number(b.dataset.open))));
}

/* ===================== GRADING WORKSPACE ===================== */
async function openAssignment(id) {
  go('grade');
  const box = document.getElementById('gradeBox');
  box.innerHTML = '<div class="skeleton" style="height:200px"></div>';
  try {
    const r = await API.get(`/api/grader/assignments/${id}`);
    await renderGrading(r, id);
  } catch (e) { box.innerHTML = `<p class="muted">${esc(e.message)}</p>`; }
}

async function renderGrading(data, assignmentId) {
  const { assignment, answerKey, questions, scores, files } = data;
  const scoreMap = {};
  scores.forEach((s) => { scoreMap[s.questionId] = s; });
  const locked = assignment.state !== 'active';
  const box = document.getElementById('gradeBox');
  const marks = [0, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

  const studentFileUrl = files.length
    ? `/api/grader/assignments/${assignmentId}/files/${files[0].id}?inline=1`
    : null;
  const keyUrl = answerKey.available ? `${answerKey.path}?inline=1` : null;

  box.innerHTML = `
    <div class="card">
      <div class="row wrap-r">
        <h3>${esc(assignment.studentName || 'برگه')} ${assignment.hasAppeal ? '<span class="tag" style="background:#fecaca;color:#991b1b">اعتراض</span>' : ''}</h3>
        <span class="tag ${locked ? 'good' : ''}">${esc(faStatus(assignment.state))}</span>
        <span class="spacer"></span>
      </div>
    </div>

    <div class="grid-2" style="margin-top:12px;gap:12px;align-items:start">
      <div class="card soft">
        <div class="row wrap-r"><b>پاسخنامه رسمی</b>
          <span class="spacer"></span>
          <button class="btn sm ghost" data-zoom="key" data-dir="-">−</button>
          <button class="btn sm ghost" data-zoom="key" data-dir="+">+</button>
          ${keyUrl ? `<a class="btn sm ghost" href="${keyUrl}" target="_blank">تب جدید</a>` : ''}
        </div>
        <div id="keyViewer" style="margin-top:8px">
          ${keyUrl ? '' : '<p class="small muted" style="padding:16px">پاسخنامه رسمی موجود نیست</p>'}
        </div>
      </div>
      <div class="card soft">
        <div class="row wrap-r"><b>پاسخنامه دانش‌آموز</b>
          <span class="spacer"></span>
          <button class="btn sm ghost" data-zoom="stu" data-dir="-">−</button>
          <button class="btn sm ghost" data-zoom="stu" data-dir="+">+</button>
          ${studentFileUrl ? `<a class="btn sm ghost" href="${studentFileUrl}" target="_blank">تب جدید</a>` : ''}
        </div>
        <div id="stuViewer" style="margin-top:8px">
          ${studentFileUrl ? '' : '<p class="small muted" style="padding:16px">فایل پاسخ دانش‌آموز موجود نیست</p>'}
        </div>
      </div>
    </div>

    <div id="qList" class="stack" style="margin-top:16px"></div>

    <div class="card soft">
      <div class="field">
        <label>توضیح کلی (اختیاری)</label>
        <textarea class="inp" id="overallComment" ${locked ? 'disabled' : ''}>${esc(assignment.overallComment || '')}</textarea>
      </div>
      <div class="row wrap-r" style="margin-top:12px">
        <span id="progressLabel" class="small muted"></span>
        <span id="totalMarkLabel" class="small" style="margin-inline-start:12px"></span>
        <span class="spacer"></span>
        ${!locked ? `
          <button class="btn ghost" id="saveDraftBtn">ذخیرهٔ پیش‌نویس</button>
          <button class="btn primary" id="finalizeBtn">نهایی‌سازی تصحیح</button>
        ` : ''}
      </div>
    </div>
  `;

  // نمایشگرهای PDF: صفحه‌ی قبل/بعد و بزرگ‌نمایی دارد؛ دکمه‌های بالا هم به آن وصل‌اند
  const viewers = { key: null, stu: null };
  async function mountViewer(which, url, boxId) {
    const el = document.getElementById(boxId);
    if (!el || !url || !window.PdfViewer) return;
    try { viewers[which] = await PdfViewer.open(el, url); } catch (e) { /* می‌ماند برای fallback */ }
  }
  await mountViewer('key', keyUrl, 'keyViewer');
  await mountViewer('stu', studentFileUrl, 'stuViewer');

  box.querySelectorAll('[data-zoom]').forEach((b) => {
    b.addEventListener('click', () => {
      const which = b.dataset.zoom;
      const v = viewers[which];
      if (v && v.zoomBy) v.zoomBy(b.dataset.dir === '+' ? 0.25 : -0.25);
    });
  });

  const qList = document.getElementById('qList');
  qList.innerHTML = questions.map((q) => {
    const s = scoreMap[q.id];
    const cur = s ? String(s.mark) : '';
    return `<div class="card soft" data-qid="${q.id}">
      <div class="row wrap-r"><b>سؤال ${faNum(q.position)}</b><span class="small muted">${esc(q.subject || '')}</span></div>
      ${q.grading_instructions ? `<p class="small muted" style="margin-top:6px">${esc(q.grading_instructions)}</p>` : ''}
      <div class="field" style="margin-top:10px">
        <label>نمره (۰ تا ۲)</label>
        <div class="row wrap-r" style="gap:6px;flex-wrap:wrap" data-mark-btns>
          ${marks.map((m) => {
            const v = String(m);
            const on = cur === v || (cur === '0' && m === 0) || (Number(cur) === m);
            return `<button type="button" class="btn sm ${on ? 'primary' : 'ghost'}" data-mark-val="${v}" ${locked ? 'disabled' : ''}>${v}</button>`;
          }).join('')}
        </div>
        <input type="hidden" data-mark value="${esc(cur)}">
      </div>
      <div class="field" style="margin-top:8px">
        <label>توضیح (اختیاری)</label>
        <input class="inp" data-comment value="${esc(s && s.comment ? s.comment : '')}" ${locked ? 'disabled' : ''}>
      </div>
    </div>`;
  }).join('');

  if (!locked) {
    qList.querySelectorAll('[data-mark-val]').forEach((b) => {
      b.addEventListener('click', () => {
        const card = b.closest('[data-qid]');
        card.querySelectorAll('[data-mark-val]').forEach((x) => x.classList.remove('primary'));
        card.querySelectorAll('[data-mark-val]').forEach((x) => x.classList.add('ghost'));
        b.classList.remove('ghost');
        b.classList.add('primary');
        card.querySelector('[data-mark]').value = b.dataset.markVal;
        updateTotalPreview();
      });
    });
  }

  updateProgress(questions.length, scores.length);
  updateTotalPreview();

  if (!locked) {
    document.getElementById('saveDraftBtn').addEventListener('click', () => saveScores(assignmentId, questions.length));
    document.getElementById('finalizeBtn').addEventListener('click', () => finalizeAssignment(assignmentId, questions.length));
  }
}

function updateTotalPreview() {
  let sum = 0;
  document.querySelectorAll('[data-qid] [data-mark]').forEach((inp) => {
    if (inp.value !== '') sum += Number(inp.value);
  });
  const el = document.getElementById('totalMarkLabel');
  if (el) {
    el.textContent = 'مجموع: ' + sum.toFixed(2) + ' / ۲۰';
    el.style.color = sum > 20 ? '#b91c1c' : '';
  }
}

function updateProgress(total, scored) {
  const el = document.getElementById('progressLabel');
  if (el) el.textContent = `نمره‌گذاری‌شده: ${faNum(scored)} از ${faNum(total)}`;
}

function collectScores() {
  const scores = [];
  const comments = {};
  document.querySelectorAll('[data-qid]').forEach((card) => {
    const qid = Number(card.dataset.qid);
    const mark = card.querySelector('[data-mark]').value;
    const comment = card.querySelector('[data-comment]').value;
    if (mark !== '') scores.push({ questionId: qid, mark });
    if (comment) comments[qid] = comment;
  });
  return { scores, comments };
}

async function saveScores(assignmentId, total, silent) {
  const { scores, comments } = collectScores();
  const overallComment = document.getElementById('overallComment').value;
  try {
    const r = await API.put(`/api/grader/assignments/${assignmentId}/scores`, { scores, comments, overallComment });
    updateProgress(total, r.progress.scored);
    if (!silent) Toast.show('پیش‌نویس ذخیره شد', 'good');
    return r;
  } catch (e) {
    const details = e.details && e.details.errors ? e.details.errors.map((x) => x.message).join(' — ') : '';
    Toast.show((e.message || 'خطا') + (details ? ' — ' + details : ''), 'bad');
    throw e;
  }
}

async function finalizeAssignment(assignmentId, total) {
  try {
    await saveScores(assignmentId, total, true);
  } catch (e) { return; }
  const ok = await confirmModal({ title: 'نهایی‌سازی تصحیح', body: 'پس از نهایی‌سازی، امکان ویرایش نمره‌ها برای شما وجود نخواهد داشت. ادامه می‌دهید؟', okText: 'نهایی‌سازی', danger: true });
  if (!ok) return;
  try {
    await API.post(`/api/grader/assignments/${assignmentId}/finalize`, {});
    Toast.show('تصحیح نهایی شد', 'good');
    openAssignment(assignmentId);
  } catch (e) {
    const details = e.details && e.details.missingQuestions ? ` (سؤال‌های باقی‌مانده: ${e.details.missingQuestions.map((q) => faNum(q.position)).join('، ')})` : '';
    Toast.show((e.message || 'خطا') + details, 'bad');
  }
}

boot();
