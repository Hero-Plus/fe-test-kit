#!/usr/bin/env node
// checks/verbatim.mjs — asserts no captured body was hand-edited or dropped. A captured body is a
// wire record, so an edited value is a claim the backend never made — and it compiles clean and
// passes every test that reads it.
//
// Keyed by basename, so the comparison survives a directory restructure: where a body sits is
// `origin-set.mjs`'s question, not this one's.
//
// Both sides are absolute paths handed to the host's `readBody`. A repo-relative contract would let
// a host resolve both against the working tree, comparing a file with itself and passing.
import { AssertionError, deepStrictEqual } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { headPaths, isBody, listBodies, originOf } from '../lib/cells.mjs';
import { finish, setupError } from '../lib/outcomes.mjs';
import {
  absolute,
  CAPTURED_ORIGIN,
  FIXTURES_RELATIVE,
  readBody,
  REPO_ROOT,
} from '../config.mjs';

const CHECK = 'verbatim';

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
    if (seen) collisions.push(`${side}: ${seen.relative} and ${entry.relative}`);
    else map.set(entry.basename, entry);
  }
  return { map, collisions };
};

const live = collect(
  listBodies().filter(body => body.origin === CAPTURED_ORIGIN),
  'working tree'
);

let headListing;
try {
  headListing = headPaths();
} catch (err) {
  setupError(
    CHECK,
    `could not read the HEAD corpus — ${String(err.stderr ?? err).slice(0, 300)}`
  );
}

const head = collect(
  headListing
    .filter(
      relative => isBody(relative) && originOf(relative) === CAPTURED_ORIGIN
    )
    .map(relative => ({
      relative,
      basename: relative.slice(relative.lastIndexOf('/') + 1),
    })),
  'HEAD'
);

console.log(
  `${CHECK}: ${live.map.size} captured bodies · HEAD: ${head.map.size}`
);

const collisions = [...live.collisions, ...head.collisions];
if (collisions.length)
  setupError(
    CHECK,
    `${collisions.length} body basename(s) are not unique, so bodies cannot be paired:\n` +
      collisions.map(c => `  ${c}`).join('\n')
  );

// Guarded ahead of the extraction, not only for the outcome: `git ls-tree` reports a path absent from
// HEAD as empty output and exit 0, where `git archive` reports it as a fatal pathspec error.
if (head.map.size === 0)
  finish({
    check: CHECK,
    assertedCount: 0,
    assertedUnit: 'captured bodies compared against HEAD',
    vacuousReason:
      `HEAD carries no captured body under ${FIXTURES_RELATIVE}, so nothing could be compared.\n` +
      '  Normal while a corpus is being built or restructured and not yet committed; permanent only\n' +
      '  if this repo commits no captured body at all, in which case drop the check from CHECKS.',
  });

// Extracted whole rather than file by file, so a body's relative imports still resolve when the
// host's readBody imports it as a module.
const headDir = mkdtempSync(path.join(tmpdir(), 'hp-fixtures-head-'));
process.on('exit', () => rmSync(headDir, { recursive: true, force: true }));
try {
  const tarball = path.join(headDir, 'head-corpus.tar');
  execFileSync(
    'git',
    ['archive', '--format=tar', '-o', tarball, 'HEAD', '--', FIXTURES_RELATIVE],
    { cwd: REPO_ROOT, stdio: ['ignore', 'ignore', 'pipe'] }
  );
  execFileSync('tar', ['-x', '-f', tarball, '-C', headDir], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
} catch (err) {
  setupError(
    CHECK,
    `could not extract the HEAD corpus — ${String(err.stderr ?? err).slice(0, 300)}`
  );
}

const altered = [];
const removed = [];
const added = [];
let compared = 0;

for (const [basename, before] of head.map) {
  const now = live.map.get(basename);
  if (!now) {
    removed.push(before);
    continue;
  }
  let wasValue;
  let isValue;
  try {
    wasValue = await readBody(path.join(headDir, before.relative));
    isValue = await readBody(absolute(now.relative));
  } catch (err) {
    setupError(CHECK, `could not read ${basename} — ${err.message}`);
  }
  // `undefined` on both sides deep-equals, so an edited body would compare clean and still be
  // counted — a green PASS over a non-zero count, which the uniform vacuity rule cannot see, because
  // the count is of comparisons attempted rather than of values read.
  if (wasValue === undefined || isValue === undefined)
    setupError(
      CHECK,
      `this repo's readBody returned undefined for ${basename}, so there was no value to compare.\n` +
        '  A body module with no default export reads this way, on both sides at once — check what\n' +
        '  readBody takes off the module it imports.'
    );
  compared += 1;
  if (!deepEq(wasValue, isValue)) altered.push({ before, now });
}
for (const [basename, body] of live.map) {
  if (!head.map.has(basename)) added.push(body);
}

console.log(`  compared against HEAD: ${compared}`);
console.log(`  no longer present under ${CAPTURED_ORIGIN}/: ${removed.length}`);
console.log(`  new since HEAD: ${added.length}`);

// Reported, never adjudicated: nothing this check can see proves a new body was captured rather than
// written. That is `capture-provenance`'s question, and answering it needs the raw captures.
if (added.length) {
  console.log('\n  new bodies, not adjudicated here:');
  for (const b of added) console.log(`    ${b.relative}`);
}

finish({
  check: CHECK,
  assertedCount: compared,
  assertedUnit: 'captured bodies compared against HEAD',
  failures: [
    ...altered.map(a => `${a.now.relative}: value differs from HEAD`),
    ...removed.map(
      r => `${r.relative}: at HEAD, no longer under ${CAPTURED_ORIGIN}/`
    ),
  ],
  remediation:
    '  A captured body changes only by recapture. Restore it from HEAD, or re-run the capture so the\n' +
    '  new values arrive with the provenance that makes them a wire record.\n' +
    '  A removal already accepted elsewhere is named here once, then goes quiet after the commit.',
  pass: 'no captured body was altered or removed',
});
