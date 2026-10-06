import { mkdirSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

// Renders letter HTML to PDF in a throwaway browser: no JavaScript, no network,
// and never the logged-in NUworks profile.
export async function renderPdf(html: string, outPath: string): Promise<string> {
  mkdirSync(path.dirname(outPath), { recursive: true });
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const context = await browser.newContext({ javaScriptEnabled: false });
    await context.route("**/*", (route) => (route.request().url().startsWith("data:") ? route.continue() : route.abort()));
    const page = await context.newPage();
    await page.setContent(html, { waitUntil: "load" });
    await page.pdf({ path: outPath, format: "Letter", printBackground: false, preferCSSPageSize: true });
    return outPath;
  } finally {
    await browser.close();
  }
}
