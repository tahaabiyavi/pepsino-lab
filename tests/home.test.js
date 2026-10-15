'use strict';
// Home dashboard of the student panel, Jalali calendar, typed settings,
// and the expired-exam → practice-set conversion.
// The old project (pepsinolab-exam-server-v5) had all of this on its public
// landing page; it now lives behind the student login.
const test = require('node:test');
const assert = require('node:assert/strict');

const { start, req, login, adminCookie, addStudent, buildExam, attachKey, setStatus, iso, HOUR } = require('./support/fixtures');
const home = require('../src/services/home');
const settings = require('../src/services/settings');
const jalali = require('../src/services/jalali');
const practice = require('../src/services/practice');
const exams = require('../src/services/exams');

async function studentCookie(s, username) {
  return (await login(s, username, 'StudentPass1')).cookie;
}

// ----------------------------------------------------------------- jalali
test('jalali: round-trip conversion and month grid', () => {
  // ۱ فروردین ۱۴۰۴ == ۲۱ مارس ۲۰۲۵
  assert.deepEqual(jalali.j2g(1404, 1, 1), { gy: 2025, gm: 3, gd: 21 });
  assert.deepEqual(jalali.g2j(2025, 3, 21), { jy: 1404, jm: 1, jd: 1 });

  // ۲۹ اسفندِ سال کبیسه و غیرکبیسه
  assert.equal(jalali.monthLength(1403, 12), 30, '1403 is leap');
  assert.equal(jalali.monthLength(1404, 12), 29, '1404 is not leap');

  // یک دورِ کاملِ ۳۰ ساله رفت‌وبرگشتی
  for (let jy = 1400; jy <= 1430; jy++) {
    for (const jm of [1, 6, 12]) {
      for (const jd of [1, 15, jalali.monthLength(jy, jm)]) {
        const g = jalali.j2g(jy, jm, jd);
        assert.deepEqual(jalali.g2j(g.gy, g.gm, g.gd), { jy, jm, jd }, `round-trip ${jy}/${jm}/${jd}`);
      }
    }
  }

  const grid = jalali.monthGrid(1404, 1);
  assert.equal(grid.monthName, 'فروردین');
  assert.equal(grid.days.length % 7, 0, 'grid is whole weeks');
  assert.equal(grid.days.filter(Boolean).length, 31);
  assert.deepEqual(jalali.shiftMonth(1404, 1, -1), { jy: 1403, jm: 12 });
  assert.deepEqual(jalali.shiftMonth(1404, 12, 1), { jy: 1405, jm: 1 });
});

// ----------------------------------------------------------------- settings
test('settings: defaults apply, unknown keys are rejected, values are coerced', async () => {
  const s = await start();
  try {
    const cookie = await adminCookie(s);
    const first = (await req(s, 'GET', '/api/admin/settings', { cookie })).data;
    assert.equal(first.settings.leaderboard_top_n, 5);
    assert.equal(first.settings.home_title, 'آزمون‌های مرحله‌ای');
    assert.equal(first.settings.show_calendar, true);
    assert.ok(Array.isArray(first.schema) && first.schema.length > 10, 'schema drives the admin form');

    const bad = await req(s, 'PATCH', '/api/admin/settings', { cookie, json: { not_a_key: 'x' } });
    assert.equal(bad.status, 400);
    assert.equal(bad.data.error.code, 'validation_failed');

    const notNumber = await req(s, 'PATCH', '/api/admin/settings', { cookie, json: { leaderboard_top_n: 'abc' } });
    assert.equal(notNumber.status, 400);

    const ok = await req(s, 'PATCH', '/api/admin/settings', {
      cookie, json: { home_title: 'آزمون‌های مرحله‌ای پپسینو', leaderboard_top_n: 3, show_calendar: false },
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.data.settings.home_title, 'آزمون‌های مرحله‌ای پپسینو');
    assert.equal(ok.data.settings.leaderboard_top_n, 3);
    assert.equal(ok.data.settings.show_calendar, false);

    // topN is clamped to the allowed range
    const clamped = await req(s, 'PATCH', '/api/admin/settings', { cookie, json: { leaderboard_top_n: 9999 } });
    assert.equal(clamped.data.settings.leaderboard_top_n, 100);
  } finally { await s.close(); }
});

// ----------------------------------------------------------------- home
test('home: dashboard aggregates texts, stats, phases, countdown and leaderboard', async () => {
  const s = await start();
  try {
    const db = s.db;
    const sid = addStudent(db, 'stu_home');
    const ex = buildExam(db);
    attachKey(s, ex.id);
    exams.transition(db, ex.id, 'published', { actor: 'admin' });
    // آزمونِ باز: شروع در گذشته، مهلت در آینده
    setStatus(db, ex.id, { starts_at: iso(-HOUR), submission_deadline: iso(HOUR) });

    db.prepare(`INSERT INTO strategic_phases (title, grade_id, starts_at, ends_at, sort_order, active, created_at, updated_at)
                VALUES ('مرحله اول', (SELECT id FROM grades WHERE code='g10'), ?, ?, 1, 1, ?, ?)`)
      .run(iso(-HOUR), iso(HOUR), iso(0), iso(0));

    const cookie = await studentCookie(s, 'stu_home');
    const r = await req(s, 'GET', '/api/student/home', { cookie });
    assert.equal(r.status, 200);
    const d = r.data;

    assert.equal(d.texts.home_title, 'آزمون‌های مرحله‌ای');
    assert.equal(d.student.id, sid);
    assert.ok(d.jalaliToday.jy >= 1400, 'jalali today is present');

    // آزمونِ جاری پیدا شده و شمارش معکوس تا پایان مهلت است
    assert.equal(d.currentExam.id, ex.id);
    assert.equal(d.currentExam.windowState, 'open');
    assert.equal(d.countdown.state, 'open');
    assert.ok(d.countdown.target);

    assert.equal(d.phases.length, 1);
    assert.equal(d.phases[0].title, 'مرحله اول');
    assert.equal(d.phases[0].status, 'open');

    assert.equal(d.upcomingExams.length, 1);
    assert.equal(d.expiredExams.length, 0);
    assert.ok(d.calendar, 'calendar is on by default');
    assert.equal(d.calendar.days.filter(Boolean).length >= 28, true);
    assert.deepEqual(d.stats, { satExams: 0, absentExams: 0, publishedResults: 0, bestQuarters: null, averageQuarters: null });
  } finally { await s.close(); }
});

test('home: window state is before / open / after and expired exams offer practice', async () => {
  const s = await start();
  try {
    const db = s.db;
    addStudent(db, 'stu_win');
    const future = buildExam(db, { title: 'آینده' });
    const past = buildExam(db, { title: 'گذشته' });
    attachKey(s, future.id); attachKey(s, past.id);
    exams.transition(db, future.id, 'published', { actor: 'admin' });
    exams.transition(db, past.id, 'published', { actor: 'admin' });
    setStatus(db, future.id, { starts_at: iso(2 * HOUR), submission_deadline: iso(3 * HOUR) });
    setStatus(db, past.id, { starts_at: iso(-3 * HOUR), submission_deadline: iso(-2 * HOUR) });

    const cookie = await studentCookie(s, 'stu_win');
    const d = (await req(s, 'GET', '/api/student/home', { cookie })).data;

    const f = d.upcomingExams.find((e) => e.id === future.id);
    assert.equal(f.windowState, 'before');
    assert.equal(new Date(f.countdownTarget).getTime(), new Date(f.starts_at).getTime());

    const p = d.expiredExams.find((e) => e.id === past.id);
    assert.equal(p.windowState, 'after');
    assert.equal(p.canPractice, true);
    assert.equal(p.countdownTarget, null, 'no countdown after the window closes');
  } finally { await s.close(); }
});

// -------------------------------------------------- expired exam → practice
test('expired exam converts to a practice set, once, and is visible to the student', async () => {
  const s = await start();
  try {
    const db = s.db;
    const sid = addStudent(db, 'stu_prac');
    const ex = buildExam(db);
    attachKey(s, ex.id);
    exams.transition(db, ex.id, 'published', { actor: 'admin' });
    setStatus(db, ex.id, { starts_at: iso(-3 * HOUR), submission_deadline: iso(-2 * HOUR) });

    const cookie = await adminCookie(s);

    // در فهرستِ آزمون‌های منقضی دیده می‌شود و هنوز تبدیل نشده
    const list = (await req(s, 'GET', '/api/admin/exams/expired', { cookie })).data.exams;
    const row = list.find((e) => e.id === ex.id);
    assert.ok(row, 'expired exam is listed');
    assert.equal(row.converted, false);

    const conv = await req(s, 'POST', `/api/admin/exams/${ex.id}/to-practice`, { cookie });
    assert.equal(conv.status, 200);
    assert.equal(conv.data.alreadyConverted, false);
    assert.equal(conv.data.sets.length, 1);
    const setId = conv.data.sets[0].id;

    // سؤالات کپی شده‌اند
    const qs = db.prepare('SELECT * FROM practice_questions WHERE set_id = ? ORDER BY position').all(setId);
    assert.equal(qs.length, ex.questionIds.length);
    assert.equal(qs[0].body, db.prepare('SELECT body FROM questions WHERE id = ?').get(ex.questionIds[0]).body);

    // مجموعه به آزمون مبدأ وصل است
    const src = practice.practiceSetSourceExam(db, setId);
    assert.equal(src.examId, ex.id);
    assert.equal(src.answerKeyShared, true);

    // اجرای دوباره باید همان نتیجه را بدهد، نه مجموعه‌ی تکراری
    const again = await req(s, 'POST', `/api/admin/exams/${ex.id}/to-practice`, { cookie });
    assert.equal(again.data.alreadyConverted, true);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM practice_sets WHERE source_exam_id = ?').get(ex.id).n, 1);

    // دانش‌آموز آن را در فهرست تمرین‌ها با نشان «از آزمون منقضی‌شده» می‌بیند
    const sc = await studentCookie(s, 'stu_prac');
    const homeData = (await req(s, 'GET', '/api/student/home', { cookie: sc })).data;
    const mine = homeData.practiceSets.find((p) => p.id === setId);
    assert.ok(mine, 'converted set shows up for the student');
    assert.equal(mine.fromExpiredExam, true);
    assert.equal(homeData.expiredExams.some((e) => e.id === ex.id), true);
    void sid;
  } finally { await s.close(); }
});

test('an exam that has not expired cannot be converted', async () => {
  const s = await start();
  try {
    const db = s.db;
    addStudent(db, 'stu_early');
    const ex = buildExam(db);
    attachKey(s, ex.id);
    exams.transition(db, ex.id, 'published', { actor: 'admin' });
    setStatus(db, ex.id, { starts_at: iso(-HOUR), submission_deadline: iso(HOUR) });

    const cookie = await adminCookie(s);
    const r = await req(s, 'POST', `/api/admin/exams/${ex.id}/to-practice`, { cookie });
    assert.equal(r.status, 409);
    assert.equal(r.data.error.code, 'exam_not_expired');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM practice_sets').get().n, 0);
  } finally { await s.close(); }
});

test('conversion can be switched off by a setting', async () => {
  const s = await start();
  try {
    const db = s.db;
    addStudent(db, 'stu_off');
    const ex = buildExam(db);
    attachKey(s, ex.id);
    exams.transition(db, ex.id, 'published', { actor: 'admin' });
    setStatus(db, ex.id, { starts_at: iso(-3 * HOUR), submission_deadline: iso(-2 * HOUR) });

    const cookie = await adminCookie(s);
    await req(s, 'PATCH', '/api/admin/settings', { cookie, json: { allow_practice_after_expiry: false } });
    const r = await req(s, 'POST', `/api/admin/exams/${ex.id}/to-practice`, { cookie });
    assert.equal(r.status, 400);
    assert.equal(r.data.error.code, 'practice_disabled');
  } finally { await s.close(); }
});

// ----------------------------------------------------------------- calendar
test('calendar: marks the days that have an exam', async () => {
  const s = await start();
  try {
    const db = s.db;
    addStudent(db, 'stu_cal');
    const ex = buildExam(db);
    attachKey(s, ex.id);
    exams.transition(db, ex.id, 'published', { actor: 'admin' });
    setStatus(db, ex.id, { starts_at: iso(-HOUR), submission_deadline: iso(HOUR) });

    const j = jalali.toJalali(iso(-HOUR));
    const cookie = await studentCookie(s, 'stu_cal');
    const r = await req(s, 'GET', `/api/student/calendar?jy=${j.jy}&jm=${j.jm}`, { cookie });
    assert.equal(r.status, 200);
    const cal = r.data.calendar;
    assert.equal(cal.jy, j.jy);
    const day = cal.days.find((d) => d && d.day === j.jd);
    assert.ok(day, 'exam day exists in the grid');
    assert.ok(day.exams.some((e) => e.id === ex.id), 'the exam is attached to its jalali day');
  } finally { await s.close(); }
});

// ----------------------------------------------------------------- printing
test('participants list is sorted and marks absent students', async () => {
  const s = await start();
  try {
    const db = s.db;
    const ex = buildExam(db);
    attachKey(s, ex.id);
    exams.transition(db, ex.id, 'published', { actor: 'admin' });
    setStatus(db, ex.id, { starts_at: iso(-HOUR), submission_deadline: iso(HOUR) });
    const a = addStudent(db, 'stu_p1');
    const b = addStudent(db, 'stu_p2');
    exams.recordSubmission(db, ex.id, a, { now: new Date() });
    require('../src/services/grading').markAbsent(db, ex.id, b, { actor: 'admin' });

    const cookie = await adminCookie(s);
    const r = await req(s, 'GET', `/api/admin/exams/${ex.id}/participants`, { cookie });
    assert.equal(r.status, 200);
    const p = r.data.participants;
    assert.equal(p.length, 2);
    const submitted = p.find((x) => x.studentId === a);
    const absent = p.find((x) => x.studentId === b);
    assert.equal(submitted.status, 'submitted');
    assert.equal(submitted.rank, 1);
    assert.equal(absent.status, 'absent');
    assert.equal(absent.rank, null, 'absent students get no rank');
    assert.equal(absent.totalMark, null);
  } finally { await s.close(); }
});

// ------------------------------------------------------- service-level units
test('home.windowState and countdownTarget follow the clock', () => {
  const now = new Date('2026-10-10T12:00:00.000Z');
  const before = { starts_at: '2026-10-10T13:00:00.000Z', submission_deadline: '2026-10-10T14:00:00.000Z' };
  const open = { starts_at: '2026-10-10T11:00:00.000Z', submission_deadline: '2026-10-10T13:00:00.000Z' };
  const after = { starts_at: '2026-10-10T09:00:00.000Z', submission_deadline: '2026-10-10T11:00:00.000Z' };

  assert.equal(home.windowState(before, now), 'before');
  assert.equal(home.windowState(open, now), 'open');
  assert.equal(home.windowState(after, now), 'after');

  assert.equal(home.countdownTarget(before, now).target, '2026-10-10T13:00:00.000Z');
  assert.equal(home.countdownTarget(open, now).target, '2026-10-10T13:00:00.000Z');
  assert.equal(home.countdownTarget(after, now).target, null);
});

test('settings.get falls back to the schema default', async () => {
  const s = await start();
  try {
    assert.equal(settings.get(s.db, 'brand_slogan'), 'Get Active to Grow');
    assert.equal(settings.get(s.db, 'home_head'), 'برنامه راهبردی');
    assert.equal(settings.get(s.db, 'unknown_key', 'fallback'), 'fallback');
  } finally { await s.close(); }
});
