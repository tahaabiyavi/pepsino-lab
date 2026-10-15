'use strict';
/* pepsino LAB — shared front-end helpers (no build step, no framework).
   Loaded by every page before its own <page>.js file. */

const API = (() => {
  async function req(method, path, body, opts = {}) {
    const init = { method, credentials: 'same-origin', headers: {} };
    if (body instanceof FormData) {
      init.body = body;
    } else if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    let res;
    try {
      res = await fetch(path, init);
    } catch (e) {
      throw { code: 'network_error', message: 'ارتباط با سرور برقرار نشد' };
    }
    if (res.status === 204) return null;
    const isJson = (res.headers.get('content-type') || '').includes('application/json');
    const data = isJson ? await res.json().catch(() => null) : null;
    if (!res.ok) {
      const err = (data && data.error) || { code: 'unknown', message: 'خطای ناشناخته' };
      if (res.status === 401 && !opts.silentAuth) {
        Toast.show('نشست شما منقضی شده است، دوباره وارد شوید', 'bad');
        setTimeout(() => { location.href = '/'; }, 900);
      }
      throw err;
    }
    return data;
  }
  return {
    get: (p, opts) => req('GET', p, undefined, opts),
    post: (p, body, opts) => req('POST', p, body, opts),
    put: (p, body, opts) => req('PUT', p, body, opts),
    patch: (p, body, opts) => req('PATCH', p, body, opts),
    del: (p, opts) => req('DELETE', p, undefined, opts),
  };
})();

/* ---------- toast ---------- */
const Toast = (() => {
  let el = null;
  function ensure() {
    if (el) return el;
    el = document.createElement('div');
    el.className = 'toast';
    document.body.appendChild(el);
    return el;
  }
  let hideTimer = null;
  function show(msg, kind = '') {
    const node = ensure();
    node.textContent = msg;
    node.className = 'toast show' + (kind ? ' ' + kind : '');
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => { node.classList.remove('show'); }, 3200);
  }
  return { show };
})();

/* ---------- confirm modal ---------- */
function confirmModal({ title = 'آیا مطمئن هستید؟', body = '', okText = 'تأیید', cancelText = 'انصراف', danger = false } = {}) {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.className = 'modal';
    wrap.innerHTML = `
      <div class="box">
        <h3>${esc(title)}</h3>
        ${body ? `<p class="muted" style="margin-top:10px">${esc(body)}</p>` : ''}
        <div class="row" style="margin-top:18px;justify-content:flex-end">
          <button class="btn ghost" data-act="cancel">${esc(cancelText)}</button>
          <button class="btn ${danger ? 'danger' : 'primary'}" data-act="ok">${esc(okText)}</button>
        </div>
      </div>`;
    document.body.appendChild(wrap);
    wrap.addEventListener('click', (e) => {
      if (e.target === wrap) { close(false); }
      const act = e.target.closest('[data-act]');
      if (act) close(act.dataset.act === 'ok');
    });
    function close(v) { wrap.remove(); resolve(v); }
  });
}

function formModal({ title, fieldsHtml, okText = 'ثبت', onSubmit }) {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.className = 'modal';
    wrap.innerHTML = `
      <div class="box">
        <h3>${esc(title)}</h3>
        <form data-f>
          ${fieldsHtml}
          <div class="row" style="margin-top:16px;justify-content:flex-end">
            <button type="button" class="btn ghost" data-act="cancel">انصراف</button>
            <button type="submit" class="btn primary">${esc(okText)}</button>
          </div>
        </form>
      </div>`;
    document.body.appendChild(wrap);
    const form = wrap.querySelector('[data-f]');
    wrap.addEventListener('click', (e) => {
      if (e.target === wrap || e.target.closest('[data-act="cancel"]')) { wrap.remove(); resolve(null); }
    });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const obj = {};
      for (const [k, v] of fd.entries()) obj[k] = v;
      if (onSubmit) {
        try { await onSubmit(obj, form); } catch (err) { Toast.show(err.message || 'خطا رخ داد', 'bad'); return; }
      }
      wrap.remove();
      resolve(obj);
    });
  });
}

/* ---------- utils ---------- */
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const FA_DIGITS = ['۰','۱','۲','۳','۴','۵','۶','۷','۸','۹'];
function faNum(n) { return String(n).replace(/[0-9]/g, (d) => FA_DIGITS[d]); }

function fmtDateTime(iso) {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    return faNum(d.toLocaleString('fa-IR', { dateStyle: 'medium', timeStyle: 'short' }));
  } catch (e) { return iso; }
}
function fmtDate(iso) {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    return faNum(d.toLocaleDateString('fa-IR', { dateStyle: 'medium' }));
  } catch (e) { return iso; }
}
function fmtBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / (1024 * 1024)).toFixed(1) + ' MB';
}

/* integer-quarters mark helpers (server validates; this is display/UX only) */
function markToQuarterStep(input) {
  // leaves validation to the server; just a light client-side nudge
  const n = Number(input);
  return Number.isFinite(n) ? n : null;
}

const STATUS_FA = {
  draft: 'پیش‌نویس', published: 'منتشرشده', in_progress: 'درحال برگزاری',
  submission_closed: 'پایان‌یافته', grading: 'درحال تصحیح', results_published: 'نتایج منتشرشده', archived: 'بایگانی‌شده',
  pending: 'در انتظار', accepted: 'پذیرفته‌شده', rejected: 'ردشده',
  active: 'فعال', disabled: 'غیرفعال', submitted: 'ارسال‌شده', absent: 'غایب', missing: 'بدون پاسخ',
  open: 'باز', completed: 'تمام‌شده', reassigned: 'واگذارشده',
};
function faStatus(s) { return STATUS_FA[s] || s; }

const GRADE_CLASS = { g10: 't10', g11: 't11', g12: 't12' };

/* ---------- auth / shell ---------- */
const Auth = {
  async me() {
    try { const r = await API.get('/api/auth/me', { silentAuth: true }); return r.subject; }
    catch (e) { return null; }
  },
  async requireRole(role) {
    const subj = await Auth.me();
    if (!subj || subj.type !== role) { location.href = '/'; return null; }
    return subj;
  },
  async logout() {
    try { await API.post('/api/auth/logout'); } catch (e) { /* noop */ }
    location.href = '/';
  },
};

function mountMobileMenu() {
  const btn = document.getElementById('menuBtn');
  const nav = document.querySelector('nav.main');
  if (btn && nav) btn.addEventListener('click', () => nav.classList.toggle('open'));
}

function setActiveNav(key) {
  document.querySelectorAll('nav.main [data-nav]').forEach((a) => {
    a.classList.toggle('active', a.dataset.nav === key);
  });
}

document.addEventListener('DOMContentLoaded', mountMobileMenu);
