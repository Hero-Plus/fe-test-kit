// Type-only, and it must stay that way: `import type` is erased before a bundler sees the specifier,
// so exporting a value here type-checks and then fails at bundle time in React Native with a
// resolution error pointing nowhere useful.
//
// What is shared is the property "locatable by its accessible name", never the query — the web bodies
// use roles React Native's `AccessibilityRole` union does not have. The per-platform bodies, and the
// accessibility markup each needs, are in this package's README under "The harness contract": that
// markup changes what a screen-reader user hears, so adding it is a product decision that owes a
// TalkBack pass, never a test convenience.
//
// `scope` is optional because `getByRole` throws on multiple matches where a scoped lookup does not.
export interface AccessibleNameQueries<TElement> {
  rowFor(label: string, scope?: TElement): TElement;
  cardFor(name: string): TElement;
}
