# Mock Student Information System (SIS)

An **independent, vendor-style** Student Information System used to integration-test
the 360° Feedback System. It has its **own database** (`mock_sis`) and exposes REST
APIs "as if from another vendor". The 360 app talks to it only through a
`SisProvider` adapter, so a real SIS/ERP can replace it by changing only that adapter.

## Central design

Students are **enrolled into Teaching Assignments** — never mapped to teachers
directly. A `TeachingAssignment` = *Teacher X teaches Subject Y to Class/Section Z
in Session A*. From an enrollment we derive the teacher, subject, class, section,
semester and session — which is what lets a parent evaluate a teacher **for a
specific subject**.

```
Campus → Faculty → Department → Program → Class → Section
Teacher + Subject + Session/Semester + Class/Section  ─▶  TeachingAssignment
Student  ─enrolled into▶  TeachingAssignment          (+ Parents/Guardians)
```

## Run

> **All `sis:*` scripts are defined in the ROOT `package.json` and must be run from
> the monorepo root** (not from `apps/mock-sis`, which only defines `db:generate`).
> Running `npm run sis:generate` inside `apps/mock-sis` gives *"Missing script:
> sis:generate"* — `cd` back to the repo root first. `./deploy.ps1` now performs
> all of these steps automatically.

```bash
# from the monorepo root
npm install
docker compose -f docker-compose.yml exec -T postgres createdb -U postgres mock_sis   # or: createdb mock_sis
cp apps/mock-sis/.env.example apps/mock-sis/.env                 # edit if needed

npm run sis:setup       # generate client + push schema + seed sample data (one command)
# ...or run the individual steps:
#   npm run sis:generate # generate the isolated Prisma client
#   npm run sis:push     # create the schema
#   npm run sis:seed     # load sample data (100 students, 30 teachers, …)

npm run dev:sis         # start on http://localhost:3100/api/v1
```

Auth: every request needs `X-API-Key: <SIS_API_KEY>`. `GET /api/v1/health` is public (note the prefix — the health route is **not** excluded from the global prefix).

## Administration UI (data entry & testing)

A self-contained admin interface is served by this service at:

```
http://localhost:3100/admin
```

It provides simple CRUD screens for **Students, Parents/Guardians (incl. WhatsApp
number), Teachers, Subjects, Teaching Assignments, and Student Enrollments**, with
FK dropdowns, search, and basic validation (unique registration/employee/subject
codes; no duplicate enrollments). It is a local testing tool and is intentionally
**not** behind the vendor API key (the key still protects the `/api/v1` vendor
endpoints the 360 app consumes). Admin CRUD lives under `/admin/api/*`.

**Teacher → Employee mapping** is performed in the **360 app** (Parent Evaluations →
Teacher Mapping), because employee records and authentication live there. Each SIS
teacher maps to one 360 employee by **employee code**; each employee can be mapped
to only one teacher. When a parent submits feedback, the teacher is resolved to the
mapped employee and the feedback is recorded against that employee's 360 cycle. The
admin UI's "Teacher → Employee Mapping" tab explains this and lists teacher codes
for reference.

## API summary

Academic: `/campuses` `/faculties` `/departments` `/programs` `/sessions`
`/semesters` `/classes` `/sections`
Students: `/students` `/students/:id` `/students/:id/parents`
`/students/:id/enrollments` `/students/:id/teachers`
Teachers: `/teachers` `/teachers/:id` `/teachers/:id/assignments`
`/teachers/:id/students`
Subjects: `/subjects` `/subjects/:id/students`
Teaching: `/teaching-assignments` `/teaching-assignments/:id`

Lists return `{ data: [...], count }`; objects return `{ data: {...} }`.

## Consuming it from the 360 app

Configure `apps/api/.env`:

```
SIS_PROVIDER=mock
SIS_BASE_URL=http://localhost:3100/api/v1
SIS_API_KEY=mock-sis-dev-key-change-me
```

The integration layer is in `apps/api/src/sis/`. To swap for a real SIS, implement
`SisProvider` in a new provider, add a branch in `sis.module.ts`, and set
`SIS_PROVIDER` — nothing else in the 360 app changes.

See `Mock_SIS_Integration_Guide.html` for the full guide.
