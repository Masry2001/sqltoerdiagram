// Runs "Arrange lines straight" off the main thread, so the page stays
// responsive while a large diagram is routed.
import { routeStraight, routeStraightTidy, routeMoved } from './orthogonal-router.js';

self.onmessage = (event) => {
  const { tables, edges, anchors, hidden, keep, moved, groups, tidy, passes = 1, lineGap, groupMargin, clearance } = event.data;
  const byKey = new Map(tables.map((t) => [t.key, t]));
  const hiddenKeys = new Set(hidden);
  const started = performance.now();
  // spacing options left out (undefined) take the router's defaults
  const spacing = Object.fromEntries(Object.entries({ lineGap, groupMargin, clearance }).filter(([, v]) => v != null));
  const opts = { ...spacing, anchors, keep, groups, isHidden: (k) => hiddenKeys.has(k) };
  // lines of moved tables: the quick pass is sent first, then the final result.
  // Arranging every line takes longer and also orders the lines where they
  // reach a table and routes the crossing ones again (tidy).
  const result = moved
    ? routeMoved(edges, byKey, opts, (quick) => self.postMessage({ ...quick, partial: true }))
    : tidy ? routeStraightTidy(edges, byKey, { ...opts, passes })
      : routeStraight(edges, byKey, opts);
  self.postMessage({ ...result, ms: Math.round(performance.now() - started) });
};
