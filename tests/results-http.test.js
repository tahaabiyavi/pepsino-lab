'use strict';
// Results, rankings, report cards, score history, appeals, practice mode,
// notifications and expired-upload cleanup. Scores are produced by the real
// grading services, not inserted directly.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { start, req, login, adminCookie, addStudent, buildExam, attachKey, setStatus, iso, PDF, HOUR, subjectId } = require('./support/fixtures');
const exams = require('../src/services/exams');
const grading = require('../src/services/grading');
const { createGraderAccount } = require('../src/services/accounts');
const { recordSubmission } = exams;
const { notifyExamPublished, scanPublicationEvents } = require('../src/services/notifications');
const { tick } = require('../src/services/publication');
const storage = require('../src/files/storage');

/** Build a fully graded exam with results published. Returns ids for the scenario. */
function gradedExam(s, { publishResults = true } = {}) {
  const db = s.db;
  const ex = buildExam(db);
  attachKey(s, ex.id);
  exams.transition(db, ex.id, 'published', { actor: 'admin' });
  setStatus(db, ex.id, { starts_at: iso(-HOUR), submission_deadline: iso(HOUR) });
  const A = addStudent(db, 'stu_rank_a');
  const B = addStudent(db, 'stu_rank_b');
  const C = addStudent(db, 'stu_rank_c');
  const D = addStudent(db, 'stu_rank_absent');
  const E = addStudent(db, 'stu_rank_missing');
  for (const sid of [A, B, C]) recordSubmission(db, ex.id, sid, { now: new Date() });
  grading.markAbsent(db, ex.id, D, { actor: 'admin' });
  grading.recordMissingForEligible(db, ex.id, [E], { now: new Date() });
  setStatus(db, ex.id, { starts_at: iso(-3 * HOUR), submission_deadline: iso(-HOUR), answer_key_publish_at: iso(-30 * 60e3), results_publish_at: iso(-10 * 60e3) });
  exams.transition(db, ex.id, 'submission_closed', { actor: 'admin' });
  const graderId = createGraderAccount(db, { displayName: 'مصحح آزمون', username: `grader_${ex.id}`, password: 'GraderPass1' }, { rounds: 4 }).id;
  grading.distributeExam(db, ex.id, { actor: 'admin' });
  exams.transition(db, ex.id, 'grading', { actor: 'admin' });
  const [q1, q2] = ex.questionIds;
  const marks = { [A]: ['1', '1'], [B]: ['1', '1'], [C]: ['1', '0.5'] };
  for (const a of db.prepare("SELECT a.id, s.student_id FROM grading_assignments a JOIN submissions s ON s.id = a.submission_id WHERE a.state = 'active'").all()) {
    const [m1, m2] = marks[a.student_id];
    grading.saveScores(db, a.id, graderId, { scores: [{ questionId: q1, mark: m1 }, { questionId: q2, mark: m2 }] }, { now: new Date() });
    grading.finalizeAssignment(db, a.id, graderId, { now: new Date() });
  }
  if (publishResults) setStatus(db, ex.id, { status: 'results_published', results_published_at: iso(-5 * 60e3) });
  return { ...ex, A, B, C, D, E, graderId, q1, q2 };
}

async function studentCookie(s, username) {
  return (await login(s, username, 'StudentPass1')).cookie;
}

// ----------------------------------------------------------------- rankings

test('exam ranking: competition ranks for ties; absent and missing excluded and counted', async () => {
  const s = await start();
  try {
    const g = gradedExam(s);
    const r = (await req(s, 'GET', `/api/admin/rankings/exams/${g.id}`, { cookie: await adminCookie(s) })).data.ranking;
    const order = r.ranked.map((x) => [x.rank, x.studentId, x.totalMark]);
    assert.deepEqual(order, [[1, g.A, '2'], [1, g.B, '2'], [3, g.C, '1.5']]);
    // Non-submitters are recorded as 'absent' when the window closes, so both the
    // administratively-absent student and the non-submitter count as absent.
    assert.deepEqual(r.excluded, { absent: 2, missing: 0 });
    // Students cannot see ranking before results are published (here: already published, so allowed).
    const stu = await req(s, 'GET', `/api/student/rankings/exams/${g.id}`, { cookie: await studentCookie(s, 'stu_rank_c') });
    assert.equal(stu.status, 200);
  } finally { await s.close(); }
});

test('exam ranking is hidden from students until results are published', async () => {
  const s = await start();
  try {
    const g = gradedExam(s, { publishResults: false });
    const r = await req(s, 'GET', `/api/student/rankings/exams/${g.id}`, { cookie: await studentCookie(s, 'stu_rank_a') });
    assert.equal(r.status, 409);
    assert.equal(r.data.error.code, 'results_not_published');
  } finally { await s.close(); }
});

test('subject and grade rankings: averages over sat exams, exact ties, own grade only for students', async () => {
  const s = await start();
  try {
    const g = gradedExam(s);
    const admin = await adminCookie(s);
    const grade = await req(s, 'GET', `/api/admin/rankings/grade?academicYearId=${g.academicYearId}&gradeCode=g10`, { cookie: admin });
    const ranked = grade.data.ranking.ranked.map((x) => [x.rank, x.studentId, x.averageMark]);
    assert.deepEqual(ranked, [[1, g.A, '2.00'], [1, g.B, '2.00'], [3, g.C, '1.50']]);
    const subj = await req(s, 'GET', `/api/admin/rankings/subject?academicYearId=${g.academicYearId}&gradeCode=g10&subjectId=${s.db.prepare("SELECT id FROM subjects WHERE code='math'").get().id}`, { cookie: admin });
    // Everyone scored 1.00 in mathematics: a full tie at rank 1.
    assert.deepEqual(subj.data.ranking.ranked.map((x) => x.rank), [1, 1, 1]);
    const other = await req(s, 'GET', `/api/student/rankings/grade?academicYearId=${g.academicYearId}&gradeCode=g11`, { cookie: await studentCookie(s, 'stu_rank_a') });
    assert.equal(other.status, 403);
  } finally { await s.close(); }
});

// ----------------------------------------------------------------- report card

test('report card: subject totals and overall total only; no per-question marks, percentage or status', async () => {
  const s = await start();
  try {
    const g = gradedExam(s);
    const r = await req(s, 'GET', `/api/student/report-cards/${g.id}`, { cookie: await studentCookie(s, 'stu_rank_c') });
    assert.equal(r.status, 200);
    const card = r.data.reportCard;
    assert.deepEqual(Object.keys(card).sort(), ['examTitle', 'field', 'grade', 'rank', 'studentName', 'subjects', 'totalMark']);
    assert.equal(card.totalMark, '1.5');
    assert.equal(card.rank, 3);
    assert.equal(card.subjects.length, 2);
    const text = r.text;
    assert.equal(/percent|درصد|status/i.test(text), false);
    assert.equal(text.includes('سوال ریاضی'), false, 'question text must not be in the report card');
  } finally { await s.close(); }
});

test('report card is refused to students for unpublished results and for absent students', async () => {
  const s = await start();
  try {
    const g = gradedExam(s);
    const absent = await req(s, 'GET', `/api/admin/report-cards/${g.id}/${g.D}`, { cookie: await adminCookie(s) });
    assert.equal(absent.status, 404);
    const other = await req(s, 'GET', `/api/student/report-cards/${g.id}`, { cookie: await studentCookie(s, 'stu_rank_absent') });
    assert.equal(other.status, 404);
  } finally { await s.close(); }
});

test('score history lists official totals only', async () => {
  const s = await start();
  try {
    const g = gradedExam(s);
    const h = await req(s, 'GET', '/api/student/score-history', { cookie: await studentCookie(s, 'stu_rank_c') });
    assert.equal(h.data.history.length, 1);
    assert.equal(h.data.history[0].totalMark, '1.5');
    assert.equal(h.data.history[0].examId, g.id);
  } finally { await s.close(); }
});

// ----------------------------------------------------------------- practice isolation

test('practice: self-assessed scores never change rankings, report cards or score history', async () => {
  const s = await start();
  try {
    const g = gradedExam(s);
    const adminC = await adminCookie(s);
    const math = s.db.prepare("SELECT id FROM subjects WHERE code='math'").get().id;
    const created = await req(s, 'POST', '/api/admin/practice-sets', {
      cookie: adminC,
      json: { title: 'تمرین ریاضی', gradeCode: 'g10', subjectId: math, questions: [
        { body: 'تمرین یک', maxMark: '2' }, { body: 'تمرین دو', maxMark: '1', explanatoryAnswer: 'پاسخ' },
      ] },
    });
    assert.equal(created.status, 201);
    const setId = created.data.id;
    const stu = await studentCookie(s, 'stu_rank_c');
    const before = {
      grade: (await req(s, 'GET', `/api/admin/rankings/grade?academicYearId=${g.academicYearId}&gradeCode=g10`, { cookie: adminC })).text,
      card: (await req(s, 'GET', `/api/student/report-cards/${g.id}`, { cookie: stu })).text,
      history: (await req(s, 'GET', '/api/student/score-history', { cookie: stu })).text,
      submissionFiles: s.db.prepare('SELECT COUNT(*) n FROM question_scores').get().n,
      scoreHistory: s.db.prepare('SELECT COUNT(*) n FROM score_history').get().n,
    };
    const attempt = (await req(s, 'POST', `/api/student/practice-sets/${setId}/attempts`, { cookie: stu })).data.attemptId;
    // Above the question maximum is refused.
    const q2Id = s.db.prepare('SELECT id FROM practice_questions WHERE set_id = ? AND position = 2').get(setId).id;
    const over = await req(s, 'PUT', `/api/student/practice-attempts/${attempt}/scores`, { cookie: stu, json: { scores: [{ questionId: q2Id, mark: '3' }] } });
    assert.equal(over.status, 400);
    const q1 = s.db.prepare('SELECT id FROM practice_questions WHERE set_id = ? AND position = 1').get(setId).id;
    const q2 = s.db.prepare('SELECT id FROM practice_questions WHERE set_id = ? AND position = 2').get(setId).id;
    const saved = await req(s, 'PUT', `/api/student/practice-attempts/${attempt}/scores`, { cookie: stu, json: { scores: [{ questionId: q1, mark: '2' }, { questionId: q2, mark: '0.75' }] } });
    assert.equal(saved.status, 200);
    // Explanatory answers stay hidden until the attempt is submitted.
    const hidden = await req(s, 'GET', `/api/student/practice-attempts/${attempt}`, { cookie: stu });
    assert.equal(hidden.text.includes('"پاسخ"'), false);
    const done = await req(s, 'POST', `/api/student/practice-attempts/${attempt}/submit`, { cookie: stu });
    assert.equal(done.data.attempt.selfTotal, '2.75');
    assert.equal(done.data.attempt.questions.find((x) => x.position === 2).explanatoryAnswer, 'پاسخ');
    // Practice did not touch official data.
    assert.equal((await req(s, 'GET', `/api/admin/rankings/grade?academicYearId=${g.academicYearId}&gradeCode=g10`, { cookie: adminC })).text, before.grade);
    assert.equal((await req(s, 'GET', `/api/student/report-cards/${g.id}`, { cookie: stu })).text, before.card);
    assert.equal((await req(s, 'GET', '/api/student/score-history', { cookie: stu })).text, before.history);
    assert.equal(s.db.prepare('SELECT COUNT(*) n FROM question_scores').get().n, before.submissionFiles);
    assert.equal(s.db.prepare('SELECT COUNT(*) n FROM score_history').get().n, before.scoreHistory);
    // Submitted attempts are locked.
    const late = await req(s, 'PUT', `/api/student/practice-attempts/${attempt}/scores`, { cookie: stu, json: { scores: [{ questionId: q1, mark: '1' }] } });
    assert.equal(late.status, 409);
  } finally { await s.close(); }
});

test('practice: students cannot open another grade\'s set or another student\'s attempt', async () => {
  const s = await start();
  try {
    const math = subjectId(s.db, 'math', 'ریاضی');
    const adminC = await adminCookie(s);
    const set = (await req(s, 'POST', '/api/admin/practice-sets', { cookie: adminC, json: { title: 'تمرین پایه یازدهم', gradeCode: 'g11', subjectId: math, questions: [{ body: 'سؤال', maxMark: '1' }] } })).data;
    const stu10 = addStudent(s.db, 'stu_p10');
    void stu10;
    const c10 = await studentCookie(s, 'stu_p10');
    assert.equal((await req(s, 'GET', `/api/student/practice-sets/${set.id}`, { cookie: c10 })).status, 404);
    addStudent(s.db, 'stu_p11', 'StudentPass1', 'g11');
    const c11 = await studentCookie(s, 'stu_p11');
    const attempt = (await req(s, 'POST', `/api/student/practice-sets/${set.id}/attempts`, { cookie: c11 })).data.attemptId;
    assert.equal((await req(s, 'GET', `/api/student/practice-attempts/${attempt}`, { cookie: c10 })).status, 403);
  } finally { await s.close(); }
});

// ----------------------------------------------------------------- appeals

test('appeals: one open per submission, correction recorded in history, decision notifies the student', async () => {
  const s = await start();
  try {
    const g = gradedExam(s);
    const adminC = await adminCookie(s);
    const subC = s.db.prepare('SELECT id FROM submissions WHERE exam_id = ? AND student_id = ?').get(g.id, g.C).id;
    const subA = s.db.prepare('SELECT id FROM submissions WHERE exam_id = ? AND student_id = ?').get(g.id, g.A).id;
    const cC = await studentCookie(s, 'stu_rank_c');
    // Another student cannot appeal C's sheet.
    const cA = await studentCookie(s, 'stu_rank_a');
    assert.equal((await req(s, 'POST', `/api/student/submissions/${subC}/appeals`, { cookie: cA, json: { questionId: g.q2, reason: 'این پاسخ من نیست بررسی شود' } })).status, 404);
    const made = await req(s, 'POST', `/api/student/submissions/${subC}/appeals`, { cookie: cC, json: { questionId: g.q2, reason: 'پاسخ سؤال فیزیک را دوباره بررسی کنید' } });
    assert.equal(made.status, 201);
    const appealId = made.data.appeal.id;
    const dup = await req(s, 'POST', `/api/student/submissions/${subC}/appeals`, { cookie: cC, json: { questionId: g.q2, reason: 'دوباره اعتراض می‌کنم با متن کافی' } });
    assert.equal(dup.status, 409);
    // Accepting needs the corrected mark.
    assert.equal((await req(s, 'POST', `/api/admin/appeals/${appealId}/decision`, { cookie: adminC, json: { decision: 'accept', note: 'بررسی شد' } })).status, 400);
    const acc = await req(s, 'POST', `/api/admin/appeals/${appealId}/decision`, { cookie: adminC, json: { decision: 'accept', note: 'نمره اصلاح شد', questionId: g.q2, newMark: '1' } });
    assert.equal(acc.status, 200);
    assert.equal(acc.data.result.status, 'accepted');
    const card = await req(s, 'GET', `/api/student/report-cards/${g.id}`, { cookie: cC });
    assert.equal(card.data.reportCard.totalMark, '2');
    assert.equal(s.db.prepare('SELECT COUNT(*) n FROM score_history WHERE submission_id = ?').get(subC).n, 1);
    const note = await req(s, 'GET', '/api/student/notifications', { cookie: cC });
    assert.ok(note.data.notifications.some((n) => n.kind === 'appeal_decided'));
    // A closed appeal cannot be decided again.
    assert.equal((await req(s, 'POST', `/api/admin/appeals/${appealId}/decision`, { cookie: adminC, json: { decision: 'reject', note: 'دوباره' } })).status, 409);
    // Admin rejection path on another sheet.
    const rej = await req(s, 'POST', `/api/student/submissions/${subA}/appeals`, { cookie: cA, json: { questionId: g.q1, reason: 'سؤال اول را کامل پاسخ داده‌ام' } });
    assert.equal(rej.status, 201);
    const rejected = await req(s, 'POST', `/api/admin/appeals/${rej.data.appeal.id}/decision`, { cookie: adminC, json: { decision: 'reject', note: 'نمره صحیح است' } });
    assert.equal(rejected.data.result.status, 'rejected');
    assert.ok((await req(s, 'GET', '/api/student/notifications', { cookie: cA })).data.notifications.some((n) => n.kind === 'appeal_decided'));
    // The admin was alerted through the outbox.
    assert.equal(s.db.prepare("SELECT COUNT(*) n FROM notification_outbox WHERE dedupe_key LIKE 'appeal_new:%'").get().n, 2);
  } finally { await s.close(); }
});

test('appeals: refused after the appeal window closes', async () => {
  const s = await start();
  try {
    const g = gradedExam(s);
    setStatus(s.db, g.id, { results_published_at: iso(-8 * 24 * HOUR) });
    const sub = s.db.prepare('SELECT id FROM submissions WHERE exam_id = ? AND student_id = ?').get(g.id, g.B).id;
    const r = await req(s, 'POST', `/api/student/submissions/${sub}/appeals`, { cookie: await studentCookie(s, 'stu_rank_b'), json: { questionId: g.q1, reason: 'مهلت اعتراض گذشته است' } });
    assert.equal(r.status, 409);
    assert.equal(r.data.error.code, 'appeal_window_closed');
  } finally { await s.close(); }
});

// ----------------------------------------------------------------- notifications

test('notifications: exam publication is idempotent and results notify each graded student once', async () => {
  const s = await start();
  try {
    const g = gradedExam(s);
    const c = await studentCookie(s, 'stu_rank_a');
    const before = (await req(s, 'GET', '/api/student/notifications', { cookie: c })).data.notifications.filter((n) => n.kind === 'results_published').length;
    assert.equal(before, 0, 'no notification before the scheduler scans publication events');
    scanPublicationEvents(s.db, new Date());
    scanPublicationEvents(s.db, new Date());
    assert.equal((await req(s, 'GET', '/api/student/notifications', { cookie: c })).data.notifications.filter((n) => n.kind === 'results_published').length, 1);
    const after = s.db.prepare("SELECT COUNT(*) n FROM notifications WHERE student_id = ? AND kind = 'results_published'").get(g.A).n;
    assert.equal(after, 1);
    const n1 = notifyExamPublished(s.db, g.id, new Date());
    const n2 = notifyExamPublished(s.db, g.id, new Date());
    assert.equal(n1, 5, 'all five active grade-10 students are eligible and notified once');
    assert.equal(n2, 0, 'second publication notification must not duplicate');
    const read = await req(s, 'POST', `/api/student/notifications/${(await req(s, 'GET', '/api/student/notifications', { cookie: c })).data.notifications[0].id}/read`, { cookie: c });
    assert.equal(read.status, 200);
  } finally { await s.close(); }
});

// ----------------------------------------------------------------- expired uploads

test('scheduler removes expired pending uploads, both rows and files', async () => {
  const s = await start();
  try {
    const g = buildExam(s.db);
    const sid = addStudent(s.db, 'stu_expired');
    const buf = PDF();
    const meta = storage.validateUpload({ buffer: buf, originalName: 'old.pdf' });
    const name = storage.writePrivate(s.dataDir, buf);
    s.db.prepare(`INSERT INTO pending_uploads (exam_id, student_id, storage_name, original_name, mime_type, size_bytes, sha256, created_at, expires_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(g.id, sid, name, meta.originalName, meta.mimeType, meta.sizeBytes, meta.sha256, iso(-2 * HOUR), iso(-HOUR));
    assert.ok(fs.existsSync(path.join(s.dataDir, 'private', name)));
    const out = tick(s.db, new Date(), { dataDir: s.dataDir });
    assert.equal(out.cleanedUploads, 1);
    assert.equal(s.db.prepare('SELECT COUNT(*) n FROM pending_uploads').get().n, 0);
    assert.equal(fs.existsSync(path.join(s.dataDir, 'private', name)), false);
  } finally { await s.close(); }
});
