/// <reference lib="webworker" />
import { runScenario } from '../fixtures/determinism';

export interface CheckResult {
  y: Float64Array;
  ms: number;
}

self.onmessage = () => {
  try {
    const start = performance.now();
    const y = runScenario();
    const ms = performance.now() - start;
    self.postMessage({ y, ms } satisfies CheckResult);
  } catch (e) {
    self.postMessage({ error: String(e) });
  }
};
