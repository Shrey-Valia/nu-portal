# NUworks map (Phase 2 recon)

How NUworks (Symplicity CSM at `northeastern-csm.symplicity.com`) works, confirmed read-only against the live site on 2026-10-07. Structure only: no student data. Code: `src/nuworks/live-adapter.ts`, `src/nuworks/map.ts`, `src/nuworks/api-schemas.ts`.

## Session
- Entry `https://nuworks.northeastern.edu/students` redirects to `https://northeastern-csm.symplicity.com/students/`.
- Signed out: lands on `/students/?signin_tab=0`.
- Signed in: a `button` with `aria-label` starting "User Menu" is present (`SESSION.loggedInMarker`).
- Login cookies (`PHPSESSID` and an app cookie) have no expiry. Chrome drops them when it closes, so `npm run login` saves them the moment the dashboard loads (`.auth/nuworks-session.json`), and every run restores them.
- **Gates:** NUworks can block the job search behind required surveys ("Before you begin… Incomplete Your Surveys"). The student completes these themselves; NU Portal never submits them.

## JSON API
The Angular student app (`/students/app/...`) loads data from `/api/v2/...` and `/api/v3/...`.

**The API returns empty results unless each request carries two headers the web app adds:**
- `Authorization: Basic …`, issued to the web app. It isn't in cookies or storage. NU Portal loads `/students/app/jobs/discover` once per run, picks the header up from the app's own first API call, and keeps it in memory only.
- `X-Requested-System-User: students`

**Query strings use literal `,` and `!`** (for example `job_type=5,17` and `sort=!postdate`). Percent-encoded commas also return nothing.

| Endpoint | What it is |
| --- | --- |
| `GET /api/v2/jobs?ocr=f&job_type=…&targeted_academic_majors=…&el_work_term=…&exclude_applied_jobs=1&perPage=20&page=N&sort=!postdate&json_mode=read_only&enable_translation=false` | Job search. `{ perPage, page, total, models[] }`. Each model has `job_id`, `job_title`, `name` (employer), `job_location`, `deadline` ("Oct 16, 2026"), `postdate`, `job_type[]`, `job_desc`, `compensation_*`, `qualified`. |
| `GET /api/v3/jobs/<job_id>` | Full posting (see below). |
| `GET /api/v2/jobs/discovery/qualified-status?jobs=id,id,…` | Per-job "qualified" flags, used for the "Not Qualified" labels. |
| `GET /api/v2/jobs/filters/students` | Filter definitions: `keywords`, `ocr` (Show Me), `exclude_applied_jobs`, `industry`, `targeted_academic_majors`, `el_work_term` (Work Term), `job_length_ms`, `workplace_type`, `optcpt`, `job_function2`, `start_date_nu`, `desired_end_date`, `job_type` (Position Type), `postdate`, `hours_per_week2`, … Options load separately. |
| `GET /api/v3/jobs/form-structure?form=student_job_display&object_id=<id>` | Layout of the posting page. |
| `GET /api/v2/auth/current-user`, `/api/v2/student/profile` | The signed-in student. NU Portal doesn't use these. |

Known filter values: `job_type=5` is Co-op (`17` is a second co-op position type the student selected). `ocr=f` is "all job listings". `el_work_term=<term_id>`: "2027 - Spring" has its own id. Summer term ids are still to be captured.

### Posting detail fields NU Portal uses (`/api/v3/jobs/<id>`)

| Field | Meaning |
| --- | --- |
| `job_title`, `employer_name` / `job_emp.name`, `job_location`, `job_desc` (HTML) | Basics |
| `el_work_term.title` | Co-op term, e.g. "2027 - Spring" (matched by `sameTerm`) |
| `job_dates.end` | Application deadline (local time with offset) |
| `start_date_nu`, `desired_end_date` | Co-op start and end dates |
| `workplace_type[]._label` | "Hybrid", "Primarily on-site work", … mapped to a modality |
| `compensation_from`, `compensation_to`, `compensation_frequency` | Pay |
| `targeted_academic_majors[]._label` | "College/Major" |
| `screen_flag`, `screen_gpa` | GPA screen |
| `is_qualified` | **NUworks' own eligibility check for this student**; filter rule `not_qualified` |
| `applied`, `expired` | Already applied / closed |
| `documents_required[]`, `additional_documents[]` | Required vs. accepted documents (cover letter required / optional / not accepted) |
| `resume_mode` | "online" means apply in NUworks; "other" means outside instructions |
| `student_link` | External apply link, when given |
| `job_length_ms[]`, `hours_per_week2` | Length (e.g. "6 Month"), hours |

Work authorization and visa fields were empty on every posting seen; `is_qualified` covers eligibility.

## My Job Applications
`/students/app/jobs/applied?subtab=nocr` renders a server-side (PHP) page, not JSON.
- The header reads "N results found". NUworks shows no 100-cap counter, so this count is the cap usage.
- Each application is a list item with:
  - an `h2 > a[href*="/jobs/detail/<job_id>"]` (the title);
  - a `p > a[href*="/employers/"]` (the employer);
  - the text "Application submitted <date>";
  - View Resume / View Cover Letter links;
  - a **Withdraw** link. NU Portal never touches it.
- There's an "Exp. Learning Offer Status" filter: Pending, Offer Accepted, Offer Declined, Offer Expired.

## Offers (new for Spring 2027 co-ops)
Offers must be **recorded and accepted in NUworks Student Utilities → My Co-op Job Search** (with the offer letter and an alignment statement) before the Experiential Learning record. The offer kill switch checklist includes this.

## Not mapped yet (Phase 5, needed for applying in NUworks)
- The Apply dialog (document selection, screening questions, confirmation).
- The Documents page: resume approval status, whether cover letter uploads need approval, document limits.
- The Summer 2027 Work Term ids (only needed to filter by term on the server; NU Portal also checks each posting's term itself).

## Apply dialog (mapped 2026-10-07)
Clicking the posting's `button "apply"` opens a modal `dialog` titled "Apply to <employer>":
- **"Submit Your Application"** section: a native `<select>` labelled "Resume *" holding the student's documents. The approved default resume is preselected. There's an "add a new resume" button, then **Cancel** and **Submit** buttons. No file inputs appear unless a new document is added.
- **Two variants:**
  1. Resume only (most postings).
  2. With a **"How to Apply"** panel on the left, e.g. "Apply online at https://…". The employer wants an outside application too; the same URL appears in the posting's `contact_blurb` and `resume_mode` contains `other`.
- **Requests while opening:**
  - `GET /api/v3/jobresumes/form-structure?position=<job_id>&view=apply&form_view=apply` returns the form groups: Resume (picklist), and Cover Letter, Writing / Work Sample or Portfolio, Transcript, Student Employment Application (hidden unless the posting requires them). Hidden keys are `resume_id`, `position`, `student`.
  - `GET /api/v2/student/documents?all=1&json_mode=raw` returns the documents with `document_type`, `approved` (1/0), `default_resume`, and `status`.
  - `POST /api/v3/student-activity` is activity logging, not an application.
- **Confirming an application:** after Submit, re-fetch `/api/v3/jobs/<id>`. `applied: true` is authoritative.
