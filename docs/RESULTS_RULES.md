# Results, rankings and report-card rules

These rules are implemented in `src/services/results.js` and tested in
`tests/results-http.test.js`.

## Who is ranked

- Only **finalized official** submissions with status `submitted` are ranked:
  the submission has a completed grading assignment whose questions are all scored.
- `absent` (administratively classified) and `missing` (no upload before the
  deadline) students are **excluded** from rankings. The exam ranking reports
  their counts in `excluded`.
- Practice attempts are never read by any ranking, report card or score history.

## Ties

Competition ranking ("1224"): equal totals share a rank and the next rank is
skipped. For example, 2, 2, 1.5 gives ranks 1, 1, 3.

## Exam ranking

- Ordered by the finalized total in quarter-points (1 mark = 4 quarters).
- Visible to students only after `results_published_at` is set.
- Admin may view it at any time.

## Grade ranking (overall within a grade)

- For each student: the average total over every **published** exam of the
  academic year in which the student has a finalized submission.
- Averages are compared exactly by cross-multiplying integers (no floating point).
- Shown as `averageMark` with two decimals. Exams the student did not sit are not counted.
- A student may view only their own grade.

## Subject ranking

- Same as the grade ranking, using only the questions tagged with the chosen subject.
- A student's subject total is the sum of quarters of that subject's questions
  in each finalized submission.

## Report card

- Contains: exam title, student name, grade, field, one total per subject,
  overall total, and the exam rank.
- Does **not** contain per-question marks, percentages, or any status field.
- Students can open it only after results are published. Absent or missing
  students get no report card.

## Score history

- Chronological list of official totals per published exam.
- Practice data is excluded.

## Appeals

- Only the owner of a finalized submission may appeal, only after results are
  published, and only within `APPEAL_WINDOW_DAYS` (default 7).
- One open appeal per submission.
- Accepting requires the corrected mark (`questionId` and `newMark`). The
  correction goes through the normal score-correction path, so it is recorded
  in `score_history` and the audit log.
- Rejecting requires a written note.
- Each decision creates an in-app notification for the student.
