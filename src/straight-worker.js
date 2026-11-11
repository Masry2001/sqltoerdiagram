// Runs "Arrange lines straight" off the main thread, so the page stays
// responsive while a large diagram is routed.
import { routeStraight, routeMoved } from './orthogonal-router.js';

self.onmessage = (event) => {
  const { tables, edges, anchors, hidden, keep, moved } = event.data;
  const byKey = new Map(tables.map((t) => [t.key, t]));
  const hiddenKeys = new Set(hidden);
  const started = performance.now();
  const opts = { anchors, keep, isHidden: (k) => hiddenKeys.has(k) };
  // lines of moved tables: the quick pass is sent first, then the final result
  const result = moved
    ? routeMoved(edges, byKey, opts, (quick) => self.postMessage({ ...quick, partial: true }))
    : routeStraight(edges, byKey, opts);
  self.postMessage({ ...result, ms: Math.round(performance.now() - started) });
};
