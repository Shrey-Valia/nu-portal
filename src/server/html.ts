// Tagged template that escapes every interpolation unless it is a SafeHtml
// (another html`` result or raw()). Arrays are rendered item by item and joined.

export class SafeHtml {
  constructor(readonly value: string) {}
  toString(): string {
    return this.value;
  }
}

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
  "`": "&#96;",
};

export function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>"'`]/g, (c) => ESCAPES[c]);
}

// Only for fragments the code itself produced. Never pass posting-derived text.
export function raw(value: string): SafeHtml {
  return new SafeHtml(value);
}

function fragment(value: unknown): string {
  if (value === null || value === undefined || value === false) return "";
  if (value instanceof SafeHtml) return value.value;
  if (Array.isArray(value)) return value.map(fragment).join("");
  return escapeHtml(value);
}

export function html(strings: TemplateStringsArray, ...values: unknown[]): SafeHtml {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += fragment(values[i]) + strings[i + 1];
  return new SafeHtml(out);
}

// Posting-derived links can carry javascript: or data: URLs; only http(s) is linkable.
export function safeUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
}
