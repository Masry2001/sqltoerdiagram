// Runs "Arrange lines straight" off the main thread, so the page stays
// responsive while a large diagram is routed.
import { routeStraight } from './orthogonal-router.js';

self.onmessage = (event) => {
  const { tables, edges, anchors, hidden } = event.data;
  const byKey = new Map(tables.map((t) => [t.key, t]));
  const hiddenKeys = new Set(hidden);
  const started = performance.now();
  const result = routeStraight(edges, byKey, { anchors, isHidden: (k) => hiddenKeys.has(k) });
  self.postMessage({ ...result, ms: Math.round(performance.now() - started) });
};
