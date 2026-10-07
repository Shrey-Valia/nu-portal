// "linkedin.com/in/x" -> "https://linkedin.com/in/x"; empty stays empty.
export function withScheme(url: string | null | undefined): string | null {
  const u = (url ?? "").trim();
  if (!u) return null;
  return /^https?:\/\//i.test(u) ? u : `https://${u.replace(/^\/+/, "")}`;
}
