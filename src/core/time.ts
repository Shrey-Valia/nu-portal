// Calendar math in your time zone without a date library.

export interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number; // 1 = Monday ... 7 = Sunday
}

const WEEKDAYS: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

export function localParts(date: Date, timeZone: string): LocalParts {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
      hourCycle: "h23",
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    weekday: WEEKDAYS[parts.weekday],
  };
}

export function localDay(date: Date, timeZone: string): string {
  const p = localParts(date, timeZone);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

// UTC instant of local midnight on the given local day.
export function startOfLocalDay(day: string, timeZone: string): Date {
  const [y, m, d] = day.split("-").map(Number);
  let guess = Date.UTC(y, m - 1, d, 0, 0);
  // Two passes settle the offset, including DST changeover days.
  for (let i = 0; i < 2; i++) {
    const p = localParts(new Date(guess), timeZone);
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    guess -= asUtc - Date.UTC(y, m - 1, d, 0, 0);
  }
  return new Date(guess);
}

export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}

// Monday of the local week containing `date`.
export function weekStartDay(date: Date, timeZone: string): string {
  const p = localParts(date, timeZone);
  return addDays(localDay(date, timeZone), 1 - p.weekday);
}

// Weekdays from today through Friday, counting today if it is a weekday.
export function weekdaysLeftInWeek(date: Date, timeZone: string): number {
  const wd = localParts(date, timeZone).weekday;
  return wd <= 5 ? 6 - wd : 0;
}

// Helpers used by the report and dashboard.

export function localMidnight(day: string, tz: string): number {
  return startOfLocalDay(day, tz).getTime();
}

export function dayIn(tz: string, at: Date | string | number = new Date()): string {
  return localDay(new Date(at), tz);
}

export const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface Range {
  start: string;
  end: string;
}

export function isDay(value: unknown): value is string {
  if (typeof value !== "string" || !DAY_RE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

export function assertDay(day: string): void {
  if (!isDay(day)) throw new Error(`Invalid day "${day}" (expected YYYY-MM-DD)`);
}

export function dayRange(day: string, tz: string): Range {
  return {
    start: new Date(localMidnight(day, tz)).toISOString(),
    end: new Date(localMidnight(addDays(day, 1), tz)).toISOString(),
  };
}

// Weeks run Monday through Sunday.
export function weekStart(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return addDays(day, -((dow + 6) % 7));
}

export function weekRange(day: string, tz: string): Range {
  const monday = weekStart(day);
  return {
    start: new Date(localMidnight(monday, tz)).toISOString(),
    end: new Date(localMidnight(addDays(monday, 7), tz)).toISOString(),
  };
}

export function daysBetween(fromDay: string, toDay: string): number {
  return Math.round((Date.parse(`${toDay}T00:00:00Z`) - Date.parse(`${fromDay}T00:00:00Z`)) / 86_400_000);
}

function valid(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function formatDateTime(iso: string | null | undefined, tz: string): string {
  const d = valid(iso);
  if (!d) return "";
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(d);
}

export function formatDate(iso: string | null | undefined, tz: string): string {
  const d = valid(iso);
  if (!d) return "";
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric" }).format(d);
}

export function formatTime(iso: string | null | undefined, tz: string): string {
  const d = valid(iso);
  if (!d) return "";
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(d);
}

export function formatLongDay(day: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "long", month: "long", day: "numeric", year: "numeric" }).format(
    new Date(`${day}T12:00:00Z`),
  );
}

export function ago(iso: string | null | undefined, nowMs = Date.now()): string {
  const d = valid(iso);
  if (!d) return "";
  const mins = Math.round((nowMs - d.getTime()) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}
