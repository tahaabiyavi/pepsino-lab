'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeDb } = require('./helpers');
const { parseMarkToQuarters, formatQuarters, validateScoreQuarters } = require('../src/services/marks');
const exams = require('../src/services/exams');
const grading = require('../src/services/grading');
const pub = require('../src/services/publication');

const T = (hhmm) => `2026-10-10T${hhmm}:00.000Z`;
const at = (hhmm) => new Date(T(hhmm));
const silent = { info() {}, warn() {}, error() {} };

// ---------- helpers ----------
function baseDb() {
  const db = makeDb();
  db.prepare("INSERT INTO academic_years (label, starts_on, ends_on, created_at) VALUES ('1405-1406','2026-09-23','2027-06-20','2026-01-01')").run();
  db.prepare("INSERT INTO subjects (code, label) VALUES ('bio','زیست'), ('chem','شیمی')").run();
  db.prepare("INSERT INTO topics (subject_id, label) VALUES (1,'فصل 1'), (1,'فصل 2'), (2,'درجه یونش')").run();
  return db;
}
function addStudents(db, n, { grade = 1, field = 1 } = {}) {
  const ids = [];
  for (let i = 0; i < n; i++) {
    const r = db.prepare(`INSERT INTO students (username, password_hash, full_name, grade_id, field_id, status, created_at, updated_at)
      VALUES (?, 'x', ?, ?, ?, 'active', '2026-01-01', '2026-01-01')`).run(`st${db.prepare('SELECT COUNT(*) n FROM students').get().n + 1}`, `دانش‌آموز ${i}`, grade, field);
    ids.push(Number(r.lastInsertRowid));
  }
  return ids;
}
function addGraders(db, n) {
  return Array.from({ length: n }, (_, i) => grading.createGrader(db, { displayName: `مصحح ${i + 1}` }, { now: at('08:00') }).id);
}
function makeExam(db, { questions = [{ mark: '2', topic: 1 }, { mark: '1.5', topic: 2 }], grades = ['g10'] } = {}) {
  const ex = exams.createExam(db, {
    title: 'آزمون شبانه تست', academicYearId: 1, gradeCodes: grades,
    startsAt: T('10:00'), submissionDeadline: T('12:00'), answerKeyPublishAt: T('13:00'), resultsPublishAt: T('14:00'),
    durationMinutes: 30,
  }, { now: at('08:00') });
  for (const q of questions) {
    exams.addQuestion(db, ex.id, { body: `سؤال ${q.topic}`, maxMark: q.mark, subjectId: q.topic === 2 ? 2 : 1, topicIds: [q.topic === 2 ? 3 : q.topic] }, { now: at('08:00') });
  }
  db.prepare("INSERT INTO answer_keys (exam_id, original_name, mime_type, size_bytes, sha256, storage_name, uploaded_at) VALUES (?, 'key.pdf', 'application/pdf', 100, 'abc', ?, '2026-01-01')")
    .run(ex.id, `key-${ex.id}.bin`);
  exams.transition(db, ex.id, 'published', { now: at('09:00') });
  return ex.id;
}
function submitAll(db, examId, studentIds, now = at('10:30')) {
  return studentIds.map((sid) => exams.recordSubmission(db, examId, sid, { now }).id);
}
function scoreAndFinalize(db, graderId, assignmentId, mark = '1', now = at('12:30')) {
  const qs = db.prepare(`SELECT q.id FROM questions q JOIN grading_assignments a ON a.id = ?
                          JOIN submissions s ON s.id = a.submission_id WHERE q.exam_id = s.exam_id`).all(assignmentId);
  grading.saveScores(db, assignmentId, graderId, { scores: qs.map((q) => ({ questionId: q.id, mark })) }, { now });
  return grading.finalizeAssignment(db, assignmentId, graderId, { now });
}
const loadsByGrader = (db) => db.prepare(`SELECT grader_id, COUNT(*) n FROM grading_assignments WHERE state = 'active' GROUP BY grader_id`)
  .all().map((r) => r.n).sort((a, b) => a - b);

// ---------- marks ----------
test('marks: parses valid quarter-point values exactly', () => {
  assert.equal(parseMarkToQuarters('15.75'), 63);
  assert.equal(parseMarkToQuarters('0.25'), 1);
  assert.equal(parseMarkToQuarters('1.5'), 6);
  assert.equal(parseMarkToQuarters('0'), 0);
  assert.equal(parseMarkToQuarters(1.25), 5);
  assert.equal(formatQuarters(63), '15.75');
  assert.equal(formatQuarters(4), '1');
});

test('marks: rejects values that are not multiples of 0.25 or are malformed', () => {
  for (const bad of ['0.1', '0.3', '1.124', '-1', 'abc', '', '1e3', NaN, 0.1]) {
    assert.throws(() => parseMarkToQuarters(bad), (e) => e.status === 400, `should reject ${bad}`);
  }
});

test('marks: score cannot exceed the question maximum', () => {
  assert.equal(validateScoreQuarters(8, 8), 8);
  assert.throws(() => validateScoreQuarters(9, 8), (e) => e.code === 'mark_exceeds_max');
});

test('marks: example from the spec — 15.75 of 20 totals exactly', () => {
  const sum = [parseMarkToQuarters('10'), parseMarkToQuarters('5.75')].reduce((a, b) => a + b, 0);
  assert.equal(formatQuarters(sum), '15.75');
});

// ---------- examinations ----------
test('exams: multiple subjects, topics and marks compute the exam total', () => {
  const db = baseDb();
  const id = makeExam(db);
  const row = db.prepare('SELECT total_quarters FROM exams WHERE id = ?').get(id);
  assert.equal(row.total_quarters, 8 + 6); // 2 + 1.5 marks
});

test('exams: question with a topic from another subject is rejected', () => {
  const db = baseDb();
  const ex = exams.createExam(db, { title: 'آزمون تست', academicYearId: 1, gradeCodes: ['g10'], durationMinutes: 30,
    startsAt: T('10:00'), submissionDeadline: T('12:00'), answerKeyPublishAt: T('13:00'), resultsPublishAt: T('14:00') }, { now: at('08:00') });
  assert.throws(() => exams.addQuestion(db, ex.id, { body: 'x', maxMark: '1', subjectId: 1, topicIds: [3] }, { now: at('08:00') }),
    (e) => Boolean(e.details.topicIds));
});

test('exams: invalid schedule order is rejected', () => {
  const db = baseDb();
  assert.throws(() => exams.createExam(db, { title: 'آزمون تست', academicYearId: 1, gradeCodes: ['g10'], durationMinutes: 30,
    startsAt: T('10:00'), submissionDeadline: T('12:00'), answerKeyPublishAt: T('11:00'), resultsPublishAt: T('14:00') }),
    (e) => e.code === 'invalid_schedule');
});

test('exams: question marks are validated in 0.25 steps on creation', () => {
  const db = baseDb();
  const ex = exams.createExam(db, { title: 'آزمون تست', academicYearId: 1, gradeCodes: ['g10'], durationMinutes: 30,
    startsAt: T('10:00'), submissionDeadline: T('12:00'), answerKeyPublishAt: T('13:00'), resultsPublishAt: T('14:00') }, { now: at('08:00') });
  assert.throws(() => exams.addQuestion(db, ex.id, { body: 'x', maxMark: '0.3', subjectId: 1, topicIds: [1] }, { now: at('08:00') }),
    (e) => Boolean(e.details.maxMark));
});

test('exams: publication is blocked without an answer key (pre-publication validation)', () => {
  const db = baseDb();
  const ex = exams.createExam(db, { title: 'آزمون تست', academicYearId: 1, gradeCodes: ['g10'], durationMinutes: 30,
    startsAt: T('10:00'), submissionDeadline: T('12:00'), answerKeyPublishAt: T('13:00'), resultsPublishAt: T('14:00') }, { now: at('08:00') });
  exams.addQuestion(db, ex.id, { body: 'x', maxMark: '1', subjectId: 1, topicIds: [1] }, { now: at('08:00') });
  assert.throws(() => exams.transition(db, ex.id, 'published', { now: at('09:00') }), (e) => {
    return e.code === 'not_publishable' && e.details.problems.some((p) => p.field === 'answer_key');
  });
});

test('exams: lifecycle transitions are enforced by the backend', () => {
  const db = baseDb();
  const id = makeExam(db);
  assert.throws(() => exams.transition(db, id, 'grading', { now: at('12:30') }), (e) => e.code === 'invalid_transition');
});

test('exams: questions cannot be changed after publication', () => {
  const db = baseDb();
  const id = makeExam(db);
  assert.throws(() => exams.addQuestion(db, id, { body: 'late', maxMark: '1', subjectId: 1, topicIds: [1] }, { now: at('09:30') }),
    (e) => e.code === 'exam_locked');
});

test('submissions: enforce start time, deadline, eligibility and single submission', () => {
  const db = baseDb();
  const [sA] = addStudents(db, 1, { grade: 1 });
  const [sB] = addStudents(db, 1, { grade: 2 }); // grade 11 is not eligible
  const id = makeExam(db);
  assert.throws(() => exams.recordSubmission(db, id, sA, { now: at('09:59') }), (e) => e.code === 'exam_not_open' || e.code === 'not_started');
  assert.throws(() => exams.recordSubmission(db, id, sA, { now: at('12:00') }), (e) => e.code === 'deadline_passed');
  assert.throws(() => exams.recordSubmission(db, id, sB, { now: at('10:30') }), (e) => e.code === 'not_eligible');
  exams.recordSubmission(db, id, sA, { now: at('10:30') });
  assert.throws(() => exams.recordSubmission(db, id, sA, { now: at('10:31') }), (e) => e.code === 'already_submitted');
  assert.equal(db.prepare('SELECT status FROM exams WHERE id = ?').get(id).status, 'in_progress');
});

test('schedule edits are blocked from moving the deadline into the past once submissions exist', () => {
  const db = baseDb();
  const [s] = addStudents(db, 1);
  const id = makeExam(db);
  exams.recordSubmission(db, id, s, { now: at('10:30') });
  assert.throws(() => exams.updateSchedule(db, id, { submissionDeadline: T('11:00') }, { now: at('11:30') }),
    (e) => e.code === 'deadline_would_invalidate');
  // The change log is written for legitimate schedule edits.
  exams.updateSchedule(db, id, { resultsPublishAt: T('15:00') }, { now: at('10:45') });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM exam_change_log WHERE exam_id = ?').get(id).n, 1);
});

// ---------- assignment engine ----------
test('distribution: 102 sheets over 4 graders is 26/26/25/25 with no duplicates', () => {
  const db = baseDb();
  const students = addStudents(db, 102);
  const graders = addGraders(db, 4);
  const id = makeExam(db);
  submitAll(db, id, students);
  pub.tick(db, at('12:00')); // close window -> distribute
  assert.deepEqual(loadsByGrader(db), [25, 25, 26, 26]);
  const dup = db.prepare(`SELECT submission_id, COUNT(*) n FROM grading_assignments WHERE state='active' GROUP BY submission_id HAVING n > 1`).all();
  assert.equal(dup.length, 0);
  assert.equal(graders.length, 4);
});

test('distribution: uneven split (10 sheets, 3 graders) is 4/3/3', () => {
  const db = baseDb();
  const students = addStudents(db, 10);
  addGraders(db, 3);
  const id = makeExam(db);
  submitAll(db, id, students);
  const out = grading.distributeExam(db, id, { now: at('12:00') });
  assert.equal(out.created, 10);
  assert.deepEqual(loadsByGrader(db), [3, 3, 4]);
});

test('distribution: running the job twice creates no duplicate assignments', () => {
  const db = baseDb();
  const students = addStudents(db, 12);
  addGraders(db, 3);
  const id = makeExam(db);
  submitAll(db, id, students);
  grading.distributeExam(db, id, { now: at('12:00') });
  const second = grading.distributeExam(db, id, { now: at('12:05') });
  assert.equal(second.created, 0);
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM grading_assignments WHERE state='active'`).get().n, 12);
});

test('distribution: no active graders is a clear error and creates nothing', () => {
  const db = baseDb();
  const students = addStudents(db, 2);
  const id = makeExam(db);
  submitAll(db, id, students);
  assert.throws(() => grading.distributeExam(db, id, { now: at('12:00') }), (e) => e.code === 'no_active_graders');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM grading_assignments').get().n, 0);
});

test('reassignment: deactivating a grader moves only open work and keeps completed grading', () => {
  const db = baseDb();
  const students = addStudents(db, 9);
  const [g1, g2, g3] = addGraders(db, 3);
  const id = makeExam(db);
  submitAll(db, id, students);
  pub.tick(db, at('12:00'));
  // g1 finishes one sheet.
  const g1Open = db.prepare(`SELECT id FROM grading_assignments WHERE grader_id = ? AND state='active' ORDER BY id`).all(g1).map((r) => r.id);
  const done = g1Open[0];
  scoreAndFinalize(db, g1, done, '1');
  const completedBefore = db.prepare(`SELECT * FROM grading_assignments WHERE id = ?`).get(done);
  const scoresBefore = db.prepare('SELECT quarters FROM question_scores WHERE assignment_id = ? ORDER BY question_id').all(done);

  const res = grading.deactivateGrader(db, g1, { now: at('12:40') });
  assert.equal(res.count, g1Open.length - 1);
  // Completed record unchanged.
  assert.deepEqual(db.prepare(`SELECT * FROM grading_assignments WHERE id = ?`).get(done), completedBefore);
  assert.deepEqual(db.prepare('SELECT quarters FROM question_scores WHERE assignment_id = ? ORDER BY question_id').all(done), scoresBefore);
  // Old open rows are history, and nothing is left with the inactive grader.
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM grading_assignments WHERE grader_id = ? AND state='active'`).get(g1).n, 0);
  // Remaining active graders stay balanced (within one sheet).
  const loads = db.prepare(`SELECT grader_id, COUNT(*) n FROM grading_assignments WHERE state='active' AND grader_id IN (?,?,?) GROUP BY grader_id`)
    .all(g1, g2, g3).filter((r) => r.grader_id !== g1).map((r) => r.n);
  assert.ok(Math.max(...loads) - Math.min(...loads) <= 1, `loads ${loads}`);
});

test('reassignment: manual reassignment moves one open sheet and is recorded', () => {
  const db = baseDb();
  const students = addStudents(db, 4);
  const [g1, g2] = addGraders(db, 2);
  const id = makeExam(db);
  submitAll(db, id, students);
  pub.tick(db, at('12:00'));
  const a = db.prepare(`SELECT id, submission_id, grader_id FROM grading_assignments WHERE state='active' LIMIT 1`).get();
  const target = a.grader_id === g1 ? g2 : g1;
  grading.reassignSubmission(db, a.submission_id, target, { now: at('12:10'), reason: 'مصحح در دسترس نیست' });
  const active = db.prepare(`SELECT grader_id FROM grading_assignments WHERE submission_id = ? AND state='active'`).all(a.submission_id);
  assert.deepEqual(active.map((r) => r.grader_id), [target]);
  assert.ok(db.prepare(`SELECT 1 FROM audit_log WHERE action = 'grading.reassigned'`).get());
});

test('grading: a grader cannot open or score another grader\'s sheet', () => {
  const db = baseDb();
  const students = addStudents(db, 2);
  const [g1, g2] = addGraders(db, 2);
  const id = makeExam(db);
  submitAll(db, id, students);
  pub.tick(db, at('12:00'));
  const a = db.prepare(`SELECT id, grader_id FROM grading_assignments WHERE state='active' LIMIT 1`).get();
  const other = a.grader_id === g1 ? g2 : g1;
  assert.throws(() => grading.saveScores(db, a.id, other, { scores: [] }, { now: at('12:30') }), (e) => e.status === 403);
});

// ---------- grading ----------
test('grading: incomplete sheet cannot be finalized and totals sum correctly', () => {
  const db = baseDb();
  const students = addStudents(db, 1);
  const [g] = addGraders(db, 1);
  const id = makeExam(db);
  submitAll(db, id, students);
  pub.tick(db, at('12:00'));
  const a = db.prepare(`SELECT id FROM grading_assignments WHERE state='active'`).get();
  const q1 = db.prepare('SELECT id FROM questions WHERE exam_id = ? ORDER BY position LIMIT 1').get(id).id;
  grading.saveScores(db, a.id, g, { scores: [{ questionId: q1, mark: '1.75' }] }, { now: at('12:20') });
  assert.throws(() => grading.finalizeAssignment(db, a.id, g, { now: at('12:21') }), (e) => e.code === 'grading_incomplete');
  const q2 = db.prepare('SELECT id FROM questions WHERE exam_id = ? ORDER BY position LIMIT 1 OFFSET 1').get(id).id;
  const res = grading.saveScores(db, a.id, g, { scores: [{ questionId: q2, mark: '1.25' }] }, { now: at('12:22') });
  assert.equal(res.complete, true);
  const fin = grading.finalizeAssignment(db, a.id, g, { now: at('12:23') });
  assert.equal(fin.totalQuarters, 12); // 1.75 + 1.25 = 3 marks = 12 quarters
});

test('grading: score above the question maximum is rejected on the backend', () => {
  const db = baseDb();
  const students = addStudents(db, 1);
  const [g] = addGraders(db, 1);
  const id = makeExam(db);
  submitAll(db, id, students);
  pub.tick(db, at('12:00'));
  const a = db.prepare(`SELECT id FROM grading_assignments WHERE state='active'`).get();
  const q1 = db.prepare('SELECT id FROM questions WHERE exam_id = ? ORDER BY position LIMIT 1').get(id).id;
  assert.throws(() => grading.saveScores(db, a.id, g, { scores: [{ questionId: q1, mark: '2.25' }] }, { now: at('12:20') }),
    (e) => e.code === 'invalid_scores');
  assert.throws(() => grading.saveScores(db, a.id, g, { scores: [{ questionId: q1, mark: '0.3' }] }, { now: at('12:20') }),
    (e) => e.code === 'invalid_scores');
});

test('grading: corrections keep history, recalculate the total and require a reason', () => {
  const db = baseDb();
  const students = addStudents(db, 1);
  const [g] = addGraders(db, 1);
  const id = makeExam(db);
  const [subId] = submitAll(db, id, students);
  pub.tick(db, at('12:00'));
  const a = db.prepare(`SELECT id FROM grading_assignments WHERE state='active'`).get();
  const qs = db.prepare('SELECT id FROM questions WHERE exam_id = ? ORDER BY position').all(id).map((r) => r.id);
  grading.saveScores(db, a.id, g, { scores: [{ questionId: qs[0], mark: '2' }, { questionId: qs[1], mark: '1' }] }, { now: at('12:20') });
  grading.finalizeAssignment(db, a.id, g, { now: at('12:21') });
  assert.throws(() => grading.correctScore(db, subId, qs[0], '1', { reason: '' }, { now: at('13:00') }), (e) => e.code === 'reason_required');
  const r = grading.correctScore(db, subId, qs[0], '1.5', { reason: 'خطای جمع‌بندی', now: at('13:00') });
  assert.equal(r.previous, 8);
  assert.equal(r.quarters, 6);
  assert.equal(r.total, 6 + 4); // 1.5 + 1
  const hist = db.prepare('SELECT previous_quarters, new_quarters, reason FROM score_history WHERE submission_id = ?').get(subId);
  assert.deepEqual({ ...hist }, { previous_quarters: 8, new_quarters: 6, reason: 'خطای جمع‌بندی' });
});

test('absence is distinct from a zero: non-submitters and marked-absent become absent and are excluded, a zero still counts', () => {
  const db = baseDb();
  const [s1, s2, s3, s4] = addStudents(db, 4);
  const [g] = addGraders(db, 1);
  const id = makeExam(db);
  exams.recordSubmission(db, id, s1, { now: at('10:30') });
  exams.recordSubmission(db, id, s4, { now: at('10:31') });   // submits, but scores zero
  grading.markAbsent(db, id, s2, { now: at('10:40') });        // administratively absent
  pub.tick(db, at('12:00'));                                   // s3 never submitted
  const statuses = Object.fromEntries(db.prepare('SELECT student_id, status FROM submissions WHERE exam_id = ?').all(id).map((r) => [r.student_id, r.status]));

  // CHANGES: when the window closes, non-submitters are recorded as 'absent'.
  assert.equal(statuses[s1], 'submitted');
  assert.equal(statuses[s2], 'absent');
  assert.equal(statuses[s3], 'absent');
  assert.equal(statuses[s4], 'submitted');

  // Only the two real submissions are distributed for grading.
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM grading_assignments`).get().n, 2);

  // A zero is still a mark: score s4 zero and finish, then check the total is 0,
  // not "absent" — the ranked set contains s4 but not s2/s3.
  for (const { id: aid } of db.prepare(`SELECT id FROM grading_assignments WHERE state = 'active'`).all()) {
    const sub = db.prepare('SELECT s.id, s.student_id FROM submissions s JOIN grading_assignments a ON a.submission_id = s.id WHERE a.id = ?').get(aid);
    const qs = db.prepare('SELECT id FROM questions WHERE exam_id = ?').all(id);
    grading.saveScores(db, aid, g, { scores: qs.map((q) => ({ questionId: q.id, mark: sub.student_id === s4 ? '0' : '1' })) }, { now: at('12:30') });
    grading.finalizeAssignment(db, aid, g, { now: at('12:30') });
  }
  const totalOf = (sid) => {
    const row = db.prepare('SELECT id, status FROM submissions WHERE exam_id = ? AND student_id = ?').get(id, sid);
    if (!row || row.status !== 'submitted') return null;      // absent => no mark at all
    return grading.submissionTotalQuarters(db, row.id);
  };
  assert.equal(totalOf(s4), 0, 'a zero is recorded as 0 quarters');
  assert.ok(totalOf(s1) > 0);
  assert.equal(totalOf(s2), null, 'absent students carry no total at all');
  assert.equal(totalOf(s3), null);
});

// ---------- scheduled publication ----------
test('publication: answer key waits for its schedule; results wait for complete grading', () => {
  const db = baseDb();
  const students = addStudents(db, 2);
  const [g] = addGraders(db, 1);
  const id = makeExam(db);
  submitAll(db, id, students);
  pub.tick(db, at('12:00'));
  assert.equal(pub.publishDueAnswerKeys(db, at('12:30')).length, 0, 'before answer-key time');
  assert.equal(pub.publishDueAnswerKeys(db, at('13:00')).length, 1, 'at answer-key time');
  // Schedule passed, grading not done: results stay private.
  assert.equal(pub.publishDueResults(db, at('14:30')).length, 0);
  assert.equal(db.prepare('SELECT status FROM exams WHERE id = ?').get(id).status, 'grading');
  // Grade everything; the next tick publishes exactly once.
  for (const a of db.prepare(`SELECT id, grader_id FROM grading_assignments WHERE state='active'`).all()) {
    scoreAndFinalize(db, a.grader_id, a.id, '1', at('14:40'));
  }
  assert.deepEqual(pub.publishDueResults(db, at('14:45')), [id]);
  const first = db.prepare('SELECT results_published_at FROM exams WHERE id = ?').get(id).results_published_at;
  assert.deepEqual(pub.tick(db, at('15:00')).results, []);
  assert.equal(db.prepare('SELECT results_published_at FROM exams WHERE id = ?').get(id).results_published_at, first, 'no duplicate publication');
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM audit_log WHERE action = 'results.published'`).get().n, 1);
});

test('publication: overdue jobs are processed on the next tick after downtime', () => {
  const db = baseDb();
  const students = addStudents(db, 1);
  const [g] = addGraders(db, 1);
  const id = makeExam(db);
  submitAll(db, id, students);
  // Server was down from 10:30 until 16:00. One tick catches up everything.
  const out = pub.tick(db, at('16:00'));
  assert.deepEqual(out.closed, [id]);
  assert.deepEqual(out.answerKeys, [id]);
  const a = db.prepare(`SELECT id, grader_id FROM grading_assignments WHERE state='active'`).get();
  scoreAndFinalize(db, a.grader_id, a.id, '1', at('16:05'));
  assert.deepEqual(pub.publishDueResults(db, at('16:10')), [id], 'late grading publishes once complete');
  void g;
});

test('publication: tick is safe when run concurrently or repeatedly (no double close or distribution)', () => {
  const db = baseDb();
  const students = addStudents(db, 4);
  addGraders(db, 2);
  const id = makeExam(db);
  submitAll(db, id, students);
  pub.tick(db, at('12:00'));
  pub.tick(db, at('12:00'));
  pub.tick(db, at('12:01'));
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM grading_batches WHERE exam_id = ? AND kind = 'initial'`).get(id).n, 1);
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM grading_assignments`).get().n, 4);
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM audit_log WHERE action = 'exam.window_closed'`).get().n, 1);
});
