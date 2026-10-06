import type { Page } from "playwright";

// External application systems (Track B).

export type AtsKind =
  | "greenhouse"
  | "lever"
  | "ashby"
  | "workday"
  | "icims"
  | "taleo"
  | "smartrecruiters"
  | "jobvite"
  | "other";

// Only these are automated. Everything else is "apply manually".
export const SUPPORTED_ATS: readonly AtsKind[] = ["greenhouse", "lever", "ashby"];

export type FieldType = "text" | "email" | "tel" | "url" | "number" | "date" | "textarea" | "select" | "radio" | "checkbox" | "file";

// What a field is for, when we can tell. "custom" = an employer-specific question.
export type FieldRole =
  | "first_name"
  | "last_name"
  | "full_name"
  | "preferred_name"
  | "email"
  | "phone"
  | "location"
  | "resume"
  | "cover_letter"
  | "linkedin"
  | "github"
  | "website"
  | "school"
  | "degree"
  | "discipline"
  | "grad_date"
  | "gpa"
  | "work_authorization"
  | "sponsorship"
  | "start_date"
  | "eeo_gender"
  | "eeo_race"
  | "eeo_hispanic"
  | "eeo_veteran"
  | "eeo_disability"
  | "date_of_birth"
  | "address"
  | "custom";

export interface FormField {
  key: string; // stable id for this field within the form (input name/id)
  label: string; // visible question text
  type: FieldType;
  role: FieldRole;
  required: boolean;
  options?: string[]; // select/radio/checkbox choices, visible text
  maxLength?: number;
  description?: string; // helper text under the label
}

export interface ApplyForm {
  ats: AtsKind;
  url: string;
  company: string | null;
  title: string | null;
  fields: FormField[];
  hasCaptcha: boolean;
  // Anything that means "stop and leave this for the user": login wall, closed posting, unknown widget...
  blockers: string[];
}

// Value for each field key. Files are absolute paths. Arrays are for multi-select checkboxes.
export type FieldValue = string | string[] | { file: string };
export type FillPlan = Record<string, FieldValue>;

export interface FillReport {
  filled: string[]; // keys filled
  skipped: { key: string; reason: string }[]; // optional fields left empty
  failed: { key: string; reason: string }[]; // could not fill; any required failure blocks submit
}

export type SubmitResult =
  | { status: "submitted"; confirmation: string }
  | { status: "unknown"; detail: string } // clicked, but could not confirm
  | { status: "blocked"; detail: string }; // captcha, validation errors, etc. Not submitted.

export interface AtsAdapter {
  kind: AtsKind;
  matches(url: string): boolean;
  // Navigate to the application form and describe it. Read-only.
  open(page: Page, url: string): Promise<ApplyForm>;
  // Fill fields; never submits.
  fill(page: Page, form: ApplyForm, plan: FillPlan): Promise<FillReport>;
  // Click submit and wait for a confirmation. Only called in live mode.
  submit(page: Page): Promise<SubmitResult>;
}
