import { z } from "zod";

// me/profile.yaml: who you are, what you've done, what you want.
// Ids (skills, experiences, bullets, stories) let cover-letter claims cite their source.

const id = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "ids are lowercase words joined by dashes");
const url = z.string().url();

export const ProfileSchema = z
  .object({
    identity: z.object({
      name: z.string().min(1),
      preferredName: z.string().optional(),
      email: z.string().email(),
      phone: z.string().optional(),
      city: z.string().optional(), // e.g. "Boston, MA"
      pronouns: z.string().optional(),
      links: z
        .object({
          linkedin: url.optional(),
          github: url.optional(),
          website: url.optional(),
          portfolio: url.optional(),
        })
        .prefault({}),
    }),
    education: z.object({
      school: z.string().default("Northeastern University"),
      college: z.string().optional(), // e.g. Khoury College of Computer Sciences
      degree: z.string().default("BS"),
      majors: z.array(z.string()).min(1),
      minors: z.array(z.string()).default([]),
      concentration: z.string().optional(),
      gradDate: z.string(), // e.g. "May 2028"
      level: z.enum(["first-year", "second-year", "middler", "fourth-year", "senior", "graduate"]).optional(),
      gpa: z.number().min(0).max(4).optional(),
      shareGpa: z.boolean().default(true),
      coopCycle: z.string(), // e.g. "Spring 2027"
      coopNumber: z.number().int().min(1).max(3),
      coursework: z.array(z.string()).default([]),
    }),
    workAuth: z.object({
      authorizedUS: z.boolean(),
      needsSponsorship: z.boolean(),
      usCitizen: z.boolean().optional(),
      clearanceEligible: z.boolean().optional(),
    }),
    targets: z.object({
      roles: z.array(z.string()).min(1),
      domains: z.array(z.string()).default([]),
      locations: z.array(z.string()).default([]),
      modalities: z.array(z.enum(["onsite", "hybrid", "remote"])).default(["onsite", "hybrid", "remote"]),
      willingToRelocate: z.boolean().default(true),
      minHourly: z.number().positive().optional(),
      companiesLove: z.array(z.string()).default([]),
      companiesAvoid: z.array(z.string()).default([]),
      keywordsAvoid: z.array(z.string()).default([]),
      dealbreakers: z.array(z.string()).default([]),
    }),
    skills: z
      .array(
        z.object({
          id,
          name: z.string(),
          level: z.enum(["learning", "working", "strong", "expert"]),
          evidence: z.array(id).default([]),
        }),
      )
      .default([]),
    experiences: z
      .array(
        z.object({
          id,
          kind: z.enum(["job", "coop", "internship", "research", "project", "leadership", "volunteer", "course"]),
          title: z.string(),
          org: z.string(),
          location: z.string().optional(),
          start: z.string().optional(),
          end: z.string().optional(),
          url: url.optional(),
          tech: z.array(z.string()).default([]),
          bullets: z.array(z.object({ id, text: z.string() })).default([]),
        }),
      )
      .default([]),
    awards: z.array(z.object({ id, text: z.string() })).default([]),
    extras: z.array(z.object({ id, text: z.string() })).default([]),
  })
  .superRefine((p, ctx) => {
    const seen = new Set<string>();
    const ids = [
      ...p.skills.map((s) => s.id),
      ...p.experiences.flatMap((e) => [e.id, ...e.bullets.map((b) => b.id)]),
      ...p.awards.map((a) => a.id),
      ...p.extras.map((x) => x.id),
    ];
    for (const i of ids) {
      if (seen.has(i)) ctx.addIssue({ code: "custom", message: `duplicate id "${i}"` });
      seen.add(i);
    }
  });

export type Profile = z.infer<typeof ProfileSchema>;

// me/private.yaml: used only to fill in form fields. Never sent to the AI, never logged.
const decline = "Decline to self-identify";
export const PrivateSchema = z.object({
  dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "use YYYY-MM-DD").optional(),
  address: z
    .object({
      street: z.string().optional(),
      city: z.string().optional(),
      state: z.string().optional(),
      zip: z.string().optional(),
      country: z.string().default("United States"),
    })
    .optional(),
  nuid: z.string().optional(),
  eeo: z
    .object({
      gender: z.string().default(decline),
      race: z.string().default(decline),
      hispanicLatino: z.string().default(decline),
      veteran: z.string().default(decline),
      disability: z.string().default(decline),
    })
    .prefault({}),
  // Anything else a form might ask for: label -> value.
  other: z.record(z.string(), z.string()).default({}),
});

export type PrivateInfo = z.infer<typeof PrivateSchema>;

// me/answers.yaml: your own answers to questions that come up again and again.
export const AnswerBankSchema = z
  .array(
    z.object({
      id,
      match: z.array(z.string()).min(1), // words or phrases that identify the question
      answer: z.string(),
      notes: z.string().optional(),
    }),
  )
  .default([]);

export type AnswerBank = z.infer<typeof AnswerBankSchema>;
