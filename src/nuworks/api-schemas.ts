import { z } from "zod";

// Shapes of the NUworks (Symplicity CSM) JSON we rely on, confirmed during
// recon (docs/recon/nuworks-map.md). Unknown fields pass through; if a field
// we need changes type, parsing fails loudly instead of guessing.

const label = z.object({ _id: z.union([z.string(), z.number()]).nullable().optional(), _label: z.string().nullable().optional() }).passthrough();
const labels = z.array(label).nullable().optional();

export const JobListItem = z
  .object({
    job_id: z.string(),
    job_title: z.string(),
    name: z.string().nullable().optional(), // employer
    job_location: z.string().nullable().optional(),
    deadline: z.string().nullable().optional(), // "Oct 16, 2026"
    postdate: z.string().nullable().optional(),
    job_type: z.array(z.string()).nullable().optional(),
  })
  .passthrough();

export const JobList = z
  .object({
    perPage: z.number(),
    page: z.number(),
    total: z.number(),
    models: z.array(JobListItem),
  })
  .passthrough();

export const JobDetail = z
  .object({
    job_id: z.string(),
    job_title: z.string(),
    job_desc: z.string().nullable().optional(),
    employer_name: z.string().nullable().optional(),
    job_emp: z.object({ name: z.string().nullable().optional() }).passthrough().nullable().optional(),
    job_location: z.string().nullable().optional(),
    job_type: labels,
    compensation_from: z.union([z.string(), z.number()]).nullable().optional(),
    compensation_to: z.union([z.string(), z.number()]).nullable().optional(),
    compensation_frequency: label.nullable().optional(),
    el_work_term: z.object({ term_id: z.string().nullable().optional(), title: z.string().nullable().optional() }).passthrough().nullable().optional(),
    workplace_type: labels,
    targeted_academic_majors: labels,
    screen_flag: z.union([z.number(), z.string()]).nullable().optional(),
    screen_gpa: z.union([z.number(), z.string()]).nullable().optional(),
    documents_required: labels,
    additional_documents: labels,
    resume_mode: z.string().nullable().optional(), // "online", "online,other", "other"
    student_link: z.string().nullable().optional(),
    job_dates: z.object({ start: z.string().nullable().optional(), end: z.string().nullable().optional() }).nullable().optional(),
    start_date_nu: z.string().nullable().optional(),
    desired_end_date: z.string().nullable().optional(),
    created: z.string().nullable().optional(),
    is_qualified: z.boolean().nullable().optional(),
    applied: z.boolean().nullable().optional(),
    expired: z.boolean().nullable().optional(),
  })
  .passthrough();

export type JobDetail = z.infer<typeof JobDetail>;
