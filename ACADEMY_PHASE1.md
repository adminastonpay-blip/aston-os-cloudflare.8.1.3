# ASTON Edge AI Academy — Phase 1 (v8.11.0)

## What shipped

- `academy.js` — catalog, enroll, progress
- Plugin `academy` (requires `ASTON_DB`)
- Routes aligned with Shopify section settings

## Endpoints

| Method | Path | Auth |
|--------|------|------|
| GET | `/academy/courses` | Public |
| GET | `/academy/courses/:id` | Public |
| POST | `/academy/enroll` | Bearer + write |
| GET | `/academy/me/progress` | Bearer + read |
| POST | `/academy/me/progress` | Bearer + write (mark module done) |
| GET | `/academy/me/enrollments` | Bearer + read |

## Shopify section settings

- Worker base URL: `https://YOUR-WORKER.workers.dev/`
- Health path: `/`
- Courses path: `/academy/courses`
- Progress path: `/academy/me/progress`
- Enrollment path: `/academy/enroll`

## After deploy

```bash
curl -s https://YOUR-WORKER/academy/courses
curl -s -X POST https://YOUR-WORKER/academy/enroll \
  -H "Authorization: Bearer TOKEN" -H "Content-Type: application/json" \
  -d '{"course_id":"edge-engineering"}'
```

## Next phases (not in 8.11)

- Assessments with server-side grading
- Verifiable credentials
- Tutor agent RAG on course material
