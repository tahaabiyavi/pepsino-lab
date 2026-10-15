# Pepsino Lab exam system: backend status

Scope: the backend only, as requested. No browser UI is included.
Every item below is backed by a test or a rehearsal in this repository.

**Important:** the original project repository (`pepsinolab-exam-server-v5`)
was not available. This is a standalone backend. It is not yet connected to the
live site pepsinogen.net, whose API is different. See "Open points" below.

## Implemented and verified

| Area | Evidence |
| --- | --- |
| Quarter-point marks (0.25 steps, integer storage) | `tests/core.test.js` |
| Exam creation, questions, schedule rules, lifecycle transitions | `tests/core.test.js`, `tests/exam-http.test.js` |
| Balanced random assignment, reassignment, deactivation moves open work | `tests/core.test.js`, `tests/exam-http.test.js` |
| Scoring, finalization guard, score corrections with reason and history | `tests/core.test.js`, `tests/results-http.test.js` |
| Idempotent window closing, answer-key and results publication | `tests/core.test.js`, `tests/results-http.test.js` |
| Single Super Admin; separate bcrypt grader logins | `tests/exam-http.test.js` |
| Grader scope: own work only; reassigned work refused; no admin routes | `tests/exam-http.test.js` |
| Disabled grader: session revoked; login refused | `tests/exam-http.test.js` |
| Upload: 10 MB limit (413); extension and signature allowlist (415); PDF active-content rejection | `tests/exam-http.test.js` |
| Private storage with random names; traversal-safe resolution | `tests/exam-http.test.js`, `src/files/storage.js` |
| Cross-student isolation (uploads, submissions, appeals, practice) | `tests/exam-http.test.js`, `tests/results-http.test.js` |
| Answer key denied to students before publication; released by the scheduler | `tests/exam-http.test.js` |
| Graders see the official answer key from the moment they hold a sheet of that exam (before publication); access ends if the sheet is reassigned; each view audited | `tests/grader-answer-key.test.js` |
| Expired pending uploads removed by the scheduler (rows and files) | `tests/results-http.test.js` |
| Exam ranking with competition ties; absent and missing excluded | `tests/results-http.test.js` |
| Grade and subject rankings with exact averages; own grade only for students | `tests/results-http.test.js` |
| Report card: subject totals and total only; no per-question marks, percentage or status | `tests/results-http.test.js` |
| Score history (official data only) | `tests/results-http.test.js` |
| Appeals: owner-only, time-limited, one open per submission, correction via history, decisions notify student, Telegram alert queued | `tests/results-http.test.js` |
| Practice mode: separate tables, self-assessed scores, explanatory answers hidden until submission, no effect on official data | `tests/results-http.test.js` |
| In-app notifications for publication events; idempotent | `tests/results-http.test.js` |
| Admin-issued one-time password reset; hash-only storage; sessions revoked | `tests/exam-http.test.js` |
| Password help: generic response; admin notified via outbox | `tests/exam-http.test.js` |
| Private file backup with SHA-256 manifest, re-verification, missing-file report, tamper detection | `tests/files-backup.test.js` |
| Migrations 002, 003 and 004 applied to a database with existing rows | rehearsal (see below) |
| Production-mode startup, health check, anonymous and role denials, backup and restore | rehearsal (see below) |

Test result at the time of writing: 101 passing, 0 failing (`npm test`).
Dependency audit: 0 known vulnerabilities (`npm audit --omit=dev`).

### Rehearsal (run on a copy with data)

- Database built at the 001 schema with a student and a session; migrations
  002 to 004 applied with the real migrator. The student and session were kept,
  integrity was `ok`, and there were 0 foreign-key violations.
- Production-mode server started on the migrated copy. `/healthz` returned 200.
  Anonymous calls to student routes returned 401. An invalid admin body returned 400.
- Database backup verified with `scripts/backup.js`. File backup with
  `scripts/backup-files.js` copied one stored answer key, verified it, and reported no missing files.

## Not included (by request, or not built)

- Any browser interface: exam management, student upload page, grader screen,
  report-card print view, ranking pages, score chart, practice page, appeals page.
  The backend exposes the data for all of them.
- Telegram commands for exam events beyond the existing registration flow and appeal alert.
- Browser zoom and page viewer for answer sheets and the answer key. The backend serves the files inline (`?inline=1`); the zoomable page itself is front-end work.
- Practice mode does not grade automatically; students self-assess. This is by design.

## Open points

1. **Live site.** pepsinogen.net uses a different API (`/api/state`, `/api/results`, `/api/questions`, `/api/config`). This backend does not implement that API. Connecting them needs the original server source or a decision to replace the live API.
2. **Security on the live site.** Its `GET /api/state` returns stored data, including a plaintext password value, without authentication. Rotate the password and disable the endpoint. The response was backed up to `/home/user/backups/state-20261010-052320.json`; the value is not copied into this code.
3. **Spec conflict.** The English specification calls grader profiles internal identities. The Persian addendum requires separate logins. The addendum is later and more specific, so each grader has a separate login with no administrator rights.

## Notes on test maintenance

Two outbox tests in `tests/telegram.test.js` used a fixed clock (10:00 UTC on
2026-10-10). They failed once the real clock passed that time. They now use the
current time. The behaviour under test is unchanged.
