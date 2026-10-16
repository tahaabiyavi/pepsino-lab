'use strict';
// HTTP routes for exams, grading, answer sheets and answer keys.
// Role boundaries (enforced here, not in the UI):
//   admin   (Super Admin, single account)  : exams, schedule, publication, graders, overrides
//   grader  (own login, no admin rights)   : only assignments assigned to them
//   student (own login)                    : own uploads/submission and published answer keys
const multer = require('multer');
const { requireRole } = require('../middleware/security');
const { AppError, badRequest, forbidden, notFound, conflict } = require('../services/errors');
const { recordAudit } = require('../services/audit');
const exams = require('../services/exams');
const { classifyAudioUrl } = require('../services/audioLink');
const home = require('../services/home');
const grading = require('../services/grading');
const { createGraderAccount, setGraderActive, updateStudent, issuePasswordReset } = require('../services/accounts');
const { tick } = require('../services/publication');
const { formatQuarters } = require('../services/marks');
const storage = require('../files/storage');
const { revokeGraderSessions } = require('../auth/sessions');
const { notifyExamPublished } = require('../services/notifications');

const MAX_PENDING_PER_EXAM = 20;

function uploadSingle(req, res, next) {
  const mw = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: storage.MAX_BYTES, files: 1, fields: 5, parts: 8 },
  }).single('file');
  mw(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') return next(new AppError(413, 'file_too_large', 'حجم فایل بیش از ۱۰ مگابایت است'));
    if (err.code === 'LIMIT_UNEXPECTED_FILE' || err.code === 'LIMIT_FILE_COUNT') return next(badRequest('invalid_upload', 'فقط یک فایل مجاز است'));
    return next(badRequest('invalid_upload', 'درخواست آپلود نامعتبر است'));
  });
}

const idParam = (v, label = 'شناسه') => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw badRequest('invalid_id', `${label} نامعتبر است`);
  return n;
};

// A grader may open only work that is currently active or completed for them.
// Reassigned work is removed from their view and is refused here.
function ownActiveAssignment(db, id, graderId) {
  const a = grading.getAssignmentForGrader(db, id, graderId);
  if (a.state === 'reassigned') throw forbidden('این برگه دیگر به شما تخصیص داده نشده است');
  return a;
}

function mountExamRoutes(app, { db, config, log = console, triggerOutbox = () => {} }) {
  const adminOnly = requireRole('admin');
  const graderOnly = requireRole('grader');
  const studentOnly = requireRole('student');
  const safeRoute = (fn) => (req, res, next) => { try { fn(req, res, next); } catch (e) { next(e); } };

  // ---------------------------------------------------------------- admin: exams
  app.get('/api/admin/exams', adminOnly, (_req, res) => {
    res.json({
      exams: db.prepare(`SELECT id, title, status, starts_at, submission_deadline, answer_key_publish_at, results_publish_at,
                                answer_key_published_at, results_published_at
                           FROM exams ORDER BY starts_at DESC LIMIT 200`).all(),
    });
  });

  app.post('/api/admin/exams', adminOnly, safeRoute((req, res) => {
    const out = exams.createExam(db, req.body || {}, { actor: 'admin' });
    res.status(201).json(out);
  }));

  app.get('/api/admin/exams/:id', adminOnly, safeRoute((req, res) => {
    const id = idParam(req.params.id);
    const exam = exams.getExam(db, id);
    const questions = db.prepare(
      `SELECT q.id, q.position, s.code AS subject, q.body, q.max_quarters, q.grading_instructions
         FROM questions q JOIN subjects s ON s.id = q.subject_id WHERE q.exam_id = ? ORDER BY q.position`
    ).all(id).map((q) => ({ ...q, max_mark: formatQuarters(q.max_quarters) }));
    const hasKey = db.prepare('SELECT COUNT(*) n FROM answer_keys WHERE exam_id = ?').get(id).n > 0;
    const qFile = db.prepare('SELECT original_name, size_bytes, uploaded_at FROM exam_question_files WHERE exam_id = ?').get(id);
    const aFile = db.prepare('SELECT original_name, mime_type, size_bytes, uploaded_at, audio_url FROM exam_audio_files WHERE exam_id = ?').get(id);
    const aInfo = aFile && aFile.audio_url ? classifyAudioUrl(aFile.audio_url) : null;
    const subjects = db.prepare(
      `SELECT s.id, s.code, s.label FROM exam_subjects es JOIN subjects s ON s.id = es.subject_id
        WHERE es.exam_id = ? ORDER BY s.id`,
    ).all(id);
    res.json({
      exam,
      questions,
      hasAnswerKey: hasKey,
      hasQuestionsFile: Boolean(qFile),
      questionsFile: qFile || null,
      // فایلِ صوتیِ لیسنینگ فقط برای آزمونِ زبان انگلیسی معنا دارد
      hasEnglish: hasEnglish(db, id),
      hasAudioFile: Boolean(aFile),
      audioFile: aFile || null,
      audioUrl: aFile && aFile.audio_url ? aFile.audio_url : null,
      audioKind: aInfo ? aInfo.kind : (aFile ? 'direct' : null),
      subjects,
      publicationProblems: exams.publicationProblems(db, id),
    });
  }));

  app.post('/api/admin/exams/:id/questions', adminOnly, safeRoute((req, res) => {
    const id = idParam(req.params.id);
    res.status(201).json(exams.addQuestion(db, id, req.body || {}, { actor: 'admin' }));
  }));

  app.patch('/api/admin/exams/:id/schedule', adminOnly, safeRoute((req, res) => {
    const id = idParam(req.params.id);
    res.json(exams.updateSchedule(db, id, req.body || {}, { actor: 'admin' }));
  }));

  // ویرایشِ مشخصاتِ آزمون: عنوان، مدت، توضیحات (زمان‌بندی دست‌نخورده باقی می‌ماند)
  app.patch('/api/admin/exams/:id', adminOnly, safeRoute((req, res) => {
    const id = idParam(req.params.id);
    res.json(exams.updateExam(db, id, req.body || {}, { actor: 'admin' }));
  }));

  // حذفِ کاملِ آزمون به‌همراهِ فایل‌ها
  app.delete('/api/admin/exams/:id', adminOnly, safeRoute((req, res) => {
    const id = idParam(req.params.id);
    const out = exams.deleteExam(db, id, { actor: 'admin', dataDir: config.dataDir });
    // پس از تعهدِ تراکنش، فایل‌های روی دیسک را هم پاک کن
    for (const name of out.storageNames) {
      try { storage.removePrivate(config.dataDir, name); } catch (e) { /* فایل از قبل نبود */ }
    }
    res.json({ id: out.id, title: out.title, questions: out.questions, submissions: out.submissions });
  }));

  app.post('/api/admin/exams/:id/transition', adminOnly, safeRoute((req, res) => {
    const id = idParam(req.params.id);
    const to = req.body && req.body.to;
    if (typeof to !== 'string') throw badRequest('invalid_input', 'وضعیت مقصد لازم است');
    const out = exams.transition(db, id, to, { actor: 'admin', force: false });
    if (to === 'published') notifyExamPublished(db, id, new Date());
    res.json(out);
  }));

  // Answer key upload. Replaces any previous key, but never after publication.
  app.post('/api/admin/exams/:id/answer-key', adminOnly, uploadSingle, safeRoute((req, res) => {
    const id = idParam(req.params.id);
    const exam = exams.getExam(db, id);
    if (!req.file) throw badRequest('invalid_upload', 'فایل پاسخنامه لازم است');
    if (exam.status === 'archived') throw conflict('exam_locked', 'آزمون بایگانی شده است');
    if (exam.answer_key_published_at) throw conflict('answer_key_published', 'پاسخنامه پس از انتشار قابل تغییر نیست');
    const meta = storage.validateUpload({ buffer: req.file.buffer, originalName: req.file.originalname });
    const name = storage.writePrivate(config.dataDir, req.file.buffer);
    const old = db.prepare('SELECT storage_name FROM answer_keys WHERE exam_id = ?').get(id);
    const now = new Date().toISOString();
    db.transaction(() => {
      db.prepare(`INSERT INTO answer_keys (exam_id, original_name, mime_type, size_bytes, sha256, storage_name, uploaded_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?)
                  ON CONFLICT(exam_id) DO UPDATE SET original_name = excluded.original_name, mime_type = excluded.mime_type,
                    size_bytes = excluded.size_bytes, sha256 = excluded.sha256, storage_name = excluded.storage_name, uploaded_at = excluded.uploaded_at`)
        .run(id, meta.originalName, meta.mimeType, meta.sizeBytes, meta.sha256, name, now);
      recordAudit(db, { actor: 'admin', action: 'answer_key.uploaded', entityType: 'exam', entityId: id, details: { sha256: meta.sha256, size: meta.sizeBytes } });
    })();
    if (old) storage.removePrivate(config.dataDir, old.storage_name);
    res.status(201).json({ ok: true, sizeBytes: meta.sizeBytes });
  }));

  // فایل واحد سؤالات آزمون (PDF یا تصویر) — جایگزین آپلود دانه‌دانه سؤال
  app.post('/api/admin/exams/:id/questions-file', adminOnly, uploadSingle, safeRoute((req, res) => {
    const id = idParam(req.params.id);
    const exam = exams.getExam(db, id);
    if (!req.file) throw badRequest('invalid_upload', 'فایل سؤالات لازم است');
    if (exam.status === 'archived') throw conflict('exam_locked', 'آزمون بایگانی شده است');
    if (!['draft', 'published'].includes(exam.status) && exam.status !== 'draft') {
      // اجازه در draft و published قبل از شروع
    }
    const meta = storage.validateUpload({ buffer: req.file.buffer, originalName: req.file.originalname });
    const name = storage.writePrivate(config.dataDir, req.file.buffer);
    const old = db.prepare('SELECT storage_name FROM exam_question_files WHERE exam_id = ?').get(id);
    const now = new Date().toISOString();
    const questionCount = req.body && req.body.questionCount ? Number(req.body.questionCount) : null;
    db.transaction(() => {
      db.prepare(`INSERT INTO exam_question_files (exam_id, original_name, mime_type, size_bytes, sha256, storage_name, uploaded_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?)
                  ON CONFLICT(exam_id) DO UPDATE SET original_name = excluded.original_name, mime_type = excluded.mime_type,
                    size_bytes = excluded.size_bytes, sha256 = excluded.sha256, storage_name = excluded.storage_name, uploaded_at = excluded.uploaded_at`)
        .run(id, meta.originalName, meta.mimeType, meta.sizeBytes, meta.sha256, name, now);
      if (Number.isInteger(questionCount) && questionCount > 0 && questionCount <= 100) {
        db.prepare('UPDATE exams SET question_count = ?, updated_at = ? WHERE id = ?').run(questionCount, now, id);
        // ساخت رکوردهای سؤال با حداکثر ۲ نمره (۸ کوارتر) برای تصحیح
        const existing = db.prepare('SELECT COUNT(*) n FROM questions WHERE exam_id = ?').get(id).n;
        if (existing === 0) {
          // اولین درس مرتبط یا درس پیش‌فرض
          let subjectId = db.prepare('SELECT subject_id FROM exam_subjects WHERE exam_id = ? LIMIT 1').get(id);
          if (!subjectId) subjectId = db.prepare('SELECT id FROM subjects WHERE active = 1 ORDER BY id LIMIT 1').get();
          const sid = subjectId ? (subjectId.subject_id || subjectId.id) : 1;
          const ins = db.prepare(`INSERT INTO questions (exam_id, position, subject_id, body, max_quarters) VALUES (?, ?, ?, ?, 8)`);
          for (let i = 1; i <= questionCount; i++) {
            ins.run(id, i, sid, `سؤال ${i}`);
          }
          db.prepare('UPDATE exams SET total_quarters = ?, updated_at = ? WHERE id = ?').run(questionCount * 8, now, id);
        }
      }
      recordAudit(db, { actor: 'admin', action: 'questions_file.uploaded', entityType: 'exam', entityId: id, details: { sha256: meta.sha256, size: meta.sizeBytes, questionCount } });
    })();
    if (old) storage.removePrivate(config.dataDir, old.storage_name);
    res.status(201).json({ ok: true, sizeBytes: meta.sizeBytes, questionCount });
  }));

  // دانلود فایل سؤالات (ادمین)
  app.get('/api/admin/exams/:id/questions-file', adminOnly, safeRoute((req, res) => {
    const id = idParam(req.params.id);
    const f = db.prepare('SELECT * FROM exam_question_files WHERE exam_id = ?').get(id);
    if (!f) throw notFound('فایل سؤالات یافت نشد');
    sendPrivate(res, config, f, { inline: true });
  }));

  /* ================= فایل صوتیِ لیسنینگ (فقط آزمونِ زبان انگلیسی) ================= */

  /** آیا این آزمون درسِ «زبان انگلیسی» را دارد؟ */
  function hasEnglish(db, examId) {
    const row = db.prepare(
      `SELECT 1 FROM exam_subjects es JOIN subjects s ON s.id = es.subject_id
        WHERE es.exam_id = ? AND (s.code = 'en' OR s.label LIKE '%انگلیسی%') LIMIT 1`,
    ).get(examId);
    return Boolean(row);
  }

  app.post('/api/admin/exams/:id/audio', adminOnly, uploadSingle, safeRoute((req, res) => {
    const id = idParam(req.params.id);
    const exam = exams.getExam(db, id);
    if (!req.file) throw badRequest('invalid_upload', 'فایل صوتی لازم است');
    if (exam.status === 'archived') throw conflict('exam_locked', 'آزمون بایگانی شده است');
    if (!hasEnglish(db, id)) {
      throw conflict('not_english_exam', 'فایل صوتی فقط برای آزمونِ زبان انگلیسی است');
    }
    // لیسنینگ می‌تواند طولانی باشد — سقفِ ۲۰ مگابایت
    const meta = storage.validateUpload({ buffer: req.file.buffer, originalName: req.file.originalname, maxBytes: 20 * 1024 * 1024 });
    if (!String(meta.mimeType).startsWith('audio/')) {
      throw badRequest('invalid_upload', 'فایل باید صوتی باشد (MP3، M4A، OGG یا WAV)');
    }
    const name = storage.writePrivate(config.dataDir, req.file.buffer);
    const old = db.prepare('SELECT storage_name FROM exam_audio_files WHERE exam_id = ?').get(id);
    const now = new Date().toISOString();
    db.transaction(() => {
      db.prepare(`INSERT INTO exam_audio_files (exam_id, original_name, mime_type, size_bytes, sha256, storage_name, uploaded_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?)
                  ON CONFLICT(exam_id) DO UPDATE SET original_name = excluded.original_name, mime_type = excluded.mime_type,
                    size_bytes = excluded.size_bytes, sha256 = excluded.sha256, storage_name = excluded.storage_name, uploaded_at = excluded.uploaded_at`)
        .run(id, meta.originalName, meta.mimeType, meta.sizeBytes, meta.sha256, name, now);
      recordAudit(db, { actor: 'admin', action: 'listening_audio.uploaded', entityType: 'exam', entityId: id, details: { sha256: meta.sha256, size: meta.sizeBytes } });
    })();
    if (old) storage.removePrivate(config.dataDir, old.storage_name);
    res.status(201).json({ ok: true, original_name: meta.originalName, size_bytes: meta.sizeBytes });
  }));

  app.delete('/api/admin/exams/:id/audio', adminOnly, safeRoute((req, res) => {
    const id = idParam(req.params.id);
    const exam = exams.getExam(db, id);
    if (exam.status === 'archived') throw conflict('exam_locked', 'آزمون بایگانی شده است');
    const f = db.prepare('SELECT storage_name FROM exam_audio_files WHERE exam_id = ?').get(id);
    if (!f) throw notFound('فایل صوتی یافت نشد');
    db.prepare('DELETE FROM exam_audio_files WHERE exam_id = ?').run(id);
    storage.removePrivate(config.dataDir, f.storage_name);
    recordAudit(db, { actor: 'admin', action: 'listening_audio.deleted', entityType: 'exam', entityId: id });
    res.json({ ok: true });
  }));

  // ذخیره‌ی پیوندِ صوتیِ خارجی (به‌جای بارگذاریِ فایل روی سرور)
  app.put('/api/admin/exams/:id/audio-url', adminOnly, safeRoute((req, res) => {
    const id = idParam(req.params.id);
    if (!db.prepare('SELECT 1 FROM exams WHERE id = ?').get(id)) throw notFound('آزمون یافت نشد');
    if (db.prepare("SELECT 1 FROM exams WHERE id = ? AND status = 'archived'").get(id)) {
      throw conflict('archived', 'آزمون بایگانی‌شده قابل تغییر نیست');
    }
    if (!hasEnglish(db, id)) throw conflict('not_english_exam', 'فایل صوتی فقط برای آزمونِ زبان انگلیسی است');
    const info = classifyAudioUrl(req.body && req.body.url);
    if (!info) throw badRequest('نشانی اینترنتی معتبر نیست (باید با http یا https آغاز شود)');

    const old = db.prepare('SELECT storage_name FROM exam_audio_files WHERE exam_id = ?').get(id);
    db.prepare(`INSERT INTO exam_audio_files (exam_id, audio_url, uploaded_at)
                VALUES (?, ?, ?)
                ON CONFLICT(exam_id) DO UPDATE SET
                  audio_url = excluded.audio_url,
                  original_name = NULL, mime_type = NULL, size_bytes = NULL,
                  sha256 = NULL, storage_name = NULL, uploaded_at = excluded.uploaded_at`)
      .run(id, info.url, new Date().toISOString());
    if (old && old.storage_name) { try { storage.removePrivate(config.dataDir, old.storage_name); } catch (_) {} }
    recordAudit(db, { actor: 'admin', action: 'listening_audio.linked', entityType: 'exam', entityId: id, details: { url: info.url, host: info.host } });
    res.json({ ok: true, audioUrl: info.url, kind: info.kind, host: info.host });
  }));

  app.get('/api/admin/exams/:id/audio', adminOnly, safeRoute((req, res) => {
    const id = idParam(req.params.id);
    const f = db.prepare('SELECT * FROM exam_audio_files WHERE exam_id = ?').get(id);
    if (!f) throw notFound('فایل صوتی یافت نشد');
    if (f.audio_url && !f.storage_name) return res.json({ url: f.audio_url, kind: 'link' });
    sendPrivate(res, config, f, { inline: true });
  }));

  // پخشِ فایلِ لیسنینگ برای دانش‌آموز — فقط وقتی آزمون شروع شده باشد
  app.get('/api/student/exams/:id/audio', studentOnly, safeRoute((req, res) => {
    const id = idParam(req.params.id);
    const exam = exams.getExam(db, id);
    if (!exams.isEligible(db, id, req.auth.id)) throw forbidden('این آزمون برای شما در دسترس نیست');
    if (new Date() < new Date(exam.starts_at)) throw conflict('not_started', 'آزمون هنوز شروع نشده است');
    const f = db.prepare('SELECT * FROM exam_audio_files WHERE exam_id = ?').get(id);
    if (!f) throw notFound('فایل صوتی برای این آزمون وجود ندارد');
    if (f.audio_url && !f.storage_name) {
      const info = classifyAudioUrl(f.audio_url) || { kind: 'page', url: f.audio_url };
      return res.json({ url: info.url, kind: info.kind, source: 'link' });
    }
    sendPrivate(res, config, f, { inline: true });
  }));

  app.post('/api/admin/exams/:id/distribute', adminOnly, safeRoute((req, res) => {
    const id = idParam(req.params.id);
    res.json(grading.distributeExam(db, id, { kind: 'initial', actor: 'admin' }));
  }));

  app.post('/api/admin/exams/:id/absent', adminOnly, safeRoute((req, res) => {
    const id = idParam(req.params.id);
    const studentId = idParam(req.body && req.body.studentId, 'شناسه دانش‌آموز');
    res.json(grading.markAbsent(db, id, studentId, { actor: 'admin' }));
  }));

  // ---------------------------------------------------------------- admin: graders
  app.get('/api/admin/graders', adminOnly, (_req, res) => {
    const rows = db.prepare(
      `SELECT g.id, g.display_name, g.icon, g.active, g.username, g.last_active_at,
              SUM(CASE WHEN a.state = 'active' THEN 1 ELSE 0 END) AS open_count,
              SUM(CASE WHEN a.state = 'completed' THEN 1 ELSE 0 END) AS completed_count,
              SUM(CASE WHEN a.state = 'reassigned' THEN 1 ELSE 0 END) AS reassigned_count
         FROM grader_profiles g LEFT JOIN grading_assignments a ON a.grader_id = g.id
        GROUP BY g.id ORDER BY g.id`
    ).all();
    res.json({ graders: rows });
  });

  app.post('/api/admin/graders', adminOnly, safeRoute((req, res) => {
    const g = createGraderAccount(db, req.body || {}, { rounds: config.bcryptRounds, actor: 'admin' });
    res.status(201).json({ grader: g });
  }));

  app.post('/api/admin/graders/:id/active', adminOnly, safeRoute((req, res) => {
    const id = idParam(req.params.id);
    const active = req.body && req.body.active;
    if (typeof active !== 'boolean') throw badRequest('invalid_input', 'مقدار فعال بودن باید درست یا نادرست باشد');
    if (active) {
      setGraderActive(db, id, true, { actor: 'admin' });
      return res.json({ ok: true });
    }
    // Deactivation revokes sessions and moves open work to other active graders.
    const moved = grading.deactivateGrader(db, id, { actor: 'admin', reason: 'deactivated' });
    revokeGraderSessions(db, id);
    res.json({ ok: true, reassigned: moved.count ?? moved });
  }));

  app.post('/api/admin/graders/:id/password-reset', adminOnly, safeRoute((req, res) => {
    const id = idParam(req.params.id);
    res.json(issuePasswordReset(db, 'grader', id, { actor: 'admin' }));
  }));

  app.post('/api/admin/submissions/:id/reassign', adminOnly, safeRoute((req, res) => {
    const id = idParam(req.params.id);
    const toGrader = idParam(req.body && req.body.graderId, 'شناسه تصحیح‌کننده');
    const reason = String((req.body && req.body.reason) || 'manual').slice(0, 200);
    res.json(grading.reassignSubmission(db, id, toGrader, { actor: 'admin', reason }));
  }));

  app.post('/api/admin/submissions/:id/corrections', adminOnly, safeRoute((req, res) => {
    const id = idParam(req.params.id);
    const b = req.body || {};
    const questionId = idParam(b.questionId, 'شناسه سؤال');
    if (typeof b.reason !== 'string' || b.reason.trim().length < 3) throw badRequest('reason_required', 'دلیل اصلاح نمره لازم است');
    res.json(grading.correctScore(db, id, questionId, b.mark, { reason: b.reason.trim().slice(0, 500), actor: 'admin' }));
  }));

  app.patch('/api/admin/students/:id', adminOnly, safeRoute((req, res) => {
    const id = idParam(req.params.id);
    res.json(updateStudent(db, id, req.body || {}, { actor: 'admin' }));
  }));

  app.post('/api/admin/students/:id/password-reset', adminOnly, safeRoute((req, res) => {
    const id = idParam(req.params.id);
    res.json(issuePasswordReset(db, 'student', id, { actor: 'admin' }));
  }));

  // Admin download of any finalized answer sheet (audited).
  app.get('/api/admin/submission-files/:fileId', adminOnly, safeRoute((req, res) => {
    const fileId = idParam(req.params.fileId);
    const f = db.prepare('SELECT * FROM submission_files WHERE id = ?').get(fileId);
    if (!f) throw notFound('فایل یافت نشد');
    recordAudit(db, { actor: 'admin', action: 'submission_file.downloaded', entityType: 'submission_file', entityId: fileId });
    sendPrivate(res, config, f);
  }));

  // ---------------------------------------------------------------- grader
  app.get('/api/grader/assignments', graderOnly, (req, res) => {
    const rows = db.prepare(
      `SELECT a.id, a.state, a.assigned_at, a.completed_at, e.id AS exam_id, e.title AS exam_title,
              st.full_name AS student_name, st.username AS student_username,
              g.label AS grade_label, g.code AS grade_code,
              (SELECT COUNT(*) FROM submission_files sf WHERE sf.submission_id = a.submission_id) AS file_count,
              EXISTS(SELECT 1 FROM appeals ap WHERE ap.submission_id = a.submission_id AND ap.status = 'open') AS has_appeal
         FROM grading_assignments a
         JOIN submissions s ON s.id = a.submission_id JOIN exams e ON e.id = s.exam_id
         JOIN students st ON st.id = s.student_id
         LEFT JOIN grades g ON g.id = st.grade_id
        WHERE a.grader_id = ? AND a.state IN ('active','completed')
        ORDER BY a.assigned_at`
    ).all(req.auth.id);
    const total = rows.length;
    const completed = rows.filter((r) => r.state === 'completed').length;
    const remaining = rows.filter((r) => r.state === 'active').length;
    res.json({
      assignments: rows.map((r) => ({ ...r, has_appeal: Boolean(r.has_appeal) })),
      stats: { total, completed, remaining },
    });
  });

  app.get('/api/grader/assignments/:id', graderOnly, safeRoute((req, res) => {
    const id = idParam(req.params.id);
    const a = ownActiveAssignment(db, id, req.auth.id);
    const sub = db.prepare('SELECT exam_id, student_id FROM submissions WHERE id = ?').get(a.submission_id);
    // Graders see question text and grading instructions only; the explanatory answer is withheld.
    const questions = db.prepare(
      `SELECT q.id, q.position, s.label AS subject, q.body, q.max_quarters, q.grading_instructions
         FROM questions q JOIN subjects s ON s.id = q.subject_id WHERE q.exam_id = ? ORDER BY q.position`
    ).all(sub.exam_id).map((q) => ({ ...q, max_mark: formatQuarters(q.max_quarters) }));
    const scores = db.prepare('SELECT question_id, quarters, comment FROM question_scores WHERE assignment_id = ?').all(id)
      .map((s) => ({ questionId: s.question_id, mark: formatQuarters(s.quarters), comment: s.comment }));
    const files = db.prepare('SELECT id, original_name, mime_type, size_bytes FROM submission_files WHERE submission_id = ?').all(a.submission_id);
    const hasKey = Boolean(db.prepare('SELECT 1 FROM answer_keys WHERE exam_id = ?').get(sub.exam_id));
    const appeal = db.prepare("SELECT id, status FROM appeals WHERE submission_id = ? AND status = 'open' LIMIT 1").get(a.submission_id);
    const student = db.prepare(
      `SELECT st.full_name, st.username, g.label AS grade_label, g.code AS grade_code,
              (SELECT title FROM exams WHERE id = ?) AS exam_title
         FROM students st LEFT JOIN grades g ON g.id = st.grade_id
        WHERE st.id = ?`,
    ).get(sub.exam_id, sub.student_id);
    res.json({
      assignment: {
        id: a.id, state: a.state, submissionId: a.submission_id, examId: sub.exam_id,
        overallComment: a.overall_comment, assignedAt: a.assigned_at, completedAt: a.completed_at,
        hasAppeal: Boolean(appeal),
        studentName: student ? student.full_name : null,
        studentUsername: student ? student.username : null,
        gradeLabel: student ? student.grade_label : null,
        examTitle: student ? student.exam_title : null,
      },
      answerKey: { available: hasKey, path: `/api/grader/exams/${sub.exam_id}/answer-key` },
      questions, scores, files,
    });
  }));

  app.get('/api/grader/assignments/:id/files/:fileId', graderOnly, safeRoute((req, res) => {
    const id = idParam(req.params.id);
    const fileId = idParam(req.params.fileId);
    const a = ownActiveAssignment(db, id, req.auth.id);
    const f = db.prepare('SELECT * FROM submission_files WHERE id = ? AND submission_id = ?').get(fileId, a.submission_id);
    if (!f) throw notFound('فایل یافت نشد');
    sendPrivate(res, config, f, { inline: req.query.inline === '1' });
  }));

  // Official answer key for an exam the grader is assigned to. Available from the
  // moment the grader holds a sheet of that exam, not only after publication.
  // Only the grader's own assignments count; reassigned-away work does not grant access.
  app.get('/api/grader/exams/:examId/answer-key', graderOnly, safeRoute((req, res) => {
    const examId = idParam(req.params.examId, 'آزمون');
    const holds = db.prepare(
      `SELECT 1 FROM grading_assignments a JOIN submissions s ON s.id = a.submission_id
        WHERE s.exam_id = ? AND a.grader_id = ? AND a.state IN ('active','completed') LIMIT 1`
    ).get(examId, req.auth.id);
    if (!holds) throw forbidden('این پاسخنامه برای برگه‌های شما در دسترس است');
    const key = db.prepare('SELECT * FROM answer_keys WHERE exam_id = ?').get(examId);
    if (!key) throw notFound('پاسخنامه رسمی هنوز بارگذاری نشده است');
    recordAudit(db, { actor: `grader:${req.auth.id}`, action: 'answer_key.viewed', entityType: 'exam', entityId: examId });
    sendPrivate(res, config, key, { inline: req.query.inline === '1' });
  }));

  // Autosave: safe to call repeatedly; each call replaces the draft scores.
  app.put('/api/grader/assignments/:id/scores', graderOnly, safeRoute((req, res) => {
    const id = idParam(req.params.id);
    res.json(grading.saveScores(db, id, req.auth.id, req.body || {}, { now: new Date() }));
  }));

  app.post('/api/grader/assignments/:id/finalize', graderOnly, safeRoute((req, res) => {
    const id = idParam(req.params.id);
    res.json(grading.finalizeAssignment(db, id, req.auth.id, { now: new Date() }));
    // Results may publish now if this was the last open sheet and the time has come.
    tick(db, new Date());
  }));

  // ---------------------------------------------------------------- student
  app.get('/api/student/exams', studentOnly, (req, res) => {
    const rows = db.prepare(
      `SELECT e.id, e.title, e.status, e.starts_at, e.duration_minutes, e.submission_deadline,
              e.results_publish_at, e.results_published_at,
              e.answer_key_published_at, s.status AS my_status, s.submitted_at
         FROM exams e
         JOIN exam_grades eg ON eg.exam_id = e.id
         JOIN students st ON st.id = ? AND st.grade_id = eg.grade_id
         LEFT JOIN submissions s ON s.exam_id = e.id AND s.student_id = st.id
        WHERE e.status != 'draft'
        ORDER BY e.starts_at DESC`
    ).all(req.auth.id);
    const now = new Date();
    res.json({
      exams: rows.filter((r) => exams.isEligible(db, r.id, req.auth.id))
        .map((r) => ({
          ...r,
          // قفل (before) / در حال برگزاری (open) / پایان‌یافته (after)
          windowState: home.windowState(r, now),
          countdownTarget: home.countdownTarget(r, now).target,
          // پایانِ «مدتِ آزمون» (نه مهلتِ ارسال) — شمارش معکوسِ صفحه‌ی آزمون
          // پایانِ آزمون برای «این» دانش‌آموز — اگر هنوز وارد نشده، null است
          endsAt: exams.attemptEndsAt(db, r.id, req.auth.id),
          startedAt: exams.attemptStartedAt(db, r.id, req.auth.id),
          hasAudio: Boolean(db.prepare('SELECT 1 FROM exam_audio_files WHERE exam_id = ?').get(r.id)),
          audioUrl: (db.prepare('SELECT audio_url FROM exam_audio_files WHERE exam_id = ?').get(r.id) || {}).audio_url || null,
        })),
    });
  });

  function assertOpenForUpload(examId, studentId, now) {
    const exam = exams.getExam(db, examId);
    if (!['published', 'in_progress'].includes(exam.status)) throw conflict('exam_not_open', 'آزمون باز نیست');
    if (now < new Date(exam.starts_at)) throw conflict('not_started', 'آزمون هنوز شروع نشده است');
    if (now >= new Date(exam.submission_deadline)) throw conflict('deadline_passed', 'مهلت ارسال پاسخ به پایان رسیده است');
    if (!exams.isEligible(db, examId, studentId)) throw notFound('آزمون یافت نشد');
    // مدتِ این دانش‌آموز از لحظه‌ی ورودِ خودش حساب می‌شود — نه زمانِ شروعِ کلیِ آزمون
    if (exams.attemptExpired(db, examId, studentId, { now })) {
      throw conflict('time_over', 'مدت زمان مجاز آزمون به اتمام رسیده است');
    }
    const sub = db.prepare('SELECT id FROM submissions WHERE exam_id = ? AND student_id = ?').get(examId, studentId);
    if (sub) throw conflict('already_submitted', 'برای این آزمون قبلاً پاسخ ثبت شده است');
    return exam;
  }

  // ثبتِ لحظه‌ی ورودِ دانش‌آموز: از این لحظه مدتِ آزمون برای «او» شروع می‌شود.
  // فراخوانیِ دوباره ساعت را reset نمی‌کند.
  app.post('/api/student/exams/:id/start', studentOnly, safeRoute((req, res) => {
    const examId = idParam(req.params.id);
    const now = new Date();
    const exam = exams.getExam(db, examId);
    if (!['published', 'in_progress'].includes(exam.status)) throw conflict('exam_not_open', 'آزمون باز نیست');
    if (now < new Date(exam.starts_at)) throw conflict('not_started', 'آزمون هنوز شروع نشده است');
    if (now >= new Date(exam.submission_deadline)) throw conflict('deadline_passed', 'مهلت ارسال پاسخ به پایان رسیده است');
    if (!exams.isEligible(db, examId, req.auth.id)) throw notFound('آزمون یافت نشد');
    const att = exams.startAttempt(db, examId, req.auth.id, { now });
    res.json({ startedAt: att.startedAt, endsAt: att.endsAt, alreadyStarted: att.alreadyStarted });
  }));

  app.get('/api/student/exams/:id/uploads', studentOnly, safeRoute((req, res) => {
    const examId = idParam(req.params.id);
    if (!exams.isEligible(db, examId, req.auth.id)) throw notFound('آزمون یافت نشد');
    res.json({
      uploads: db.prepare('SELECT id, original_name, mime_type, size_bytes, created_at FROM pending_uploads WHERE exam_id = ? AND student_id = ? ORDER BY id')
        .all(examId, req.auth.id),
    });
  }));

  app.post('/api/student/exams/:id/uploads', studentOnly, uploadSingle, safeRoute((req, res) => {
    const examId = idParam(req.params.id);
    const now = new Date();
    const exam = assertOpenForUpload(examId, req.auth.id, now);
    if (!req.file) throw badRequest('invalid_upload', 'فایل لازم است');
    const count = db.prepare('SELECT COUNT(*) n FROM pending_uploads WHERE exam_id = ? AND student_id = ?').get(examId, req.auth.id).n;
    if (count >= MAX_PENDING_PER_EXAM) throw conflict('too_many_files', 'تعداد فایل‌های این آزمون به حد مجاز رسیده است');
    const meta = storage.validateUpload({ buffer: req.file.buffer, originalName: req.file.originalname });
    const name = storage.writePrivate(config.dataDir, req.file.buffer, now);
    const row = db.prepare(
      `INSERT INTO pending_uploads (exam_id, student_id, storage_name, original_name, mime_type, size_bytes, sha256, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(examId, req.auth.id, name, meta.originalName, meta.mimeType, meta.sizeBytes, meta.sha256, now.toISOString(), exam.submission_deadline);
    res.status(201).json({ upload: { id: Number(row.lastInsertRowid), original_name: meta.originalName, mime_type: meta.mimeType, size_bytes: meta.sizeBytes } });
  }));

  app.delete('/api/student/exams/:id/uploads/:uploadId', studentOnly, safeRoute((req, res) => {
    const examId = idParam(req.params.id);
    const uid = idParam(req.params.uploadId);
    const now = new Date();
    assertOpenForUpload(examId, req.auth.id, now);
    const u = db.prepare('SELECT storage_name FROM pending_uploads WHERE id = ? AND exam_id = ? AND student_id = ?').get(uid, examId, req.auth.id);
    if (!u) throw notFound('فایل یافت نشد');
    db.prepare('DELETE FROM pending_uploads WHERE id = ?').run(uid);
    storage.removePrivate(config.dataDir, u.storage_name);
    res.json({ ok: true });
  }));

  // Finalize: creates the submission and moves pending files into it, atomically.
  app.post('/api/student/exams/:id/submit', studentOnly, safeRoute((req, res) => {
    const examId = idParam(req.params.id);
    const now = new Date();
    const out = db.transaction(() => {
      assertOpenForUpload(examId, req.auth.id, now);
      const pending = db.prepare('SELECT * FROM pending_uploads WHERE exam_id = ? AND student_id = ?').all(examId, req.auth.id);
      if (pending.length === 0) throw badRequest('no_files', 'ابتدا حداقل یک فایل پاسخنامه بارگذاری کنید');
      const sub = exams.recordSubmission(db, examId, req.auth.id, { now });
      const ins = db.prepare(
        `INSERT INTO submission_files (submission_id, storage_name, original_name, mime_type, size_bytes, sha256, uploaded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      );
      for (const p of pending) ins.run(sub.id, p.storage_name, p.original_name, p.mime_type, p.size_bytes, p.sha256, p.created_at);
      db.prepare('DELETE FROM pending_uploads WHERE exam_id = ? AND student_id = ?').run(examId, req.auth.id);
      recordAudit(db, { actor: `student:${req.auth.id}`, action: 'submission.finalized', entityType: 'submission', entityId: sub.id, details: { files: pending.length } }, now);
      return sub;
    })();
    res.status(201).json({ submission: out });
  }));

  // Answer key: only after the scheduler has published it. Denied before that.
  // فایل سؤالات کامل آزمون برای دانش‌آموز (در زمان برگزاری)
  app.get('/api/student/exams/:id/questions-file', studentOnly, safeRoute((req, res) => {
    const examId = idParam(req.params.id);
    const exam = exams.getExam(db, examId);
    if (!exams.isEligible(db, examId, req.auth.id)) throw forbidden('این آزمون برای شما در دسترس نیست');
    const now = new Date();
    if (now < new Date(exam.starts_at)) throw conflict('not_started', 'آزمون هنوز شروع نشده است');
    const f = db.prepare('SELECT * FROM exam_question_files WHERE exam_id = ?').get(examId);
    if (!f) throw notFound('فایل سؤالات یافت نشد');
    sendPrivate(res, config, f, { inline: true });
  }));

  app.get('/api/student/exams/:id/answer-key', studentOnly, safeRoute((req, res) => {
    const examId = idParam(req.params.id);
    if (!exams.isEligible(db, examId, req.auth.id)) throw notFound('آزمون یافت نشد');
    const exam = exams.getExam(db, examId);
    const key = db.prepare('SELECT * FROM answer_keys WHERE exam_id = ?').get(examId);
    if (!key || !exam.answer_key_published_at || new Date(exam.answer_key_publish_at) > new Date()) {
      throw forbidden('پاسخنامه رسمی هنوز منتشر نشده است');
    }
    sendPrivate(res, config, key);
  }));

  // Post-publication student file access is limited to the answer key for now.
  // Students never receive their own marks through these routes.
  void log;
}

// inline=true lets the page display the file (for zoom/viewer). The file is still
// served with its verified MIME type, nosniff, no-store, and a sandboxed CSP.
function sendPrivate(res, config, f, { inline = false } = {}) {
  const buf = storage.readPrivate(config.dataDir, f.storage_name);
  const safeName = storage.sanitizeName(f.original_name).replace(/"/g, '');
  const disposition = inline ? 'inline' : 'attachment';
  res.set({
    'Content-Type': f.mime_type,
    'Content-Length': String(buf.length),
    'Content-Disposition': `${disposition}; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(safeName)}`,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, no-store',
    'Content-Security-Policy': "default-src 'none'; sandbox",
  });
  res.end(buf);
}

module.exports = { mountExamRoutes, uploadSingle, MAX_PENDING_PER_EXAM };
