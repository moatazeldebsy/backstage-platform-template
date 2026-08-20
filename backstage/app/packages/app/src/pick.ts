// Returns the value paired with the first condition that is true, else the
// fallback. Exists to express an else-if chain as an expression without nesting
// ternaries, which `no-nested-ternary` forbids and which gets genuinely hard to
// read past two levels.
//
//   const color = firstMatch([
//     [pct >= 100, '#f44336'],
//     [pct >= 80,  '#ff9800'],
//   ], '#4caf50');
//
// Conditions are evaluated in order, exactly like the chain it replaces. The
// VALUES, however, are evaluated eagerly — every one of them, whether or not its
// condition matches. That is fine for literals and total expressions, but not
// for anything a preceding condition is guarding:
//
//   // WRONG: .toFixed runs even when remaining is null
//   firstMatch([[remaining != null, `$${remaining.toFixed(2)}`]], '—')
//
// Leave those as an if/else.
export function firstMatch<T>(bands: Array<readonly [boolean, T]>, fallback: T): T {
  for (const [when, value] of bands) {
    if (when) return value;
  }
  return fallback;
}
