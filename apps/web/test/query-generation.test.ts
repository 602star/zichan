import { describe, expect, it } from 'vitest';
import { QueryGeneration } from '../src/query-generation.js';

describe('query page generation', () => {
  it('rejects duplicate requests synchronously', () => {
    const gate = new QueryGeneration();
    const token = gate.start()!;
    expect(gate.start()).toBeUndefined();
    gate.finish(token);
    expect(gate.start()).toBeDefined();
  });
  it('prevents stale results and stale finally handlers from affecting a new query', async () => {
    const gate = new QueryGeneration();
    const a = gate.start()!;
    let complete!: () => void;
    let merged = false;
    const pending = new Promise<void>((resolve) => { complete = resolve; }).then(() => {
      if (gate.current(a)) merged = true;
      gate.finish(a);
    });
    gate.reset();
    const b = gate.start()!;
    complete();
    await pending;
    expect(merged).toBe(false);
    expect(gate.current(b)).toBe(true);
    expect(gate.start()).toBeUndefined();
    gate.finish(b);
    expect(gate.start()).toBeDefined();
  });
  it('invalidates results when a screen is disposed', () => {
    const gate = new QueryGeneration();
    const token = gate.start()!;
    gate.reset();
    expect(gate.current(token)).toBe(false);
  });
});
