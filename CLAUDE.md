# NU Portal

Auto-apply assistant for Northeastern's NUworks co-op/job portal (https://nuworks.northeastern.edu/students, a Symplicity site). Pipeline: login → discover → match → review → apply → track. See README.md for the roadmap.

## Stack

- Node 20+, TypeScript (ESM, `NodeNext`), run with `tsx`
- Playwright driving the installed Google Chrome (`channel: "chrome"`) through a persistent profile in `.auth/browser-profile`
- `npm run login` saves the session; `npm run typecheck` checks types

## Hard rules

- Never type, store, or log the user's Northeastern password or Duo codes. Login is always manual in a headed window.
- Never submit an application without explicit user approval. Apply flows default to dry-run, stopping before the final submit.
- Never commit `.auth/`, `config/profile.json`, `documents/`, or `data/`.
- Respect `maxApplicationsPerRun` and keep actions rate-limited.

## Building scrapers and form fillers

Use the project MCP servers (`playwright`, `chrome-devtools`) to look at real NUworks pages before writing selectors. Prefer role/label/text locators (`getByRole`, `getByLabel`) over CSS classes, since Symplicity markup changes. Don't guess selectors. Confirm them against the live page.

Use the Context7 MCP (user scope) for current Playwright and library docs instead of relying on memory.
