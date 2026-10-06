import type { BrowserHandle } from "./browser.js";
import { AdapterNotReadyError, type ApplicationsSnapshot, type NuworksAdapter, type Posting, type PostingSummary } from "./adapter.js";

// Real NUworks reads. Filled in during Phase 2 recon, once the Symplicity pages
// and any JSON endpoints they call are mapped and confirmed against the live
// site (see docs/recon/nuworks-map.md). Until then every method refuses, so
// nothing guesses at selectors.
export class LiveAdapter implements NuworksAdapter {
  readonly kind = "live";

  constructor(private readonly handle: BrowserHandle) {}

  private notReady(): never {
    throw new AdapterNotReadyError("NUworks isn't mapped yet. Run Phase 2 recon (npm run recon) before live NUworks runs.");
  }

  async search(): Promise<PostingSummary[]> {
    return this.notReady();
  }

  async detail(_id: string): Promise<Posting> {
    return this.notReady();
  }

  async applications(): Promise<ApplicationsSnapshot> {
    return this.notReady();
  }

  async resumeStatus(): Promise<{ approved: boolean; name: string | null }> {
    return this.notReady();
  }

  async close(): Promise<void> {
    await this.handle.close();
  }
}
