'use strict';
/**
 * سیستم برنامه راهبردی (Strategic Plan)
 * ------------------------------------------------
 * ادمین از پنل می‌تواند مراحل آزمون را CRUD کند.
 * هر مرحله شامل: عنوان، پایه، بازه تاریخ، مباحث، و لینک اختیاری به آزمون واقعی.
 * دانش‌آموز فقط مراحل مربوط به پایه خودش را می‌بیند و وضعیت هوشمند
 * (منقضی / قفل با شمارش معکوس / فعال) روی آن‌ها اعمال می‌شود.
 *
 * منطق الهام‌گرفته از پروژه قدیمی pepsinolab-exam-server-v5 (برنامه راهبردی مراحل).
 */
const { badRequest, notFound } = require('./errors');
const { recordAudit } = require('./audit');

const iso = (d) => new Date(d).toISOString();

function parseTime(v, field) {
  const t = Date.parse(v);
  if (!Number.isFinite(t)) throw badRequest('invalid_time', `${field} نامعتبر است`, { [field]: 'invalid' });
  return new Date(t);
}

/** لیست تمام مراحل (ادمین) */
function listPhases(db, { gradeId = null, activeOnly = false } = {}) {
  let sql = `
    SELECT p.*, g.code AS grade_code, g.label AS grade_label, e.title AS exam_title
      FROM strategic_phases p
      JOIN grades g ON g.id = p.grade_id
      LEFT JOIN exams e ON e.id = p.exam_id
  `;
  const params = [];
  const where = [];
  if (gradeId) { where.push('p.grade_id = ?'); params.push(gradeId); }
  if (activeOnly) { where.push('p.active = 1'); }
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ' ORDER BY p.sort_order, p.starts_at';
  return db.prepare(sql).all(...params).map(rowToPhase);
}

/** مراحل مربوط به پایه دانش‌آموز (پنل دانش‌آموز) */
function listPhasesForStudent(db, studentId, { now = new Date() } = {}) {
  const student = db.prepare('SELECT grade_id FROM students WHERE id = ? AND status = ?').get(studentId, 'active');
  if (!student) return [];
  const phases = listPhases(db, { gradeId: student.grade_id, activeOnly: true });
  return phases.map((p) => enrichStatus(p, now));
}

function enrichStatus(phase, now = new Date()) {
  const start = new Date(phase.startsAt);
  const end = new Date(phase.endsAt);
  let status = 'locked';
  let statusText = 'این آزمون هنوز قفل است';
  let countdownMs = null;
  if (now >= end) {
    status = 'expired';
    statusText = 'مدت زمان آزمون به پایان رسیده است';
  } else if (now >= start) {
    status = 'open';
    statusText = 'آزمون در حال برگزاری است';
    countdownMs = end - now;
  } else {
    status = 'locked';
    statusText = 'این آزمون هنوز قفل است';
    countdownMs = start - now;
  }
  return { ...phase, status, statusText, countdownMs };
}

function getPhase(db, id) {
  const row = db.prepare(`
    SELECT p.*, g.code AS grade_code, g.label AS grade_label, e.title AS exam_title
      FROM strategic_phases p
      JOIN grades g ON g.id = p.grade_id
      LEFT JOIN exams e ON e.id = p.exam_id
     WHERE p.id = ?
  `).get(id);
  if (!row) throw notFound('مرحله برنامه راهبردی یافت نشد');
  const topics = db.prepare(
    'SELECT id, label, subject_id, sort_order FROM strategic_phase_topics WHERE phase_id = ? ORDER BY sort_order, id'
  ).all(id);
  return { ...rowToPhase(row), topics };
}

function createPhase(db, input, { actor = 'admin', now = new Date() } = {}) {
  const title = (input.title || '').trim();
  if (title.length < 2 || title.length > 120) throw badRequest('validation_failed', 'عنوان مرحله باید بین ۲ تا ۱۲۰ کاراکتر باشد');
  const grade = resolveGrade(db, input.gradeCode || input.gradeId);
  const startsAt = parseTime(input.startsAt, 'startsAt');
  const endsAt = parseTime(input.endsAt, 'endsAt');
  if (startsAt >= endsAt) throw badRequest('invalid_schedule', 'تاریخ شروع باید قبل از پایان باشد');
  const sortOrder = Number.isInteger(input.sortOrder) ? input.sortOrder : 0;
  const topicsText = typeof input.topicsText === 'string' ? input.topicsText.trim() : null;
  let examId = null;
  if (input.examId) {
    const ex = db.prepare('SELECT id FROM exams WHERE id = ?').get(input.examId);
    if (!ex) throw badRequest('validation_failed', 'آزمون انتخاب‌شده نامعتبر است');
    examId = ex.id;
  }

  return db.transaction(() => {
    const info = db.prepare(`
      INSERT INTO strategic_phases (title, grade_id, starts_at, ends_at, sort_order, active, exam_id, topics_text, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
    `).run(title, grade.id, iso(startsAt), iso(endsAt), sortOrder, examId, topicsText, iso(now), iso(now));
    const id = Number(info.lastInsertRowid);
    if (Array.isArray(input.topics)) {
      const ins = db.prepare('INSERT INTO strategic_phase_topics (phase_id, subject_id, label, sort_order) VALUES (?, ?, ?, ?)');
      input.topics.forEach((t, i) => {
        const label = (t.label || t).toString().trim();
        if (label) ins.run(id, t.subjectId || null, label, t.sortOrder ?? i);
      });
    }
    recordAudit(db, { actor, action: 'strategic_phase_create', entityType: 'strategic_phase', entityId: id, details: title });
    return getPhase(db, id);
  })();
}

function updatePhase(db, id, input, { actor = 'admin', now = new Date() } = {}) {
  const existing = getPhase(db, id);
  return db.transaction(() => {
    const title = input.title !== undefined ? String(input.title).trim() : existing.title;
    if (title.length < 2 || title.length > 120) throw badRequest('validation_failed', 'عنوان مرحله نامعتبر است');
    let gradeId = existing.gradeId;
    if (input.gradeCode || input.gradeId) {
      gradeId = resolveGrade(db, input.gradeCode || input.gradeId).id;
    }
    const startsAt = input.startsAt ? parseTime(input.startsAt, 'startsAt') : new Date(existing.startsAt);
    const endsAt = input.endsAt ? parseTime(input.endsAt, 'endsAt') : new Date(existing.endsAt);
    if (startsAt >= endsAt) throw badRequest('invalid_schedule', 'تاریخ شروع باید قبل از پایان باشد');
    const sortOrder = input.sortOrder !== undefined ? Number(input.sortOrder) : existing.sortOrder;
    const active = input.active !== undefined ? (input.active ? 1 : 0) : (existing.active ? 1 : 0);
    const topicsText = input.topicsText !== undefined ? (input.topicsText || null) : existing.topicsText;
    let examId = existing.examId;
    if (input.examId !== undefined) {
      if (input.examId === null || input.examId === '') examId = null;
      else {
        const ex = db.prepare('SELECT id FROM exams WHERE id = ?').get(input.examId);
        if (!ex) throw badRequest('validation_failed', 'آزمون انتخاب‌شده نامعتبر است');
        examId = ex.id;
      }
    }
    db.prepare(`
      UPDATE strategic_phases SET title=?, grade_id=?, starts_at=?, ends_at=?, sort_order=?, active=?, exam_id=?, topics_text=?, updated_at=?
       WHERE id=?
    `).run(title, gradeId, iso(startsAt), iso(endsAt), sortOrder, active, examId, topicsText, iso(now), id);

    if (Array.isArray(input.topics)) {
      db.prepare('DELETE FROM strategic_phase_topics WHERE phase_id = ?').run(id);
      const ins = db.prepare('INSERT INTO strategic_phase_topics (phase_id, subject_id, label, sort_order) VALUES (?, ?, ?, ?)');
      input.topics.forEach((t, i) => {
        const label = (t.label || t).toString().trim();
        if (label) ins.run(id, t.subjectId || null, label, t.sortOrder ?? i);
      });
    }
    recordAudit(db, { actor, action: 'strategic_phase_update', entityType: 'strategic_phase', entityId: id });
    return getPhase(db, id);
  })();
}

function deletePhase(db, id, { actor = 'admin' } = {}) {
  getPhase(db, id);
  db.prepare('DELETE FROM strategic_phases WHERE id = ?').run(id);
  recordAudit(db, { actor, action: 'strategic_phase_delete', entityType: 'strategic_phase', entityId: id });
  return { ok: true };
}

function resolveGrade(db, codeOrId) {
  if (typeof codeOrId === 'number' || /^\d+$/.test(String(codeOrId))) {
    const g = db.prepare('SELECT id, code, label FROM grades WHERE id = ?').get(Number(codeOrId));
    if (!g) throw badRequest('validation_failed', 'پایه نامعتبر است');
    return g;
  }
  const g = db.prepare('SELECT id, code, label FROM grades WHERE code = ?').get(String(codeOrId));
  if (!g) throw badRequest('validation_failed', 'پایه نامعتبر است');
  return g;
}

function rowToPhase(r) {
  return {
    id: r.id,
    title: r.title,
    gradeId: r.grade_id,
    gradeCode: r.grade_code,
    gradeLabel: r.grade_label,
    startsAt: r.starts_at,
    endsAt: r.ends_at,
    sortOrder: r.sort_order,
    active: Boolean(r.active),
    examId: r.exam_id,
    examTitle: r.exam_title || null,
    topicsText: r.topics_text,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

module.exports = {
  listPhases, listPhasesForStudent, getPhase, createPhase, updatePhase, deletePhase, enrichStatus,
};
