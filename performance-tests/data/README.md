# Generated test data — do not commit

These CSVs are produced for a throwaway database and contain login credentials.
Regenerate them; never commit them.

| File | Produced by | Columns |
|---|---|---|
| `users_hr.csv` / `users_mgr.csv` / `users_emp.csv` | split from `perf/seed-perf.mjs` output by role | email, role, password, orgSlug |
| `employees.csv` | SQL over `employees` joined to `appraisal_participants` | employeeId |
| `students.csv` | SQL over `sis_datasets.snapshot->'students'` | studentId |
| `parent-tokens.csv` | `perf/mint-links.mjs` (real API) | token, studentId, teacherId |

See the repository README §"Building the test data" for the full sequence.
