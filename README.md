# @heroplus/fe-test-kit

Fixture-corpus integrity checks shared by the HeroPlus frontend repos. A corpus of captured wire
bodies is only worth what its guards are worth: this package holds the guards, and each repo supplies
its own paths, its own check set, and its own reading of its corpus.

Extracted from `heroplus-merchant`'s `tools/fixtures/engine/` so that one engine serves several
consumers instead of being mirrored into each — mirroring is how two independent implementations of
the same check came to exist.

## Install

```json
"@heroplus/fe-test-kit": "Hero-Plus/fe-test-kit#v1.1.0"
```

Public on purpose. A private git dependency cannot install where there is no credential — Vercel
builds and GitHub Actions checkouts both lack one — and a per-machine token is the cost that ruled
out a package registry.

A git-tag dependency resolves to a SHA, so two consumers may sit on two majors indefinitely. There is
no pressure to migrate every repo at once.

## The one property this engine keeps

**It reads no host corpus or registry source, and parses no body.** The host tells the engine what its
corpus *contains*; the engine decides whether that is correct.

Scoped deliberately, because two checks do read host files and both are meant to: `no-pan` byte-scans
them looking for a card number, and `rule-coverage` text-parses `it` / `test` / `describe` titles out
of the repo's test files. Neither reads a body or a registry, which is where a representation choice
would otherwise become the engine's business.

Until v1.0 the engine resolved cells by parsing `corpus.ts` as source text, under a rule that read
*"checks read files, never modules"*. That rule is overturned for cell resolution, and it will not be
restored:

- **Its premise was false.** It justified text-parsing as *"importing needs a TS loader and a
  resolvable module graph, which the sibling repo adopting these checks will not have."* A 41-line
  loader built on the `typescript` devDependency every TS repo already carries is enough.
- **What it protected survives.** The engine still ships no loader and imports no corpus. The *host*
  resolves its own cells, by whatever means it likes, and hands back plain data.

The cost of the old rule was not theoretical: a corpus of TypeScript bodies made one check throw and
another exit 2 permanently, and a registry written with double quotes resolved **zero** cells while
reporting nothing. Both were representation choices the engine had no business knowing.

## Configuration — `HP_FIXTURES_CONFIG`

The package ships no paths of its own. Point `HP_FIXTURES_CONFIG` at your repo's fixture-path module,
as an absolute path:

```
HP_FIXTURES_CONFIG=$PWD/tools/fixtures/lib/paths.mjs hp-fixtures-verify
```

In a package script, prefer the defaulted form — a bare `VAR=value` prefix overrides an exported
value and would make a CI job-level `env:` inert:

```json
"fixtures:verify": "HP_FIXTURES_CONFIG=${HP_FIXTURES_CONFIG:-$PWD/tools/fixtures/lib/paths.mjs} hp-fixtures-verify"
```

Setting it once on `hp-fixtures-verify` is enough: it spawns each check as its own process and the
value is inherited.

### Core contract — six names, always required

| Name | Shape |
|---|---|
| `REPO_ROOT` | absolute path to the repo root |
| `absolute` | `relative => absolutePath` |
| `TOOLS_RELATIVE` | repo-relative path to the fixture tooling directory |
| `FIXTURES_RELATIVE` · `FIXTURES_DIR` | the corpus root, repo-relative and absolute |
| `CHECKS` | the checks this repo runs — see below |

### Per-check contract — validated only when that check is enabled

A name is required only when a check reading it is in `CHECKS`. That is what lets a two-check repo
adopt this package without inventing a rule spec and a cell manifest it has no intention of carrying.

| Check | Reads |
|---|---|
| `no-pan` | `PAN_ALLOWLIST_RELATIVE`, `PAN_ALLOWLIST` (the file itself stays optional) |
| `origin-set` | `ORIGIN_RELATIVE`, `CORPUS_ROOT_FILES`, `CORPUS_ROOT_SUFFIXES` |
| `verbatim` | `ORIGIN_RELATIVE`, `CAPTURED_ORIGIN`, `readBody` |
| `cell-map` | `enumerateCells`, `CELL_MANIFEST_RELATIVE`, `CELL_MANIFEST`, `ORIGIN_RELATIVE` |
| `capture-provenance` | `CAPTURED_ORIGIN`, `listCaptures`, `readBody`, `ORIGIN_RELATIVE` |
| `rule-coverage` | `TRANSACTION_TABLES_RELATIVE`, `TRANSACTION_TABLES`, `RULE_EXEMPTIONS_RELATIVE` |

`cell-map` and `capture-provenance` read `ORIGIN_RELATIVE` for the directory walk, not for the
registry: `cell-map` uses it to find bodies no registry entry names, and `capture-provenance` to find
the bodies sitting in the captured bucket.

**A body is a `.json` or a `.ts` file.** That pair is fixed in `lib/cells.mjs` and is deliberately not
on the config contract in v1.0 — see the comment there. Every check that walks `ORIGIN_RELATIVE`
classifies on it, so a `.tsx`, `.js` or `.mjs` body is invisible to `origin-set`, `verbatim`,
`capture-provenance` and `cell-map`'s orphan detector at once. A corpus written *entirely* in an
unlisted extension fails loudly — nothing classifies — but a **mixed** corpus silently drops the
unlisted files while the counts stay green and non-zero. Adding an extension is a kit change.

Requirements are keyed off the **kit file** an entry names, not off the host's `name` for it, so
renaming a check in `CHECKS` cannot silently drop its requirements.

**Optional — read by no check, and never required:**

- `SCRIPTS` — `{ verify, pinCells, listCells }`. Remediation messages name the host's own
  package-manager script when it is present, and fall back to a `node <path>` form when it is not.
  Declare it: the fallback is correct in every repo and idiomatic in none.
- `WIRE_CONVENTIONS` — the object a host passes to `makeShapes`. Nothing in the engine reads it; it is
  on the contract so that a host carrying it is not carrying a name the contract does not know about,
  and so a wrong-*typed* one is refused here rather than at the `makeShapes` call. The **values** are
  still `makeShapes`' business — it checks each against what its shape does with it.

### Validation

Presence is compared against `undefined` rather than tested with `in`, because a dynamic import
degrades a name the host never exported into `undefined` rather than raising a load error — and a
check handed `undefined` for a corpus path takes its skip branch and exits 0.

Structured values are shape-checked as well as present: `absolute`, `enumerateCells`, `readBody` and
`listCaptures` must be callable, the path lists must be arrays of strings, and `CHECKS` must be an
array of well-formed entries. A wrong-typed export otherwise loads clean and dies later as an
uncaught `TypeError` naming neither the config nor the name that was wrong.

| Situation | Result |
|---|---|
| `HP_FIXTURES_CONFIG` unset | `HostConfigError` naming the variable · exit **2** |
| set but unresolvable | `HostConfigError` naming the path it resolved · exit **2** |
| a core name missing | `HostConfigError` listing the missing names · exit **2** |
| a name an enabled check reads missing | `HostConfigError` listing them, and which checks read them · exit **2** |
| a wrong-shaped export | `HostConfigError` naming the name and the shape it needs · exit **2** |
| a malformed `CHECKS` entry | `HostConfigError` listing entries by index · exit **2** |

`config.mjs` re-exports every contract name, core and per-check alike, because ESM cannot re-export
from a dynamic specifier. `config-test.mjs` asserts the two copies agree.

## The three host functions

The host owns how its corpus is read. Import a registry through a TS loader, parse it with the opt-in
helper below, or read a file the repo generates — the engine only sees the result.

```js
// The corpus as it stands right now.
export async function enumerateCells(): Promise<{
  cells: Array<{ scenario: string, view: string, source: string | null, id: string | null }>,
  aux:   Array<{ name: string,   source: string | null, id: string | null }>,
  scenarios: string[],
  views:     string[],   // the host's own vocabulary — open-ended, not an engine enum
  ragged:    string[],   // host-defined; [] is legal
  duplicated: Array<{ scenario: string, id: string }>,
}>

// One body, as a comparable value. The path is ABSOLUTE and may sit outside the working tree.
export async function readBody(absolutePath: string): Promise<unknown>

// Every raw capture currently on disk, as comparable values.
export async function listCaptures(): Promise<Array<{ label: string, body: unknown }>>
```

**`view` is an open string.** `cell-map` pins `<scenario>.<view>` for whatever the host reports, so a
repo with four views and a repo with two run through the same engine. Every `view` a cell carries must
appear in `views`, or the provider is contradicting itself and the check exits 2 rather than minting a
manifest from the disagreement.

**`id: null` is legal.** A body with no top-level id is pinned by its `source` path alone.

**`source: null` means the host could not resolve that entry — cell or aux alike — to a file, and it is
a failure — exit 1, never a printed note.** Where cells resolve by object identity, one wrapper call that returns a new
object drops exactly one cell while the rest keep resolving; a note would let the next `--write`
regenerate a manifest one body short, which is the hollow-green failure this engine exists to prevent.
The same rule runs in the other direction: a body in an origin directory that no cell and no aux entry
names is an orphan, and also exit 1.

**`readBody` takes an absolute path, and that is load-bearing.** A repo-relative contract lets a host
resolve both sides of a HEAD comparison against the working tree, comparing a file with itself and
passing. The engine owns the HEAD-side tmpdir — `git archive HEAD <corpus>` extracted whole, so a
body's relative imports still resolve — and passes absolute paths on both sides.

**`readBody` must return a value, and `undefined` is refused.** `verbatim` and `capture-provenance`
count comparisons attempted, so a reading that yields nothing would deep-equal nothing on the other
side, pass every comparison, and report a non-zero count — the one hollow green the uniform vacuity
rule cannot see. Both checks stop with a setup error instead. The reading that produces it is
`(await import(url)).default` over a corpus of **named** exports, which returns `undefined` for every
body on both sides at once.

**A body may not import a value from outside the corpus root.** Only `FIXTURES_RELATIVE` is extracted
into that tmpdir, so a body whose module graph reaches outside it — or that needs a bare specifier
resolved against the repo — loads on the live side and fails on the HEAD side, surfacing as a setup
error naming a file that looks perfectly fine. Sibling-body imports *inside* the corpus resolve
normally; that is what "extracted whole" buys.

## One body per file

**This is a property of the engine, not a repo's style preference.** `checks/origin-set.mjs` keys
bodies by basename and reports a bucket change only when the same basename maps to two origins. With
bodies grouped into one file per view, moving one from captured to authored is a cut-and-paste inside
two files that both stay put, and the check reports `entered: 0, left: 0, failures: 0`. The property
the whole design asserts would not exist.

**No two bodies anywhere in the corpus may share a filename**, and this is a hard adoption constraint
rather than a convention. The keying spans every origin directory at once, so
`captured/pos-detail/refunded.ts` beside `authored/dashboard-list/refunded.ts` is a collision and a
**setup error, exit 2** — in `origin-set` across the whole corpus, and in `verbatim` and
`capture-provenance` within the captured bucket. It is enforced loudly, so it costs an adoption a
renaming pass rather than a silent hole: two same-named bodies in two buckets make a move between
those buckets invisible, which is the one thing this check exists to see.

## Outcomes

| Exit | Tag | Meaning |
|---|---|---|
| 0 | `PASS` | `assertedCount > 0` and everything held |
| 1 | `FAIL` | it asserted and something did not hold |
| 2 | `FAIL (exit 2)` | setup error — unusable config, unreadable corpus, malformed manifest |
| 3 | `VACUOUS` | `assertedCount === 0` — it ran and asserted nothing |
| — | `SKIP` | the check *file* was absent, which for a `kit:` entry means a packaging failure |

**Vacuity is `assertedCount === 0`, uniformly — never a per-branch judgement.** Every check counts
what it actually checked and finishes through one shared `finish()` in `lib/outcomes.mjs`, which owns
the rule and prints the count. A branch cannot be trusted to recognise its own vacuity: v0.1.3's
`verbatim` judged its own emptiness from byte-identity and missed the case where HEAD held no captured
body at all — the comparison loop never ran, every live body landed in `added`, and it exited 0 with a
green `PASS`. `outcomes-test.mjs` pins that case as `vacuous`.

Failures are adjudicated before the count, because a reported failure *is* an assertion that did not
hold.

### `onVacuous` — whose problem an empty run is

```js
{ name: 'verbatim', kit: 'checks/verbatim.mjs', onVacuous: 'warn' }  // shallow CI checkout
{ name: 'cell-map', kit: 'checks/cell-map.mjs', onVacuous: 'fail' }  // a missing manifest is config
```

Default is `'fail'`. `'warn'` prints the identical `VACUOUS` tag and does not fail the run — so
"asserted nothing" is always visible, and whether it is tolerable is a committed decision with a diff
rather than a second vocabulary.

### Which checks survive a commit

Easy to get backwards, and getting it backwards is how a CI job ends up trusted for something it never
checked.

- **Durable** — `no-pan` byte-scans the working tree; `cell-map` pins against a committed manifest;
  `rule-coverage` reads test titles. All three keep asserting after the change is committed.
- **Pre-commit only** — `verbatim`, `origin-set`'s bucket half and `capture-provenance` compare against
  HEAD. On a clean committed tree they still assert (HEAD carries bodies to compare); they report
  `vacuous` when HEAD carries none, which is the normal state of a corpus mid-restructure.
- **`capture-provenance` has one narrow assert window**: a fresh promotion whose capture is still on
  disk, before the commit. After the commit HEAD holds the body, nothing is new, and it is `vacuous`.
  That is the correct reading of a corpus at rest — not a defect, and not a reason to weaken it.

**A repo with no corpus yet is `vacuous`, never a setup error.** An absent corpus root, and a corpus
root holding no classified body, both read that way in every corpus check — so a repo can enable
`no-pan` and `origin-set` before it has a single body and use `onVacuous: 'warn'` to say that the
emptiness is its normal state. Exit 2 is the one outcome that policy cannot soften, which is why no
check spends it on an empty tree. The exception is deliberate: `origin-set`'s corpus-root allowlist
reads only the filesystem, so an unlisted file at the corpus root is a **failure** whether or not
there was a body to compare.

## `CHECKS` — host-owned, and host check files are first-class

```js
{ name, kit:  'checks/no-pan.mjs',           required?: true, onVacuous?: 'fail' | 'warn' }
{ name, host: 'tools/fixtures/checks/x.mjs' }
```

`kit:` resolves against this package's directory, so a missing file can only be a packaging failure —
never a repo declining a check. `host:` resolves against `REPO_ROOT`, and a missing one is a **config
error (exit 2)**, because the host named it.

**A `host:` check predates this vocabulary and does not call `finish()`.** Its bare exit code is read
literally — 0 asserted, 1 failed, 2 setup error, and 3 only if it happens to use it — and `onVacuous`
is inert for one, so declaring it on a `host:` entry is refused rather than accepted and ignored.

**`required` is refused on a `host:` entry for the same reason.** It is consulted only where a `kit:`
file is absent, which can only be a packaging failure; a `host:` file the repo named and does not carry
already fails the run outright, so the flag cannot change any outcome. Both refusals are validation
errors listing the entry by index — exit **2**.

The check set is the host's rather than a list in this file: a list here could not express one repo
running four checks and another six, and auto-discovery would leave this file byte-identical across the
repos while making check-set divergence between them invisible.

The engine's own unit suites are appended to every host's list and cannot be dropped. They assert
nothing about the corpus, so no repo has grounds to decline them, and the runner is the only executor a
pull request reaches.

## Commands

Invoke by `bin` name, never by a `node_modules/…` path — the consuming repos use yarn classic, Berry
and pnpm, which lay `node_modules` out differently.

| `bin` | File | Purpose |
|---|---|---|
| `hp-fixtures-verify` | `verify.mjs` | runs this repo's checks and every unit suite |
| `hp-fixtures-no-pan` | `checks/no-pan.mjs` | card-number scan; the one check CI runs alone |
| `hp-fixtures-cell-map` | `checks/cell-map.mjs` | `--write` regenerates the manifest, `--list` prints it |
| `hp-fixtures-mint` | `mint.mjs` | caches a fixture token for one host and region |
| `hp-fixtures-config-test` | `config-test.mjs` | the config contract |
| `hp-fixtures-luhn-test` | `lib/luhn-test.mjs` | card-number detector unit suite |
| `hp-fixtures-mint-test` | `lib/mint-test.mjs` | the minter's control flow, against a local stub |
| `hp-fixtures-outcomes-test` | `outcomes-test.mjs` | the outcome vocabulary, against scratch repos |
| `hp-fixtures-parser-test` | `lib/registry-parser-test.mjs` | the opt-in registry parser |
| `hp-fixtures-shapes-test` | `shapes-test.mjs` | placeholder-shape unit suite |

`checks/verbatim.mjs`, `checks/origin-set.mjs`, `checks/capture-provenance.mjs` and
`checks/rule-coverage.mjs` have no `bin`: nothing invokes them alone, and host-owned `CHECKS` reaches
them anyway.

`hp-fixtures-cell-map --write` exits 0 having asserted nothing, and stays outside the outcome
vocabulary deliberately: it is a generator invocation, not a check run, and its product is reviewed
through `--list` and the diff. The resolution guards run before it, so a corpus the host cannot fully
resolve can never mint a manifest.

`verify-test.mjs` is **not** among the appended suites and must stay out: it spawns the runner, and the
runner spawns every appended suite. `npm test` covers it. The runner refuses a nested run, so
reintroducing it is a clean exit 2 rather than a hung machine.

There is no `exports` map, so deep subpaths such as `@heroplus/fe-test-kit/lib/luhn-test.mjs` resolve
as filesystem paths under all three package managers. The importable library surface is `index.mjs`:
`makeShapes`, `makeRegistryParser`, `redact`, `redactHeaders`.

## The opt-in registry parser

`makeRegistryParser` is the v0.1.3 cell reader, kept as a helper a host may call from its own
`enumerateCells`. It is no longer the engine's cell source.

```js
import { makeRegistryParser } from '@heroplus/fe-test-kit';

export const enumerateCells = makeRegistryParser({
  absolute,
  fixturesRelative: FIXTURES_RELATIVE,
  registryRelative: `${FIXTURES_RELATIVE}/corpus.ts`,
  quotes: 'both',            // 'single' | 'double' | 'both'
  detailConstruct: 'railed', // the call wrapping a detail body
  auxConstruct: 'deepFreeze',
  listPageRelative: LIST_PAGE_RELATIVE,
  listRowsKey: 'purchases',
  views: ['detail', 'list'], // the default; widen it, never narrow it
});
```

**`views` may only be widened.** The parser emits `detail` and `list` cells and nothing else, so it is
there for a host whose corpus carries a further view resolved by other means — declare the union and
the vocabulary stays honest. Drop either default and the result contradicts its own cells: `cell-map`
requires every `view` a cell carries to appear in `views`, and exits **2** on the disagreement.

Every representation choice the old parser hardcoded is a parameter here. `listPageRelative` and
`listRowsKey` describe a page-and-rows list model, which is one repo's, so they left the config
contract and live here. The scenario-key pattern is deliberately wider than any one repo needs: a key
the parser misses resolves no cell and reports nothing, and a match still has to land on an imported
body to enter the result.

## The harness contracts

Three declaration files under `harness/`, deep-imported as `@heroplus/fe-test-kit/harness/<name>`:

| File | Declares |
|---|---|
| `by-accessible-name.d.ts` | `AccessibleNameQueries<TElement>` |
| `mock-server.d.ts` | `ScenarioResponse`, `Scenario`, `ScenarioSelector<S>` |
| `conformance.d.ts` | `DisplayStatus`, `ConformanceCase`, `ConformanceTable`, `DisplayStatusFn` |

**All three ship zero runtime and must stay that way** — `import type` is erased before a bundler sees
the specifier, so exporting a value from one type-checks and then fails at bundle time in React Native.
If resolution ever regresses, the fix is a `types` or `typesVersions` entry here, never a per-repo copy:
a byte-identical copy is byte-identical on day one and divergent on day thirty with nothing comparing
them.

**A contract nobody annotates with is inert.** A factory returning a bare object literal types nothing
*through* a declaration, so no drift becomes a `tsc` error. Annotate the return —
`createMockServer<S>(…): ScenarioSelector<S> & { listen(): void; close(): void; reset(): void }`, or
`interface MockServer extends ScenarioSelector<Scenarios>` — or the deep import buys nothing.

### `by-accessible-name` — a property, never a query

What is shared is a **property**, never a query. Sharing the query is what broke the first attempt: the
web bodies use `getByRole('group')` and `getByRole('region')`, and React Native's `AccessibilityRole`
union has neither.

| Helper | Property asserted | Web body | React Native body |
|---|---|---|---|
| `rowFor(label, scope?)` | a row is locatable by its accessible name | `getByRole('group', { name })` | `getByRole('button', { name })` — rows are pressable |
| `cardFor(name)` | a titled section is locatable by its accessible name | `getByRole('region', { name })` | `getByLabelText(name)` on the container carrying the label |

**The markup each needs is a product decision, not a test detail**, and the two helpers need
different markup at different cost.

- Web: `role="group"` / `role="region"` plus `aria-labelledby`.
- React Native `rowFor`: `accessibilityRole="button"` **on an element that is already an
  accessibility element**, and no `accessibilityLabel`. A `Pressable` is one by default, which is why
  the role prop alone is enough on a row; the same prop on a plain `View` matches nothing.
- React Native `cardFor`: an explicit `accessibilityLabel` on the container, and **nothing else**.
  `accessible` is not part of this query and must not be added to satisfy it.

Measured against RNTL 13.3.3 and React Native 0.83 on 2026-08-05, so re-measure before trusting it
against a later release. The three facts that decide the markup:

- **`getByRole` gates on `accessible` before it ever compares the role.** `queryAllByRole`'s predicate
  is `isAccessibilityElement(node) && matchStringProp(getRole(node), role) && …`, and
  `isAccessibilityElement` returns `props.accessible` whenever that prop is set, falling back to *only*
  a host `Text` / `TextInput` / `Switch`. So `accessibilityRole="button"` on a bare `View` is filtered
  out before the role is read, silently. React Native's `Pressable` passes
  `accessible: accessible !== false`, which is what makes a row work with the role prop alone. There is
  no implicit `button` role — `getRole` returns an explicit `role` / `accessibilityRole`, else `'text'`
  for a host `Text`, else `'none'`.
- **`getByLabelText` never consults `accessible`.** `matchAccessibilityLabel` compares the string
  against `computeAriaLabel` — `aria-labelledby` / `accessibilityLabelledBy`, then `aria-label` /
  `accessibilityLabel`, then an Image `alt` — with no child-text fallback, and `findAll`'s only filter
  is `isHiddenFromAccessibility`. Any **host** element carrying the label matches.
- **`{ name }` is whole-string, not substring.** It resolves through `matches()`, which normalizes
  whitespace and defaults to `exact: true`, so one descendant `<Text>`'s *entire* text must equal
  `name`. A row whose amount cell reads `"RM 12.00"` is not found by `rowFor("12.00")`.

**What each prop costs a blind user**, which is why the markup column is the product's call and not a
test's. The role prop on a row is *additive*: TalkBack gains a spoken "button" and the child texts are
still read. An `accessibilityLabel` is the opposite — on a container that is an accessibility element
it *replaces* the sequence of child texts with one string, and `accessible={true}` is the prop that
makes a container one, collapsing its whole subtree into a single TalkBack node. Neither is free, and
neither may be added for a test's convenience: a repo adding either changes what a blind user hears
and owes a TalkBack pass.

`scope` stays optional on `rowFor` because `getByRole` throws on multiple matches — two rows sharing a
child text, a date or a status, name each other — where a scoped lookup does not.

### `mock-server` — what a scenario is, and how one is selected

```ts
interface ScenarioResponse { data: object | null; status: number }
type Scenario = () => ScenarioResponse;
interface ScenarioSelector<S> {
  select<K extends keyof S>(route: K, scenario: keyof NonNullable<S[K]> & string): void;
}
```

`{ data, status }` and "a scenario is a zero-argument function" are the shared part — what a fourth repo
copies, and what a captured body is fed through in the two that have one today. `data` is spelled
`object | null` because that is what `HttpResponse.json` accepts; a wider `unknown` only moves the cast
to the call site. What is deliberately **not** here:

- **No `ScenarioMap`.** A `Record<string, Record<string, Scenario>>` constraint rejects a map declared
  `Partial<Record<Path, …>>`, whose values are `… | undefined`. The map stays each repo's own: `S` is
  unconstrained and `NonNullable<S[K]>` absorbs the difference. Without the `NonNullable`,
  `keyof (X | undefined)` is `never` and every scenario name silently becomes unassignable.
- **No lifecycle, and no `useResponse`.** `listen` / `close` / `reset` differ by design between an
  `msw/node` and an `msw/native` setup, and `useResponse` exists in one repo — either on the contract
  leaves the other carrying an implemented-and-unused member.

**`select` is generic over the map, never over a route-key type.** Under a wide `K extends string` every
scenario name collapses to `string`, so any key is accepted and a typo surfaces only at run time.

**`select` is declared as a method, and that is load-bearing.** Only a method compares its parameters
bivariantly. As an arrow property it is contravariant, and an implementation spelling its own signature
`keyof S[K]` — which is how a factory generic over its map writes it — is then rejected outright.
Measured against TypeScript 5.8.3 and 5.9.3 on 2026-08-06.

### `conformance` — the projected case table

```ts
type DisplayStatus =
  | "Completed" | "Pending" | "Processing" | "Requested" | "PartiallyRefunded"
  | "PreAuthorized" | "Declined" | "Refunded" | "Canceled" | "Unknown";

interface ConformanceCase  { rule: string; name: string;
                             input: unknown; expected: DisplayStatus }
interface ConformanceTable { sourceTable: string;
                             vocabulary: DisplayStatus[]; rows: ConformanceCase[];
                             notProjected?: { rule: string; reason: string }[] }
type DisplayStatusFn = (input: ConformanceCase["input"]) => DisplayStatus;
```

Types a **case projection** of a spec predicate table: rows of `input → expected` derived from the
table, against which a repo runs its own status function. The projection is data derived from the spec,
never shared implementation — each repo keeps its own function.

**Not every rule in a table is projectable, and `notProjected` is why the gap is not silent.** A rule
whose input is the display status rather than the wire body — a tone, a label fallback — cannot be
written as `input → expected`. Projected anyway, a repo passes every row for it while still getting the
rule wrong, and its ledger reads that as conformance. Such rules stay in the ledger, adjudicated by
hand; they are listed here with a reason, and no test title cites them.

**`DisplayStatus` is the spec's vocabulary and no one repo's status enum.** Each repo maps its own enum
into it. A helper typed to return `string` would let a typo'd output pass `toBe(expected)` and leave the
case file's `vocabulary` decorative, which is why the union lives here and not in the JSON alone.

**`input` is wire-shaped**, in the field names the spec table uses, and each repo asserts it to its own
wire type before building a model from it. It is typed `unknown` rather than `Record<string, unknown>`
for that assertion's sake: a repo's wire type is an interface, an interface has no implicit index
signature, and TypeScript therefore refuses `Record<string, unknown> as WireThing` outright — the
narrower spelling would force `as unknown as` at every call site in every repo. Measured against both
consumers on 2026-08-06.

## The fixture-token minter

Recapture needs a `merchant_user` token. Each repo used to obtain one its own way — a human pasting
into `.env`, a per-run mint with nothing persisted, a clock-based freshness check — so the mint, the
cache and the 401 discipline live here once and each repo wires them in about twenty lines.

**Import it from the package root**, not by subpath. Deep imports work today only because this
package ships no `exports` map, and the day one is added for any subpath every undeclared deep import
breaks in all three consumers at once. The root is insulated from that.

```js
import { resolveAccount, withFreshToken } from '@heroplus/fe-test-kit';

const body = await withFreshToken(
  {
    baseUrl,
    region,
    account: resolveAccount(region),
    explicitToken: process.env.HP_DEV_ACCESS_TOKEN,
    explicitTokenSource: 'HP_DEV_ACCESS_TOKEN',
  },
  authorization => fetch(url, { headers: { Authorization: authorization } })
);
```

| Export | Purpose |
|---|---|
| `withFreshToken({ baseUrl, region, account, cacheDir, explicitToken, explicitTokenSource, fetchImpl }, perform)` | the whole dance; the only one a consumer normally calls |
| `assertMintableHost(baseUrl)` | throws unless this host may be minted against |
| `mintToken({ baseUrl, account, fetchImpl })` | the two POSTs; returns `Bearer <jwt>` |
| `readCachedToken({ baseUrl, region, cacheDir })` | the cached string, or `null` |
| `writeCachedToken({ baseUrl, region, cacheDir, authorization })` | atomic write; returns the path |
| `invalidateCachedToken({ baseUrl, region, cacheDir })` | deletes it; returns the path |
| `cachePathFor({ baseUrl, region, cacheDir })` | where it lives, for telling a human |

Failures throw with a `code`: `HOST_REFUSED`, `RATE_LIMITED` (plus `retryAfter`), `SIGNUP_FAILED`,
`NO_TOKEN`, `EXPLICIT_TOKEN_REJECTED`, `STILL_UNAUTHORIZED`, `BAD_ACCOUNT`, `BAD_CALL`.

### What `perform` must do, and what it may return

`perform(authorization)` receives the full `Bearer <jwt>` string and performs one request. A rejection
is recognised **either** as a returned object whose `status` is `401` **or** as a thrown error whose
`status` is `401` — both, because one consumer's HTTP client returns the response and the other
throws, and neither should have to adapt to the other. Anything else is passed through untouched.

### Staleness comes from the server, never from a clock

These JWTs carry `exp` in 2029 and the backend revokes them long before that: two of three credentials
measured on 2026-08-07 returned 401 while their `exp` read 2029-05-03. An expiry pre-flight passes both.

```
cached token exists?  → use it
  request returns 401? → invalidate, mint ONCE, replace the cache, retry the request ONCE
    still 401?         → fail loudly. No loop. No second mint.
no cached token?      → mint, cache, proceed
mint returns 429?     → fail, naming retry_after. Never tight-retry.
```

`explicitToken` wins over the cache, is normalised from either a bare or a `Bearer `-prefixed string,
and is **never written to the cache** — it is not the minter's to own. By the same reasoning a rejected
one is not silently replaced: it fails as `EXPLICIT_TOKEN_REJECTED`, so a dead CI secret stays visible
as a dead CI secret instead of becoming a mint on every run. Pass `explicitTokenSource` with the name
of whatever supplied it — the repos read different variables, and the operator's next action is to
rotate one of them.

### The cache — one file per host and region, shared by every repo

`~/.heroplus/fixture-tokens/<sanitised-host>--<REGION>.tok`, file `0600` inside a `0700` directory,
holding the full `Bearer <jwt>` with no trailing newline. `HP_FIXTURE_TOKEN_DIR` overrides the
directory; `cacheDir` overrides both.

It is **shared across repos** because `signup/ip/long` allows only 5 mints per hour per IP, and a cache
per repo spends that budget once per repo. It is keyed by **resolved host** — including the port,
which is what keeps two local stubs distinct — because the repos resolve their base URL asymmetrically:
RN falls back to dev when `HP_DEV_API_URL` is unset, while merchant's `NEXT_PUBLIC_API_URL` has no
default and fails closed. A region-only key would hand one repo the other environment's token, which
surfaces as a confusing 401 rather than loudly.

Writes go through a temp file and an atomic `rename`, and after minting the cache is re-read: two
repos can recapture at once, and a sibling's token is no older than one you just minted, so converging
on it beats overwriting it.

### Minting is refused against production

The fixture account is a live production merchant login, and both an explicit argument and
`HP_DEV_API_URL` can point at production — so the guard reads the **resolved** base URL, not whatever
named it.

- **Mintable:** `dev.heroplusgroup.com`, `staging.heroplusgroup.com`.
- **Also mintable**, because no real credential can exist there: `localhost`, `127.0.0.0/8`, `[::1]`,
  and any host under `.test`, `.localhost`, `.invalid` or `.example`. This clause is load-bearing —
  the control-flow proof is an HTTP stub on `127.0.0.1`, and removing the clause reddens 13 of
  `lib/mint-test.mjs`'s cases.
- **Everything else is refused**, `app.heroplusgroup.com` named in the message. An unrecognised host
  such as `uat.heroplusgroup.com` is refused deliberately, so adding an environment stays a decision.

### Five throttles gate signup, not one

`merchant_signup` is throttled by IP (3 per minute *and* 5 per hour), by phone number (2 per 10
minutes), by country code (5 per 10 minutes), and globally (10 per minute). A 429 therefore cannot tell
you which one fired, which is why the minter surfaces `retry_after`, names all five, and never retries.
Two consequences worth planning around: a cold three-region run leaves only two more region-mints in
the same rolling hour, and re-minting the *same* region twice inside ten minutes is blocked by a
throttle no shared cache can help with.

### The account table

`lib/fixture-accounts.mjs` carries TH, HK and MY. `resolveAccount(region, { repoAccounts })` resolves
through `~/.heroplus/fixture-accounts.json` → the repo's own table, if it ships one → the kit default,
so a machine or CI substitutes without a diff. `HP_FIXTURE_ACCOUNTS_FILE` moves the first tier, and a
`machineFile` option overrides both. A region missing from one tier falls through to the next rather
than failing, and a half-filled account is refused naming the tier it came from — otherwise a bad
override reaches the wire and returns a 422 that points at no one. **No repo needs a table** unless it
has a region the kit does not carry. The TH account is the one that is also a production login, and is
why the host guard exists.

### `hp-fixtures-mint`

```
hp-fixtures-mint --base-url <url> --region <TH|HK|MY> [--cache-dir <dir>] [--force]
```

Mints only if nothing is cached, and prints the **cache file path** on stdout — never the token, and
there is deliberately no flag that prints it. Minting runs inline in an orchestrated session, so this
command's stdout is a transcript. Read the value with `readCachedToken`. `--force` mints over a cached
token and spends one of five mints per hour.

Exit codes follow the outcome vocabulary as far as they apply: `0` cached or minted, `1` the mint
failed, `2` the arguments or the host were unusable.

## Migrating from v0.1.3

v1.0.0 breaks the config contract, the outcome vocabulary and the cell model. A v0.1.3 consumer needs
all of the following.

1. **Add `CHECKS`** to the path module. It was a module-scope list inside `verify.mjs`; it is now the
   host's, and it is a core name.
2. **Drop `LIST_PAGE_RELATIVE` and `LIST_ROWS_KEY` from the config contract** and pass them to
   `makeRegistryParser` instead.
3. **Add `enumerateCells`** — for a corpus that parsed cleanly under v0.1.3, `makeRegistryParser` with
   `quotes: 'single'` reproduces the old behaviour exactly. Two changes are visible in its result: the
   per-cell field is `id`, not `purchase`, and there is a `views` array.
4. **Add `readBody`** if `verbatim` is enabled, and `listCaptures` if `capture-provenance` is. Both are
   new; `readBody` for a JSON corpus is one line.
5. **Add `CAPTURED_ORIGIN`** — the bucket basename meaning "came off the wire", which `verbatim`
   hardcoded as `'captured'`.
6. **Add `RULE_EXEMPTIONS_RELATIVE`** if `rule-coverage` is enabled — the filename it hardcoded.
7. **Regenerate the cell manifest**: the per-cell key `purchase` is now `id`, and the manifest gains
   `counts.byView` entries for every view the host reports.
8. **Set `onVacuous: 'warn'`** on `verbatim` and `origin-set` if a shallow CI checkout — or a corpus
   that has not landed yet — is the normal state, or those runs now redden rather than printing
   `ASSERTED NOTHING` and exiting 0.

**One migration trap worth naming.** `cell-map` now fails on a body in an origin directory that no cell
and no aux entry names. A function-produced body — merchant's `derived/list.ts` exports
`emptyListEnvelope()`, which returns a fresh object per call — can never be named by an
identity-resolved registry, so under v1.0 it is an orphan and exit 1. Either report it from
`enumerateCells` as an aux entry, or move it out of the origin tree; it is not merely unused there, it
is unreachable.

## Releasing

**Bump `version` in `package.json` in the same commit as the change, before creating the tag.** Tagging
first and bumping after produces a package whose declared version contradicts the tag that installed
it, and the only way to correct it is another tag — which is why two are missing below.

`main` carries two withdrawn tags' commits, both still reachable for provenance. Do not recreate
either:

| Tag | Why it is gone |
|---|---|
| `v0.1.0` | `verify.mjs` tallied a check that asserted nothing as `PASS`, so an `HP_FIXTURES_CONFIG` pointing at the wrong tree read fully green. Exit 3 and the `VACUOUS` tag are the fix. |
| `v0.1.2` | Behaviour identical to `v0.1.3`, but its `package.json` declared `0.1.1` — tagged without bumping. |

## Caveat — what a green run still does not prove

- **`no-pan` over a thin corpus.** It scans whatever the corpus holds; a corpus holding one file is
  scanned honestly and passes honestly. An *empty* corpus root is now `vacuous`, so a zero-file scan
  can never carry a green tag.
- **A `warn` policy is a decision to tolerate an empty run.** The tag is still printed. Read the counts
  each check prints, not just the tag.
- **Nothing here proves a check fires.** A green run on a tree where HEAD and the working tree agree
  proves only that nothing crashed. Perturb one body, confirm red, revert — that is the only evidence.

## Conventions

Unit suites are named `*-test.mjs`, not `*.test.mjs`: jest's default `testMatch` claims the dotted
form, and jest cannot execute `node:test`.

**`rule-coverage` scans the host's tests by the dotted form only** — `*.test.js`, `.jsx`, `.ts`, `.tsx`,
`.cjs`, `.mjs`. A React Native repo following the community `*-test.js` default matches **zero** files,
and the check exits **2** naming the pattern it scanned rather than reporting every conforming rule as
unbacked. Renaming the suites is the fix. It is an adoption constraint rather than a preference, and it
is the one place where this package's own naming and the naming it requires of a host differ.
