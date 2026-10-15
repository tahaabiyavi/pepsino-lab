'use strict';
// Graders see the official answer key from the moment they hold a sheet of that
// exam, before publication. Students still cannot see it before publication.
const test = require('node:test');
const assert = require('node:assert/strict');
const { start, req, login, adminCookie, addStudent, buildExam, attachKey, setStatus, iso, HOUR } = require('./support/fixtures');
const exams = require('../src/services/exams');
const grading = require('../src/services/grading');
const { createGraderAccount } = require('../src/services/accounts');

/** Exam with one submitted sheet, distributed to a grader, deadline passed, key NOT yet published. */
function distributedExam(s) {
  const ex = buildExam(s.db);
  attachKey(s, ex.id);
  exams.transition(s.db, ex.id, 'published', { actor: 'admin' });
  setStatus(s.db, ex.id, { starts_at: iso(-HOUR), submission_deadline: iso(HOUR) });
  const stu = addStudent(s.db, 'stu_key_view');
  exams.recordSubmission(s.db, ex.id, stu, { now: new Date() });
  setStatus(s.db, ex.id, { starts_at: iso(-3 * HOUR), submission_deadline: iso(-HOUR), answer_key_publish_at: iso(24 * HOUR), results_publish_at: iso(25 * HOUR) });
  exams.transition(s.db, ex.id, 'submission_closed', { actor: 'admin' });
  const g1 = createGraderAccount(s.db, { displayName: 'مصحح یک', username: 'key_grader_1', password: 'GraderPass1' }, { rounds: 4 });
  grading.distributeExam(s.db, ex.id, { actor: 'admin' });
  return { ...ex, stu, g1 };
}

test('grader holding a sheet can open the official answer key before publication', async () => {
  const s = await start();
  try {
    const ex = distributedExam(s);
    const c = (await login(s, 'key_grader_1', 'GraderPass1')).cookie;
    const r = await req(s, 'GET', `/api/grader/exams/${ex.id}/answer-key`, { cookie: c });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-disposition'), /^attachment/);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(r.headers.get('content-type'), 'application/pdf');
    const view = await req(s, 'GET', `/api/grader/exams/${ex.id}/answer-key?inline=1`, { cookie: c });
    assert.equal(view.status, 200);
    assert.match(view.headers.get('content-disposition'), /^inline/);
    assert.ok(s.db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action = 'answer_key.viewed'").get().n >= 2, 'each view is audited');
    const asg = s.db.prepare('SELECT id FROM grading_assignments WHERE grader_id = ?').get(ex.g1.id);
    const page = await req(s, 'GET', `/api/grader/assignments/${asg.id}`, { cookie: c });
    assert.equal(page.data.answerKey.available, true);
    assert.equal(page.data.assignment.examId, ex.id);
  } finally { await s.close(); }
});

test('grader without a sheet of that exam is refused; anonymous and student callers are refused', async () => {
  const s = await start();
  try {
    const ex = distributedExam(s);
    createGraderAccount(s.db, { displayName: 'مصحح دو', username: 'key_grader_2', password: 'GraderPass2' }, { rounds: 4 });
    const other = (await login(s, 'key_grader_2', 'GraderPass2')).cookie;
    assert.equal((await req(s, 'GET', `/api/grader/exams/${ex.id}/answer-key`, { cookie: other })).status, 403);
    assert.equal((await req(s, 'GET', `/api/grader/exams/${ex.id}/answer-key`)).status, 401);
    const stuCookie = (await login(s, 'stu_key_view', 'StudentPass1')).cookie;
    assert.equal((await req(s, 'GET', `/api/grader/exams/${ex.id}/answer-key`, { cookie: stuCookie })).status, 403);
    assert.equal((await req(s, 'GET', `/api/student/exams/${ex.id}/answer-key`, { cookie: stuCookie })).status, 403);
  } finally { await s.close(); }
});

test("a grader whose sheet was reassigned away loses access to that exam's key", async () => {
  const s = await start();
  try {
    const ex = distributedExam(s);
    const g2 = createGraderAccount(s.db, { displayName: 'مصحح سه', username: 'key_grader_3', password: 'GraderPass3' }, { rounds: 4 });
    const c1 = (await login(s, 'key_grader_1', 'GraderPass1')).cookie;
    assert.equal((await req(s, 'GET', `/api/grader/exams/${ex.id}/answer-key`, { cookie: c1 })).status, 200);
    const sub = s.db.prepare('SELECT id FROM submissions WHERE exam_id = ?').get(ex.id).id;
    const adminC = await adminCookie(s);
    assert.equal((await req(s, 'POST', `/api/admin/submissions/${sub}/reassign`, { cookie: adminC, json: { graderId: g2.id, reason: 'تست' } })).status, 200);
    assert.equal((await req(s, 'GET', `/api/grader/exams/${ex.id}/answer-key`, { cookie: c1 })).status, 403);
  } finally { await s.close(); }
});

test('answer key not uploaded yet returns 404 to an assigned grader', async () => {
  const s = await start();
  try {
    const ex = distributedExam(s);
    s.db.prepare('DELETE FROM answer_keys WHERE exam_id = ?').run(ex.id);
    const c = (await login(s, 'key_grader_1', 'GraderPass1')).cookie;
    assert.equal((await req(s, 'GET', `/api/grader/exams/${ex.id}/answer-key`, { cookie: c })).status, 404);
  } finally { await s.close(); }
});
