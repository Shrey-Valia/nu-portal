import type { Brain, BrainMeta, StructuredRequest } from "./types.js";

// Test double: answers come from a handler keyed on the request's purpose.
export class FakeBrain implements Brain {
  calls: StructuredRequest<unknown>[] = [];

  constructor(private readonly handler: (req: StructuredRequest<unknown>) => unknown) {}

  async structured<T>(req: StructuredRequest<T>): Promise<{ data: T; meta: BrainMeta }> {
    this.calls.push(req as StructuredRequest<unknown>);
    const data = req.schema.parse(await this.handler(req as StructuredRequest<unknown>));
    return { data, meta: { model: "fake", costUsd: 0, durationMs: 0, attempts: 1 } };
  }

  async health() {
    return { ok: true, detail: "fake brain" };
  }
}
