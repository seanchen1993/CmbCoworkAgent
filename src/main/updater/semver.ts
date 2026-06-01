/**
 * Compare two dotted-number version strings (e.g. "1.2.3").
 * Returns -1 if a < b, 0 if equal, 1 if a > b. Missing segments are treated as 0.
 *
 * Kept in its own file (no electron / no node-side dependencies) so it can be
 * imported by pure logic modules that need to run under vitest.
 */
export function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map(Number)
  const pb = b.split(".").map(Number)
  for (let i = 0; i < 3; i++) {
    const va = pa[i] ?? 0
    const vb = pb[i] ?? 0
    if (va < vb) return -1
    if (va > vb) return 1
  }
  return 0
}
