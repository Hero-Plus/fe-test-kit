# @heroplus/fe-test-kit

Fixture-corpus integrity checks shared by the HeroPlus frontend repos. A corpus of captured wire
bodies is only worth what its guards are worth: this package holds the guards, and each repo supplies
its own paths.

Extracted from `heroplus-merchant`'s `tools/fixtures/engine/` so that one engine serves several
consumers instead of being mirrored into each — mirroring is how two independent implementations of
the same check came to exist.

## Install

```json
"@heroplus/fe-test-kit": "Hero-Plus/fe-test-kit#v0.1.0"
```

Public on purpose. A private git dependency cannot install where there is no credential — Vercel
builds and GitHub Actions checkouts both lack one — and a per-machine token is the cost that ruled
out a package registry.

## Configuration — `HP_FIXTURES_CONFIG`

The package ships no paths of its own. Point `HP_FIXTURES_CONFIG` at your repo's fixture-path module,
as an absolute path:

```
HP_FIXTURES_CONFIG=$PWD/tools/fixtures/lib/paths.mjs hp-fixtures-verify
```

Setting it once on `hp-fixtures-verify` is enough. It spawns each check as its own process without
overriding the environment, so all of them inherit the value.

### The contract — 16 names

Your module must export a value for every one of these. `config.mjs` validates the whole set on load
and refuses to hand a check a `undefined` path.

| Name | Shape |
|---|---|
| `REPO_ROOT` | absolute path to the repo root |
| `absolute` | `relative => absolutePath` |
| `TOOLS_RELATIVE` | repo-relative path to the fixture tooling directory |
| `FIXTURES_RELATIVE` · `FIXTURES_DIR` | the corpus root, repo-relative and absolute |
| `ORIGIN_RELATIVE` | repo-relative origin directories; a body's directory is its classification |
| `LIST_PAGE_RELATIVE` | repo-relative directory holding captured list pages |
| `LIST_ROWS_KEY` | the key holding the rows in a list-page envelope |
| `CORPUS_ROOT_FILES` · `CORPUS_ROOT_SUFFIXES` | what may sit at the corpus root without being a wire body |
| `PAN_ALLOWLIST_RELATIVE` · `PAN_ALLOWLIST` | the card-number allowlist |
| `CELL_MANIFEST_RELATIVE` · `CELL_MANIFEST` | the committed cell manifest |
| `TRANSACTION_TABLES_RELATIVE` · `TRANSACTION_TABLES` | the adjudicated rule spec |

The list is spelled out in `lib/host-config.mjs` as `CONFIG_NAMES`, and again as re-export lines in
`config.mjs`, because ESM cannot re-export from a dynamic specifier. `config-test.mjs` asserts the two
copies agree — a drifted pair would silently export `undefined`.

`config.mjs` resolves the contract; your module *is* the contract. That is why the two files are named
differently: one holds values, the other reaches them across a package boundary.

### Failure behaviour

| Situation | Result |
|---|---|
| `HP_FIXTURES_CONFIG` unset | `HostConfigError` naming the variable · exit **2** |
| set but unresolvable | `HostConfigError` naming the path it resolved · exit **2** |
| resolves, but a name is missing or `undefined` | `HostConfigError` listing the missing names · exit **2** |

The message prints without a stack trace and the process exits 2, `verify`'s setup-error code. A
caller that wants to handle this instead can `await import()` the config inside `try`/`catch`; a
handled rejection never reaches the process-level handler.

## Commands

Invoke by `bin` name, never by a `node_modules/…` path — the consuming repos use yarn classic, Berry
and pnpm, which lay `node_modules` out differently.

| `bin` | File | Purpose |
|---|---|---|
| `hp-fixtures-verify` | `verify.mjs` | runs every check and every unit suite |
| `hp-fixtures-no-pan` | `checks/no-pan.mjs` | card-number scan; the one check CI runs alone |
| `hp-fixtures-cell-map` | `checks/cell-map.mjs` | `--write` regenerates the manifest, `--list` prints it |
| `hp-fixtures-config-test` | `config-test.mjs` | the 16-name contract |
| `hp-fixtures-luhn-test` | `lib/luhn-test.mjs` | card-number detector unit suite |
| `hp-fixtures-shapes-test` | `shapes-test.mjs` | placeholder-shape unit suite |

`checks/verbatim.mjs`, `checks/origin-set.mjs` and `checks/rule-coverage.mjs` have no `bin`: nothing
invokes them alone, so they run from `hp-fixtures-verify` only.

Running a unit suite through its `bin` gives the same exit status as `node --test` on the same file,
so either spelling works in a package script.

There is no `exports` map, so deep subpaths such as
`@heroplus/fe-test-kit/lib/luhn-test.mjs` resolve as filesystem paths under all three package
managers. The importable library surface is `index.mjs`.

## The check set is explicit on purpose

`CHECKS` in `verify.mjs` is a written-out list, not a directory read. Auto-discovery would leave that
file byte-identical in every repo while making check-set divergence between them invisible, and would
turn deleting a check into a behaviour change with no diff.

Entries marked `required` fail the run when the file is missing. Inside a package that can only mean
the package did not ship the file, since `verify.mjs` resolves each entry against its own directory.

## Outcomes

| Exit | Summary tag | Meaning |
|---|---|---|
| 0 | `PASS` | the check asserted something and it held |
| 1 | `FAIL` | the check asserted something and it did not hold |
| 2 | `FAIL (exit 2)` | setup error — unusable config, unreadable corpus, malformed manifest |
| 3 | `VACUOUS` | the check ran but asserted nothing, because a config artifact it reads is absent |
| — | `SKIP` | the check *file* was absent, which inside this package means a packaging failure |

`verify.mjs` exits 2 if any check hit a setup error, 1 if any check failed, 3 if any check was vacuous,
and 0 only when every check asserted something.

**A vacuous check fails the run.** Three branches reach it — `rule-coverage` with no rule spec,
`cell-map` with no committed manifest, `no-pan` with no corpus root. Each one previously exited 0 and
was tallied as a pass, which meant a wholly wrong `HP_FIXTURES_CONFIG` could produce an all-`PASS` run.
If a repo legitimately does not carry one of these artifacts, drop that check from `CHECKS` so the
decision has a diff — do not leave it reporting green over nothing.

## Caveat — what a green run still does not prove

Config-absence no longer hides in a `PASS`; that is what exit 3 is for. Two vacuous cases remain, and
both are environmental rather than config-driven:

- **`verbatim` and `origin-set` on a fresh checkout.** Both compare the working tree against `HEAD`, so
  on a clean tree they compare `HEAD` with itself. They print `ASSERTED NOTHING` with the reason and
  still exit 0 — deliberately. They are pre-commit guards, and there is no CI position where they can
  go red only for a real reason. `actions/checkout@v4` clones at depth 1, so this is the normal CI
  state, and converting it would redden every run.
- **`no-pan` over a thin corpus.** It scans whatever the corpus holds; a corpus holding one file is
  scanned honestly and passes honestly.

So read the counts each check prints, not just the tag. `no-pan` printing `scanning … — 0 file(s)` is a
different fact from `31 file(s)`, and only the second means your corpus was examined.

## Conventions

Unit suites are named `*-test.mjs`, not `*.test.mjs`: jest's default `testMatch` claims the dotted
form, and jest cannot execute `node:test`.
