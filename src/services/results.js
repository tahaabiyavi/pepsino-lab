'use strict';
// Results: exam ranking, grade and subject rankings, report cards and score history.
//
// Ranking rules (documented in docs/RESULTS_RULES.md):
//  - Only finalized official submissions with status 'submitted' are ranked.
//  - 'absent' and 'missing' students are excluded from ranking and reported as counts.
//  - Ties use competition ranking: 90, 90, 85 -> ranks 1, 1, 3.
//  - Grade and subject rankings average over the published exams a student
//    actually sat (finalized submissions). Averages are compared with exact
//    integer cross-multiplication, never floating point.
//  - Practice attempts are never used anywhere in this file.
const { conflict, notFound, badRequest } = require('./errors');
const { formatQuarters } = require('./marks');
const exams = require('./exams');

/** Finalized total per submission for one exam (quarters). */
function finalizedTotals(db, examId) {
  return db.prepare(
    `SELECT s.id AS submission_id, s.student_id, st.full_name, g.label AS grade, f.label AS field,
            SUM(qs.quarters) AS total
       FROM submissions s
       JOIN students st ON st.id = s.student_id
       JOIN grades g ON g.id = st.grade_id
       JOIN academic_fields f ON f.id = st.field_id
       JOIN grading_assignments a ON a.submission_id = s.id AND a.state = 'completed'
       JOIN question_scores qs ON qs.assignment_id = a.id
      WHERE s.exam_id = ? AND s.status = 'submitted'
      GROUP BY s.id`
  ).all(examId);
}

/** Competition ranking on a comparator-based key. `keyOf(row)` returns a comparable number pair. */
function competitionRank(rows, cmp) {
  const sorted = [...rows].sort(cmp);
  let rank = 0;
  let prev = null;
  return sorted.map((r, i) => {
    if (prev === null || cmp(prev, r) !== 0) rank = i + 1;
    prev = r;
    return { ...r, rank };
  });
}

function examRanking(db, examId, { requirePublished = true } = {}) {
  const exam = exams.getExam(db, examId);
  if (requirePublished && !exam.results_published_at) throw conflict('results_not_published', 'نتایج این آزمون هنوز منتشر نشده است');
  const rows = finalizedTotals(db, examId);
  const ranked = competitionRank(rows, (a, b) => b.total - a.total).map((r) => ({
    rank: r.rank,
    studentId: r.student_id,
    fullName: r.full_name,
    grade: r.grade,
    field: r.field,
    totalMark: formatQuarters(r.total),
  }));
  const counts = db.prepare(
    `SELECT SUM(CASE WHEN status = 'absent' THEN 1 ELSE 0 END) AS absent,
            SUM(CASE WHEN status = 'missing' THEN 1 ELSE 0 END) AS missing
       FROM submissions WHERE exam_id = ?`
  ).get(examId);
  return {
    examId,
    examTitle: exam.title,
    ranked,
    excluded: { absent: counts.absent || 0, missing: counts.missing || 0 },
  };
}

/** Per-student average over published exams: rows of { studentId, name, sum, count }. */
function averages(db, { academicYearId, gradeCode, subjectId = null }) {
  const grade = db.prepare('SELECT id FROM grades WHERE code = ?').get(gradeCode);
  if (!grade) throw badRequest('invalid_grade', 'پایه نامعتبر است');
  const rows = db.prepare(
    `SELECT s.id AS submission_id, st.id AS student_id, st.full_name, e.id AS exam_id, SUM(qs.quarters) AS total
       FROM exams e
       JOIN submissions s ON s.exam_id = e.id AND s.status = 'submitted'
       JOIN students st ON st.id = s.student_id AND st.grade_id = ?
       JOIN grading_assignments a ON a.submission_id = s.id AND a.state = 'completed'
       JOIN question_scores qs ON qs.assignment_id = a.id
       ${subjectId ? 'JOIN questions q ON q.id = qs.question_id AND q.subject_id = ?' : ''}
      WHERE e.academic_year_id = ? AND e.results_published_at IS NOT NULL
      GROUP BY s.id`
  ).all(...(subjectId ? [grade.id, subjectId, academicYearId] : [grade.id, academicYearId]));
  const byStudent = new Map();
  for (const r of rows) {
    const cur = byStudent.get(r.student_id) || { studentId: r.student_id, fullName: r.full_name, sum: 0, count: 0 };
    cur.sum += r.total;
    cur.count += 1;
    byStudent.set(r.student_id, cur);
  }
  return [...byStudent.values()];
}

function listRanking(db, opts, scopeLabel) {
  const rows = averages(db, opts);
  // Exact comparison of sum1/count1 vs sum2/count2 via cross multiplication.
  const ranked = competitionRank(rows, (a, b) => (b.sum * a.count) - (a.sum * b.count)).map((r) => ({
    rank: r.rank,
    studentId: r.studentId,
    fullName: r.fullName,
    examsCounted: r.count,
    averageMark: (r.sum / (4 * r.count)).toFixed(2),
  }));
  return { scope: scopeLabel, academicYearId: opts.academicYearId, gradeCode: opts.gradeCode, ranked };
}

function gradeRanking(db, { academicYearId, gradeCode }) {
  return listRanking(db, { academicYearId, gradeCode }, 'grade');
}

function subjectRanking(db, { academicYearId, gradeCode, subjectId }) {
  const subj = db.prepare('SELECT id FROM subjects WHERE id = ?').get(subjectId);
  if (!subj) throw badRequest('invalid_subject', 'درس نامعتبر است');
  return { ...listRanking(db, { academicYearId, gradeCode, subjectId }, 'subject'), subjectId };
}

/** Report card: subject totals and overall total only. No per-question marks, percentage or status. */
function reportCard(db, examId, studentId, { requirePublished = true } = {}) {
  const exam = exams.getExam(db, examId);
  if (requirePublished && !exam.results_published_at) throw conflict('results_not_published', 'نتایج این آزمون هنوز منتشر نشده است');
  const sub = db.prepare(
    `SELECT s.id, st.full_name, g.label AS grade, f.label AS field
       FROM submissions s JOIN students st ON st.id = s.student_id
       JOIN grades g ON g.id = st.grade_id JOIN academic_fields f ON f.id = st.field_id
      WHERE s.exam_id = ? AND s.student_id = ? AND s.status = 'submitted'`
  ).get(examId, studentId);
  if (!sub) throw notFound('کارنامه‌ای برای این آزمون وجود ندارد');
  const subjects = db.prepare(
    `SELECT sj.label AS subject, SUM(qs.quarters) AS total
       FROM grading_assignments a
       JOIN question_scores qs ON qs.assignment_id = a.id
       JOIN questions q ON q.id = qs.question_id
       JOIN subjects sj ON sj.id = q.subject_id
      WHERE a.submission_id = ? AND a.state = 'completed'
      GROUP BY sj.id ORDER BY sj.label`
  ).all(sub.id);
  if (subjects.length === 0) throw conflict('not_graded', 'این برگه هنوز نهایی نشده است');
  const overall = subjects.reduce((s, r) => s + r.total, 0);
  const rank = examRanking(db, examId, { requirePublished }).ranked.find((r) => r.studentId === studentId);
  return {
    examTitle: exam.title,
    studentName: sub.full_name,
    grade: sub.grade,
    field: sub.field,
    subjects: subjects.map((s) => ({ subject: s.subject, totalMark: formatQuarters(s.total) })),
    totalMark: formatQuarters(overall),
    rank: rank ? rank.rank : null,
  };
}

/** Chronological totals across published exams (official results only). */
function scoreHistory(db, studentId) {
  return db.prepare(
    `SELECT e.id AS exam_id, e.title, e.results_published_at, s.id AS submission_id,
            SUM(qs.quarters) AS total
       FROM submissions s
       JOIN exams e ON e.id = s.exam_id AND e.results_published_at IS NOT NULL
       JOIN grading_assignments a ON a.submission_id = s.id AND a.state = 'completed'
       JOIN question_scores qs ON qs.assignment_id = a.id
      WHERE s.student_id = ? AND s.status = 'submitted'
      GROUP BY s.id
      ORDER BY e.results_published_at`
  ).all(studentId).map((r) => ({
    examId: r.exam_id,
    examTitle: r.title,
    publishedAt: r.results_published_at,
    totalMark: formatQuarters(r.total),
  }));
}

module.exports = { examRanking, gradeRanking, subjectRanking, reportCard, scoreHistory, competitionRank, finalizedTotals };
