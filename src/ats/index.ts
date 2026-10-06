import { ashby, createAshbyAdapter } from "./ashby.js";
import type { AdapterOptions, DescribingAdapter } from "./common.js";
import { detectAts } from "./detect.js";
import { createGreenhouseAdapter, greenhouse } from "./greenhouse.js";
import { createLeverAdapter, lever } from "./lever.js";
import type { AtsKind } from "./types.js";

export { applyUrlFor, detectAts } from "./detect.js";
export { classifyRole, matchOption, noDelay, type AdapterOptions, type Delay, type DescribingAdapter } from "./common.js";
export { standardFillPlan } from "./standard-values.js";

// Default adapters (no pacing). Use adapterFor(url, { delay }) for human-paced runs.
export const ADAPTERS: Partial<Record<AtsKind, DescribingAdapter>> = { greenhouse, lever, ashby };

const FACTORIES: Partial<Record<AtsKind, (opts: AdapterOptions) => DescribingAdapter>> = {
  greenhouse: createGreenhouseAdapter,
  lever: createLeverAdapter,
  ashby: createAshbyAdapter,
};

// The adapter for a posting URL, or null when its system is not automated (Workday, iCIMS, ...).
export function adapterFor(url: string, opts?: AdapterOptions): DescribingAdapter | null {
  const kind = detectAts(url);
  if (opts) return FACTORIES[kind]?.(opts) ?? null;
  return ADAPTERS[kind] ?? null;
}
