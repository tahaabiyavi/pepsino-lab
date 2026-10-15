
(async function init() {
  // If already signed in, go straight to the right area.
  const subj = await Auth.me();
  if (subj) {
    location.href = subj.type === 'admin' ? '/admin.html' : subj.type === 'grader' ? '/grader.html' : '/student.html';
    return;
  }

  // Tabs
  document.querySelectorAll('.authtabs [data-tab]').forEach((b) => {
    b.addEventListener('click', () => {
      document.querySelectorAll('.authtabs [data-tab]').forEach((x) => x.classList.remove('on'));
      b.classList.add('on');
      const which = b.dataset.tab;
      document.getElementById('loginForm').classList.toggle('hidden', which !== 'login');
      document.getElementById('regForm').classList.toggle('hidden', which !== 'register');
    });
  });

  // Load grade/field options
  try {
    const meta = await API.get('/api/meta/options');
    const gSel = document.getElementById('gradeSelect');
    const fSel = document.getElementById('fieldSelect');
    gSel.innerHTML = '<option value="">انتخاب کنید…</option>' + meta.grades.map((g) => `<option value="${esc(g.code)}">${esc(g.label)}</option>`).join('');
    fSel.innerHTML = '<option value="">انتخاب کنید…</option>' + meta.fields.map((f) => `<option value="${esc(f.code)}">${esc(f.label)}</option>`).join('');
  } catch (e) { /* ignore; shown on submit anyway */ }

  // Login
  document.getElementById('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errBox = document.getElementById('loginErr');
    errBox.classList.add('hidden');
    const fd = new FormData(e.target);
    try {
      const out = await API.post('/api/auth/login', { username: fd.get('username'), password: fd.get('password') }, { silentAuth: true });
      const t = out.subject.type;
      location.href = t === 'admin' ? '/admin.html' : t === 'grader' ? '/grader.html' : '/student.html';
    } catch (err) {
      errBox.textContent = err.message || 'ورود ناموفق بود';
      errBox.classList.remove('hidden');
    }
  });

  // Register
  document.getElementById('regForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errBox = document.getElementById('regErr');
    errBox.classList.add('hidden');
    const fd = new FormData(e.target);
    try {
      const out = await API.post('/api/registrations', {
        fullName: fd.get('fullName'), username: fd.get('username'), password: fd.get('password'),
        gradeCode: fd.get('gradeCode'), fieldCode: fd.get('fieldCode'),
      });
      Toast.show(out.message || 'درخواست ثبت شد', 'good');
      e.target.reset();
    } catch (err) {
      const details = err.details ? Object.values(err.details).join(' — ') : '';
      errBox.textContent = (err.message || 'ثبت‌نام ناموفق بود') + (details ? ' — ' + details : '');
      errBox.classList.remove('hidden');
    }
  });

  // Forgot password
  document.getElementById('forgotBtn').addEventListener('click', async () => {
    const out = await formModal({
      title: 'بازیابی رمز عبور',
      fieldsHtml: `
        <div class="field"><label>نام کاربری</label><input class="inp" name="username" required></div>
        <p class="small muted">درخواست به مدیریت اطلاع داده می‌شود و یک کد یک‌بارمصرف دریافت خواهید کرد.</p>`,
      okText: 'ارسال درخواست',
      onSubmit: async (obj) => { await API.post('/api/auth/password-help', { username: obj.username }); },
    });
    if (out) {
      Toast.show('اگر حسابی با این نام کاربری وجود داشته باشد، درخواست ارسال شد', 'good');
      const out2 = await formModal({
        title: 'ورود کد بازیابی',
        fieldsHtml: `
          <div class="field"><label>نام کاربری</label><input class="inp" name="username" required></div>
          <div class="field"><label>کد بازیابی</label><input class="inp" name="token" required></div>
          <div class="field"><label>رمز عبور جدید</label><input class="inp" type="password" name="newPassword" required></div>`,
        okText: 'تغییر رمز عبور',
        onSubmit: async (obj) => { await API.post('/api/auth/password-reset', obj); },
      });
      if (out2) Toast.show('رمز عبور تغییر کرد؛ اکنون وارد شوید', 'good');
    }
  });
})();
