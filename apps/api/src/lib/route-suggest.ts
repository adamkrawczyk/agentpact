// Route suggestions for the 404 envelope (ROUTE_NOT_FOUND + didYouMean).
//
// Why: external sellers hand-write REST calls against the deals/needs surface.
// A guessed path (POST /api/deals instead of POST /api/deals/propose) used to
// be answered with 401 "Missing API key", because the auth preHandler ran for
// the not-found handler too. One external agent retried POST /api/deals ~1.8k
// times. A 404 that names the real route ends that loop in one round trip.
//
// Pure: no Fastify, no DB. index.ts feeds it the routes collected by onRoute.

export type KnownRoute = { method: string; url: string };

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

function segments(path: string): string[] {
  return path.split("?")[0].split("/").filter(Boolean);
}

// Cost of reaching `route` from `path`: 0 per matching segment (a `:param`
// segment matches anything), a normalised edit distance per differing segment,
// 0.3 (0.5 if :param) per segment the route has beyond the path (the caller stopped short,
// e.g. /api/deals for /api/deals/propose), 1 per segment the path has beyond
// the route, +1.25 when the method differs (a POST to a
// GET-only path most likely wants the POST sibling, e.g. /api/deals/propose).
export function routeCost(method: string, path: string, route: KnownRoute): number {
  const p = segments(path);
  const r = segments(route.url);
  let cost = p.length > r.length ? p.length - r.length : 0;
  // A caller who stopped short usually omitted an action word, not an id, so
  // an extra literal segment is cheaper than an extra :param segment.
  for (const seg of r.slice(p.length)) {
    cost += seg.startsWith(":") ? EXTRA_PARAM_SEGMENT_COST : EXTRA_ROUTE_SEGMENT_COST;
  }
  for (let i = 0; i < Math.min(p.length, r.length); i++) {
    if (r[i].startsWith(":") || r[i] === "*" || r[i] === p[i]) continue;
    cost += levenshtein(r[i], p[i]) / Math.max(r[i].length, p[i].length);
  }
  if (route.method.toUpperCase() !== method.toUpperCase()) cost += METHOD_MISMATCH_COST;
  return cost;
}

export const METHOD_MISMATCH_COST = 1.25;
export const EXTRA_ROUTE_SEGMENT_COST = 0.3;
export const EXTRA_PARAM_SEGMENT_COST = 0.5;
export const MAX_SUGGESTION_COST = 1.5;

export function suggestRoutes(method: string, path: string, routes: KnownRoute[], limit = 3): string[] {
  const seen = new Set<string>();
  return routes
    .filter((r) => r.method !== "HEAD" && r.method !== "OPTIONS")
    .map((r) => ({ label: `${r.method.toUpperCase()} ${r.url}`, cost: routeCost(method, path, r) }))
    .filter((s) => s.cost > 0 && s.cost <= MAX_SUGGESTION_COST)
    .sort((a, b) => a.cost - b.cost || a.label.localeCompare(b.label))
    .filter((s) => (seen.has(s.label) ? false : (seen.add(s.label), true)))
    .slice(0, limit)
    .map((s) => s.label);
}
