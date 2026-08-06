// The `{ data, status }` vocabulary and "a scenario is a zero-argument function" are the whole shared
// contract. Lifecycle — `listen` / `close` / `reset` — is off it because a node and a native msw setup
// differ there by design, and so is merchant's `useResponse`, which the other repo would then carry as
// an implemented-and-unused member.
export interface ScenarioResponse {
  // `HttpResponse.json`'s own parameter type; a wider `unknown` only moves the cast to the call site.
  data: object | null;
  status: number;
}

export type Scenario = () => ScenarioResponse;

// `S` is unconstrained: a `Record<string, Record<string, Scenario>>` bound rejects a map declared
// `Partial<Record<Path, …>>`, and `keyof (X | undefined)` is `never`, which would silently make every
// scenario name unassignable — so `NonNullable` absorbs the optionality instead of a bound.
//
// Generic over the map, never over a route-key type: under a wide `K extends string` every scenario
// name collapses to `string`, so a typo'd key would surface only at run time.
//
// Method syntax, not an arrow property: only a method compares parameters bivariantly, and the
// property form rejects an implementation spelling its own signature `keyof S[K]`.
export interface ScenarioSelector<S> {
  select<K extends keyof S>(
    route: K,
    scenario: keyof NonNullable<S[K]> & string
  ): void;
}
