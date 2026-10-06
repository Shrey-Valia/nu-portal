// Every NUworks locator lives in this file. Values marked "recon" are
// placeholders until Phase 2 maps the real Symplicity pages; confirm each one
// against the live site before relying on it.

export const SESSION = {
  // recon: anything that only appears on a sign-in page.
  loginMarker: 'input[type="password"], button:has-text("Sign in"), a:has-text("Log in with")',
  // recon: something that only appears when signed in (e.g. the student nav). Null = not used yet.
  loggedInMarker: null as string | null,
  loginUrlPattern: /(login|signin|sso|saml|duosecurity|microsoftonline)/i,
};
