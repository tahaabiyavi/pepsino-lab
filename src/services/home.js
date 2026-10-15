'use strict';
/**
 * صفحه‌ی اصلیِ پنل دانش‌آموز
 * ------------------------------------------------
 * تمام چیزی که روزِ اول روی صفحه‌ی اصلیِ پروژه‌ی قدیمی بود (معرفی برنامه،
 * شمارش معکوس، کارتِ مرحله‌ی جاری، آمار، برنامه‌ی مراحل، تقویم، آزمون‌های
 * پیش‌رو، رتبه‌بندی و راهنما) اینجا جمع شده و به پنل دانش‌آموز منتقل شده است.
 *
 * این سرویس فقط «خواندن» انجام می‌دهد و چند منبع را در یک پاسخ ترکیب
 * می‌کند تا صفحه با یک درخواست بالا بیاید.
 */
const jalali = require('./jalali');
const settings = require('./settings');
const strategic = require('./strategic');
const results = require('./results');
const practice = require('./practice');

/** وضعیتِ پنجره‌ی زمانی یک آزمون برای دانش‌آموز (قفل/باز/منقضی). */
function windowState(exam, now = new Date()) {
  const start = new Date(exam.starts_at);
  const end = new Date(exam.submission_deadline);
  if (now < start) return 'before';
  if (now > end) return 'after';
  return 'open';
}

/**
 * هدفِ شمارش معکوس: پیش از شروع تا شروع، حینِ آزمون تا پایان مهلت،
 * و پس از پایان دیگر شمارش معکوسی نیست.
 */
function countdownTarget(exam, now = new Date()) {
  const state = windowState(exam, now);
  if (state === 'before') return { state, target: new Date(exam.starts_at).toISOString() };
  if (state === 'open') return { state, target: new Date(exam.submission_deadline).toISOString() };
  return { state, target: null };
}

function withWindow(exam, now) {
  const cd = countdownTarget(exam, now);
  return {
    ...exam,
    windowState: cd.state,
    countdownTarget: cd.target,
    // آیا پس از انقضا می‌تواند تمرینی حل شود؟
    canPractice: cd.state === 'after',
  };
}

/** آزمون‌هایی که دانش‌آموز واجد شرایط آن‌هاست (پایه/رشته). */
function eligibleExams(db, studentId, now = new Date()) {
  return db.prepare(`
    SELECT e.*,
      (SELECT COUNT(*) FROM submissions s WHERE s.exam_id = e.id AND s.student_id = ?) AS mine,
      (SELECT s.status FROM submissions s WHERE s.exam_id = e.id AND s.student_id = ?) AS my_status
    FROM exams e
    WHERE e.status IN ('published','in_progress','submission_closed','grading','results_published')
      AND EXISTS (SELECT 1 FROM exam_grades g WHERE g.exam_id = e.id
                  AND g.grade_id = (SELECT grade_id FROM students WHERE id = ?))
    ORDER BY e.starts_at ASC
  `).all(studentId, studentId, studentId).map((e) => withWindow(e, now));
}

/** آمارِ کوتاهِ دانش‌آموز برای باکس‌های بالای صفحه. */
function studentStats(db, studentId) {
  const sat = db.prepare(`SELECT COUNT(*) n FROM submissions WHERE student_id = ? AND status = 'submitted'`).get(studentId).n;
  const absent = db.prepare(`SELECT COUNT(*) n FROM submissions WHERE student_id = ? AND status = 'absent'`).get(studentId).n;
  const published = db.prepare(`
    SELECT COUNT(*) n FROM submissions s
    JOIN exams e ON e.id = s.exam_id
    WHERE s.student_id = ? AND s.status = 'submitted' AND e.results_published_at IS NOT NULL
  `).get(studentId).n;

  // بهترین و میانگین نمره از مجموعِ نهایی‌شده
  const rows = db.prepare(`
    SELECT s.id, s.exam_id,
           (SELECT COALESCE(SUM(qs.quarters), 0) FROM question_scores qs
              JOIN grading_assignments ga ON ga.id = qs.assignment_id
             WHERE ga.submission_id = s.id) AS total_q
    FROM submissions s
    JOIN exams e ON e.id = s.exam_id
    WHERE s.student_id = ? AND s.status = 'submitted' AND e.results_published_at IS NOT NULL
  `).all(studentId);
  const totals = rows.map((r) => r.total_q).filter((n) => n !== null);
  const best = totals.length ? Math.max(...totals) : null;
  const avg = totals.length ? Math.round(totals.reduce((a, b) => a + b, 0) / totals.length) : null;

  return {
    satExams: sat,
    absentExams: absent,
    publishedResults: published,
    bestQuarters: best,
    averageQuarters: avg,
  };
}

/** نفرات برترِ آخرین آزمونِ منتشرشده‌ی دانش‌آموز (با مدال و محدودیت topN). */
function leaderboard(db, studentId, { topN = 5 } = {}) {
  const lastExam = db.prepare(`
    SELECT e.id, e.title FROM exams e
    JOIN submissions s ON s.exam_id = e.id
    WHERE s.student_id = ? AND e.results_published_at IS NOT NULL
    ORDER BY e.results_published_at DESC LIMIT 1
  `).get(studentId);
  if (!lastExam) return { exam: null, rows: [] };

  const ranked = results.examRanking(db, lastExam.id, { requirePublished: true });
  const rows = ranked.ranked.slice(0, topN > 0 ? topN : ranked.ranked.length).map((r, i) => ({
    rank: r.rank,
    studentId: r.studentId,
    fullName: r.fullName,
    totalMark: r.totalMark,
    medal: i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : null,
    isMe: r.studentId === studentId,
  }));
  // اگر خودِ دانش‌آموز در جمعِ برترها نبود، رتبه‌ی خودش را هم ضمیمه می‌کنیم
  const me = ranked.ranked.find((r) => r.studentId === studentId);
  const meRow = me && !rows.some((r) => r.studentId === studentId)
    ? { rank: me.rank, studentId: me.studentId, fullName: me.fullName, totalMark: me.totalMark, medal: null, isMe: true }
    : null;
  return {
    exam: { id: lastExam.id, title: lastExam.title },
    rows: meRow ? [...rows, meRow] : rows,
    excluded: ranked.excluded,
  };
}

/**
 * تقویمِ شمسیِ یک ماه، که در آن روزهای دارای آزمونِ دانش‌آموز نشانه‌گذاری
 * شده‌اند. تاریخ‌ها در دیتابیس میلادی‌اند و اینجا به شمسی ترجمه می‌شوند.
 */
function calendar(db, studentId, { jy, jm, now = new Date() } = {}) {
  const t = jalali.today(now);
  const year = Number.isFinite(jy) ? jy : t.jy;
  const month = Number.isFinite(jm) ? jm : t.jm;
  const grid = jalali.monthGrid(year, month);

  const examsByDay = {};
  for (const ex of eligibleExams(db, studentId, now)) {
    const j = jalali.toJalali(ex.starts_at);
    if (!j || j.jy !== year || j.jm !== month) continue;
    (examsByDay[j.jd] = examsByDay[j.jd] || []).push({
      id: ex.id,
      title: ex.title,
      windowState: ex.windowState,
      startsAt: ex.starts_at,
    });
  }

  return {
    jy: year,
    jm: month,
    monthName: grid.monthName,
    today: { jy: t.jy, jm: t.jm, jd: t.jd },
    days: grid.days.map((d) => (d === null ? null : { ...d, exams: examsByDay[d.day] || [] })),
  };
}

/** برنامه‌ی مراحل به‌صورت نمای جدولی (مثل خروجیِ چاپی پروژه‌ی قدیمی). */
function planTable(db, studentId, { now = new Date() } = {}) {
  const phases = strategic.listPhasesForStudent(db, studentId, { now });
  return phases.map((p) => ({
    ...p,
    jalaliStart: jalali.toJalali(p.startsAt),
    jalaliEnd: jalali.toJalali(p.endsAt),
  }));
}

/** یک پاسخِ کامل برای بالا آوردنِ صفحه‌ی اصلیِ پنل دانش‌آموز. */
function homeForStudent(db, studentId, { now = new Date() } = {}) {
  const texts = settings.getAll(db);
  const student = db.prepare('SELECT id, full_name, grade_id, field_id FROM students WHERE id = ?').get(studentId);
  const exams = eligibleExams(db, studentId, now);
  const phases = strategic.listPhasesForStudent(db, studentId, { now });

  const upcoming = exams.filter((e) => e.windowState !== 'after');
  const expired = exams.filter((e) => e.windowState === 'after');
  const current = upcoming.find((e) => e.windowState === 'open') || upcoming[0] || null;

  // مجموعه‌های تمرینِ در دسترس (شامل آن‌هایی که از آزمون منقضی ساخته شده‌اند)
  const practiceSets = practice.listPracticeSetsForStudent(db, studentId).map((s) => ({
    ...s,
    fromExpiredExam: !!practice.practiceSetSourceExam(db, s.id),
  }));

  return {
    texts,
    student: student ? { id: student.id, fullName: student.full_name } : null,
    now: now.toISOString(),
    jalaliToday: jalali.today(now),
    currentExam: current,
    countdown: current
      ? { ...countdownTarget(current, now), examId: current.id, title: current.title }
      : null,
    stats: studentStats(db, studentId),
    phases,
    upcomingExams: upcoming,
    expiredExams: expired,
    practiceSets,
    leaderboard: leaderboard(db, studentId, { topN: texts.leaderboard_top_n }),
    calendar: texts.show_calendar ? calendar(db, studentId, { now }) : null,
    planTable: texts.show_plan_table ? planTable(db, studentId, { now }) : null,
  };
}

module.exports = {
  homeForStudent, windowState, countdownTarget, eligibleExams, studentStats,
  leaderboard, calendar, planTable,
};
