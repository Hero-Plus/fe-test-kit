#!/usr/bin/env node
// checks/verbatim.mjs — asserts no captured body was hand-edited or dropped. A
// captured body is a wire record, so an edited value is a claim the backend never made — and it
// compiles clean and passes every test that reads it.
//
// Bodies are keyed by basename so the comparison survives a directory restructure: the body is the
// same wire record wherever the tree puts it, and where it sits is `origin-set.mjs`'s question.
//
// Pre-commit guard, vacuous once committed by construction. `cell-map.mjs` is the durable guard.
//
// Usage: no options; runs from hp-fixtures-verify
// Exit codes: 0 pass, 1 a captured body was altered or removed, 2 setup error.
import { AssertionError, deepStrictEqual } from 'node:assert';
import { readFileSync } from 'node:fs';

import { headContent, headPaths, listBodies } from '../lib/cells.mjs';
import { absolute, FIXTURES_RELATIVE } from '../config.mjs';

// Values, not bytes: `scrub.mjs` runs prettier over everything it emits, so formatting is
// machine-owned and a reflow is not an edit to the wire record.
const deepEq = (a, b) => {
  try {
    deepStrictEqual(a, b);
    return true;
  } catch (err) {
    if (err instanceof AssertionError) return false;
    throw err;
  }
};

const collect = (entries, side) => {
  const map = new Map();
  const collisions = [];
  for (const entry of entries) {
    const seen = map.get(entry.basename);
    if (seen)
      collisions.push(`${side}: ${seen.relative} and ${entry.relative}`);
    else map.set(entry.basename, entry);
  }
  return { map, collisions };
};

const live = collect(
  listBodies().filter(
    body => body.origin === 'captured' && body.relative.endsWith('.json')
  ),
  'working tree'
);

let headListing;
try {
  headListing = headPaths();
} catch (err) {
  console.error(
    'verbatim: could not read the HEAD corpus —',
    String(err.stderr ?? err).slice(0, 300)
  );
  process.exit(2);
}

// Root-level JSON is excluded because it is not a body — a stray one there is what `origin-set.mjs`'s
// root allowlist refuses, and counting it here would read as a body that went missing.
const head = collect(
  headListing
    .filter(
      relative =>
        relative.endsWith('.json') &&
        relative.slice(`${FIXTURES_RELATIVE}/`.length).includes('/')
    )
    .map(relative => ({
      relative,
      basename: relative.slice(relative.lastIndexOf('/') + 1),
    })),
  'HEAD'
);

console.log(
  `verbatim: ${live.map.size} captured bodies · HEAD: ${head.map.size}`
);

if (live.map.size === 0) {
  console.error(
    `\nverbatim: no captured body found under ${FIXTURES_RELATIVE}. Nothing was compared.`
  );
  process.exit(2);
}

const collisions = [...live.collisions, ...head.collisions];
if (collisions.length) {
  console.error(
    `\nverbatim: ${collisions.length} body basename(s) are not unique, so bodies cannot be paired:`
  );
  for (const c of collisions) console.error(`  ${c}`);
  process.exit(2);
}

const altered = [];
const removed = [];
const added = [];
let identicalBytes = 0;

for (const [basename, before] of head.map) {
  const now = live.map.get(basename);
  if (!now) {
    removed.push(before);
    continue;
  }
  let wasValue;
  let isValue;
  try {
    // Text rather than through `readJson`, because the bytes answer a second question the parsed
    // values cannot: whether this run had anything to compare at all.
    const wasText = headContent(before.relative);
    const nowText = readFileSync(absolute(now.relative), 'utf8');
    if (wasText === nowText) identicalBytes += 1;
    wasValue = JSON.parse(wasText);
    isValue = JSON.parse(nowText);
  } catch (err) {
    console.error(`verbatim: could not read ${basename} — ${err.message}`);
    process.exit(2);
  }
  if (!deepEq(wasValue, isValue)) altered.push({ before, now });
}
for (const [basename, body] of live.map) {
  if (!head.map.has(basename)) added.push(body);
}

console.log(`  altered vs HEAD: ${altered.length}`);
console.log(`  no longer present under captured/: ${removed.length}`);
console.log(`  new since HEAD: ${added.length}`);

// Terminal's half A — proving a new body byte-matches the capture it came from — has no analogue
// here. `fetch.mjs` writes the raw wire and `scrub.mjs` derives the committed body from it, so a
// captured body never equals its capture; all 19 carry scrub placeholders. That capture-to-emit
// integrity is asserted where the raw capture actually exists, in `scrub.mjs`'s
// `assertOnlyClassifiedFieldsChanged` (`:322`) and `assertNoScrubbedValueSurvives` (`:394`).
if (added.length) {
  console.log(
    '\n  New bodies are reported, not adjudicated — nothing here can prove one was captured\n' +
      '  rather than written. Their integrity is asserted by the recapture itself:'
  );
  for (const b of added) console.log(`    ${b.relative}`);
}

let failed = false;

if (altered.length) {
  failed = true;
  console.error(
    `\nFAIL — ${altered.length} captured body(ies) changed value vs HEAD:`
  );
  for (const a of altered) console.error(`  ${a.now.relative}`);
  console.error(
    '\n  A captured body changes only by recapture. Restore it from HEAD, or re-run the capture so\n' +
      '  the new values arrive with the provenance that makes them a wire record.'
  );
}
if (removed.length) {
  failed = true;
  console.error(
    `\nFAIL — ${removed.length} captured body(ies) at HEAD are no longer under captured/:`
  );
  for (const r of removed) console.error(`  ${r.relative}`);
  // There is no acceptance flag, unlike the recapture's own `--accept-removals`, because this check
  // is spawned with no arguments. A removal the operator already authorised there still shows up
  // here once, naming the body — then clears itself, since after the commit HEAD no longer holds it.
  console.error(
    '\n  If the removal was deliberate and already accepted by the recapture, this is the last\n' +
      '  place the departing wire record is named: commit it, and the comparison goes quiet.'
  );
}

if (failed) process.exit(1);

// Byte-identity on every pair, with nothing added or removed, is the one state in which the value
// comparison could not have failed — a reflow-only difference still gives it something to bite on.
const comparedNothing =
  removed.length === 0 &&
  added.length === 0 &&
  identicalBytes === head.map.size;

if (comparedNothing) {
  console.log(
    '\n  ASSERTED NOTHING — every captured body is byte-identical to HEAD and no body was added or\n' +
      '  removed, so this run compared the HEAD corpus with itself. A fresh checkout has no other\n' +
      '  state available: this check is a pre-commit guard, and there is no CI position where it can\n' +
      '  go red only for a real reason — against a merge base it reds for the whole life of a\n' +
      '  legitimate recapture branch, and after a recapture it reds on `balance` alone. What holds\n' +
      '  the same ground durably: cell-map.mjs pins each cell to its body path and purchase id, and\n' +
      '  `report.mjs --check` is the calibrated post-recapture drift gate.'
  );
}

console.log(
  comparedNothing
    ? '\nPASS — nothing to compare: the captured corpus is HEAD’s byte for byte'
    : '\nPASS — no captured body was altered or removed'
);
