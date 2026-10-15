'use strict';
// Routes for results, rankings, report cards, score history, appeals,
// practice mode and student notifications.
const { requireRole } = require('../middleware/security');
const { badRequest, notFound, forbidden } = require('../services/errors');
const results = require('../services/results');
const appeals = require('../services/appeals');
const practice = require('../services/practice');
const storage = require('../files/storage');
const { normalizeIdParam } = require('./params');

function mountResultRoutes(app, { db, config }) {
  const adminOnly = requireRole('admin');
  const studentOnly = requireRole('student');
  const safe = (fn) => (req, res, next) => { try { fn(req, res, next); } catch (e) { next(e); } };
  const id = (v, label) => normalizeIdParam(v, label);

  // Student's own grade code, used to restrict grade/subject rankings for students.
  const ownGradeCode = (studentId) => db.prepare(
    'SELECT g.code FROM students s JOIN grades g ON g.id = s.grade_id WHERE s.id = ?'
  ).get(studentId).code;

  function rankingParams(req) {
    const academicYearId = id(req.query.academicYearId, 'سال تحصیلی');
    const gradeCode = String(req.query.gradeCode || '');
    if (!gradeCode) throw badRequest('invalid_grade', 'پایه لازم است');
    return { academicYearId, gradeCode };
  }

  // ---------------------------------------------------------- student: results
  app.get('/api/student/report-cards/:examId', studentOnly, safe((req, res) => {
    res.json({ reportCard: results.reportCard(db, id(req.params.examId, 'آزمون'), req.auth.id, { requirePublished: true }) });
  }));

  app.get('/api/student/score-history', studentOnly, safe((req, res) => {
    res.json({ history: results.scoreHistory(db, req.auth.id) });
  }));

  app.get('/api/student/rankings/exams/:examId', studentOnly, safe((req, res) => {
    res.json({ ranking: results.examRanking(db, id(req.params.examId, 'آزمون'), { requirePublished: true }) });
  }));

  app.get('/api/student/rankings/grade', studentOnly, safe((req, res) => {
    const p = rankingParams(req);
    if (p.gradeCode !== ownGradeCode(req.auth.id)) throw forbidden('فقط رتبه‌بندی پایه‌ی خود را می‌توانید ببینید');
    res.json({ ranking: results.gradeRanking(db, p) });
  }));

  app.get('/api/student/rankings/subject', studentOnly, safe((req, res) => {
    const p = rankingParams(req);
    if (p.gradeCode !== ownGradeCode(req.auth.id)) throw forbidden('فقط رتبه‌بندی پایه‌ی خود را می‌توانید ببینید');
    res.json({ ranking: results.subjectRanking(db, { ...p, subjectId: id(req.query.subjectId, 'درس') }) });
  }));

  // ---------------------------------------------------------- student: appeals
  app.post('/api/student/submissions/:id/appeals', studentOnly, safe((req, res) => {
    const b = req.body || {};
    const out = appeals.createAppeal(db, {
      submissionId: id(req.params.id, 'پاسخ'),
      studentId: req.auth.id,
      questionId: b.questionId ? id(b.questionId, 'سؤال') : null,
      reason: b.reason,
    }, { appealWindowDays: config.appealWindowDays, adminChatId: config.telegram.adminChatId });
    res.status(201).json({ appeal: out });
  }));

  app.get('/api/student/appeals', studentOnly, safe((req, res) => {
    res.json({ appeals: appeals.studentAppeals(db, req.auth.id) });
  }));

  // ---------------------------------------------------------- student: notifications
  app.get('/api/student/notifications', studentOnly, safe((req, res) => {
    const rows = db.prepare(
      'SELECT id, kind, title, body, created_at, read_at FROM notifications WHERE student_id = ? ORDER BY id DESC LIMIT 200'
    ).all(req.auth.id);
    const unread = rows.filter((r) => !r.read_at).length;
    res.json({ unread, notifications: rows });
  }));

  app.post('/api/student/notifications/:id/read', studentOnly, safe((req, res) => {
    const r = db.prepare('UPDATE notifications SET read_at = COALESCE(read_at, ?) WHERE id = ? AND student_id = ?')
      .run(new Date().toISOString(), id(req.params.id, 'اعلان'), req.auth.id);
    if (r.changes === 0) throw notFound('اعلان یافت نشد');
    res.json({ ok: true });
  }));

  // ---------------------------------------------------------- student: practice
  app.get('/api/student/practice-sets', studentOnly, safe((req, res) => {
    res.json({ sets: practice.listPracticeSetsForStudent(db, req.auth.id) });
  }));

  app.get('/api/student/practice-sets/:id', studentOnly, safe((req, res) => {
    res.json({ set: practice.getPracticeSetForStudent(db, id(req.params.id, 'مجموعه'), req.auth.id) });
  }));

  // مجموعه‌هایی که از یک آزمون منقضی‌شده ساخته شده‌اند می‌توانند پاسخنامه‌ی
  // رسمی همان آزمون را (پس از انتشار) در اختیار دانش‌آموز بگذارند تا خودش
  // پاسخ‌هایش را بررسی کند. نمره‌ی تمرینی همچنان جدا و غیررسمی می‌ماند.
  app.get('/api/student/practice-sets/:id/answer-key', studentOnly, safe((req, res) => {
    const setId = id(req.params.id, 'مجموعه');
    practice.getPracticeSetForStudent(db, setId, req.auth.id);   // مالکیت را بررسی می‌کند
    const src = practice.practiceSetSourceExam(db, setId);
    if (!src || !src.answerKeyShared) throw notFound('پاسخنامه‌ای برای این مجموعه وجود ندارد');
    const exam = db.prepare('SELECT * FROM exams WHERE id = ?').get(src.examId);
    const key = db.prepare('SELECT * FROM answer_keys WHERE exam_id = ?').get(src.examId);
    if (!exam || !key || !exam.answer_key_published_at) {
      throw forbidden('پاسخنامه‌ی رسمی هنوز منتشر نشده است');
    }
    sendPrivate(res, config, key);
  }));

  app.post('/api/student/practice-sets/:id/attempts', studentOnly, safe((req, res) => {
    res.status(201).json(practice.startAttempt(db, id(req.params.id, 'مجموعه'), req.auth.id, { now: new Date() }));
  }));

  app.get('/api/student/practice-attempts/:id', studentOnly, safe((req, res) => {
    res.json({ attempt: practice.getAttemptForStudent(db, id(req.params.id, 'تلاش'), req.auth.id) });
  }));

  app.put('/api/student/practice-attempts/:id/scores', studentOnly, safe((req, res) => {
    res.json(practice.saveAttemptScores(db, id(req.params.id, 'تلاش'), req.auth.id, (req.body || {}).scores, { now: new Date() }));
  }));

  app.post('/api/student/practice-attempts/:id/submit', studentOnly, safe((req, res) => {
    res.json({ attempt: practice.submitAttempt(db, id(req.params.id, 'تلاش'), req.auth.id, { now: new Date() }) });
  }));

  // ---------------------------------------------------------- admin: results
  app.get('/api/admin/report-cards/:examId/:studentId', adminOnly, safe((req, res) => {
    res.json({ reportCard: results.reportCard(db, id(req.params.examId, 'آزمون'), id(req.params.studentId, 'دانش‌آموز'), { requirePublished: false }) });
  }));

  app.get('/api/admin/students/:id/score-history', adminOnly, safe((req, res) => {
    res.json({ history: results.scoreHistory(db, id(req.params.id, 'دانش‌آموز')) });
  }));

  app.get('/api/admin/rankings/exams/:examId', adminOnly, safe((req, res) => {
    res.json({ ranking: results.examRanking(db, id(req.params.examId, 'آزمون'), { requirePublished: false }) });
  }));

  app.get('/api/admin/rankings/grade', adminOnly, safe((req, res) => {
    res.json({ ranking: results.gradeRanking(db, rankingParams(req)) });
  }));

  app.get('/api/admin/rankings/subject', adminOnly, safe((req, res) => {
    res.json({ ranking: results.subjectRanking(db, { ...rankingParams(req), subjectId: id(req.query.subjectId, 'درس') }) });
  }));

  // ---------------------------------------------------------- admin: appeals
  app.get('/api/admin/appeals', adminOnly, safe((req, res) => {
    const status = ['open', 'accepted', 'rejected'].includes(req.query.status) ? req.query.status : null;
    res.json({ appeals: appeals.listAppeals(db, { status }) });
  }));

  app.post('/api/admin/appeals/:id/decision', adminOnly, safe((req, res) => {
    const b = req.body || {};
    const out = appeals.decideAppeal(db, id(req.params.id, 'اعتراض'), {
      decision: b.decision,
      note: b.note,
      questionId: b.questionId ? id(b.questionId, 'سؤال') : null,
      newMark: b.newMark ?? null,
    }, { now: new Date(), actor: 'admin' });
    res.json({ result: out });
  }));

  // ---------------------------------------------------------- admin: practice
  app.get('/api/admin/practice-sets', adminOnly, safe((_req, res) => {
    res.json({ sets: practice.listPracticeSetsForAdmin(db) });
  }));

  app.post('/api/admin/practice-sets', adminOnly, safe((req, res) => {
    const b = req.body || {};
    res.status(201).json(practice.createPracticeSet(db, {
      title: b.title, gradeCode: b.gradeCode, subjectId: b.subjectId, questions: b.questions,
    }, { now: new Date(), actor: 'admin' }));
  }));

  app.patch('/api/admin/practice-sets/:id', adminOnly, safe((req, res) => {
    if (typeof (req.body || {}).active !== 'boolean') throw badRequest('invalid_input', 'مقدار فعال بودن لازم است');
    res.json(practice.setActive(db, id(req.params.id, 'مجموعه'), req.body.active, { actor: 'admin' }));
  }));

}

module.exports = { mountResultRoutes };

// فایل‌های خصوصی با نوعِ تأییدشده، nosniff و no-store فرستاده می‌شوند.
function sendPrivate(res, config, f, { inline = false } = {}) {
  const buf = storage.readPrivate(config.dataDir, f.storage_name);
  const safeName = storage.sanitizeName(f.original_name).replace(/"/g, '');
  res.set({
    'Content-Type': f.mime_type,
    'Content-Length': String(buf.length),
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(safeName)}`,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, no-store',
    'Content-Security-Policy': "default-src 'none'; sandbox",
  });
  res.end(buf);
}
