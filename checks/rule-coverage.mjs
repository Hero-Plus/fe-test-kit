#!/usr/bin/env node
// checks/rule-coverage.mjs — `conforms` is a claim about production code, and uncited
// it rests on a reading someone did once that nothing re-checks. The sibling checks cannot see it:
// they walk fixture bodies.
//
// Invokes no git, so unlike `verbatim` and `origin-set` it still asserts in CI, where the working
// tree IS HEAD and a HEAD comparison passes unconditionally.
//
// Titles, never file text: three rules' notes say they are deliberately not test-asserted, and each
// is also named in a comment inside a test file.
//
// The spec file is this repo's adjudicated subset, not the whole normative spec — the tables it
// pins by hash live in the transaction-tables plugin, absent from this checkout and from CI. So a
// cited id the spec file does not carry is undecidable here: a real rule nobody adjudicated and a
// mistyped one look identical. That is why the two citation classes below report and never fail.
//
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { finish, setupError } from '../lib/outcomes.mjs';
import {
  absolute,
  REPO_ROOT,
  RULE_EXEMPTIONS_RELATIVE,
  TRANSACTION_TABLES,
  TRANSACTION_TABLES_RELATIVE,
} from '../config.mjs';

const CHECK = 'rule-coverage';
const EXEMPTIONS = absolute(RULE_EXEMPTIONS_RELATIVE);

if (!existsSync(TRANSACTION_TABLES))
  finish({
    check: CHECK,
    assertedCount: 0,
    assertedUnit: 'conformance claims backed',
    vacuousReason:
      `this repo has no ${TRANSACTION_TABLES_RELATIVE}.\n` +
      '  Nothing here declares which spec rules the repo claims to conform to, so there was no claim\n' +
      '  to back. Either point HP_FIXTURES_CONFIG at a repo that carries the file, or drop this check\n' +
      '  from CHECKS so the removal is a decision with a diff.',
  });

let spec;
try {
  spec = JSON.parse(readFileSync(TRANSACTION_TABLES, 'utf8'));
} catch (err) {
  setupError(
    CHECK,
    `${TRANSACTION_TABLES_RELATIVE} is not valid JSON — ${err.message}`
  );
}

if (!spec.rules || typeof spec.rules !== 'object')
  setupError(
    CHECK,
    `${TRANSACTION_TABLES_RELATIVE} carries no \`rules\` object.`
  );

const conforms = Object.keys(spec.rules)
  .filter(id => spec.rules[id]?.state === 'conforms')
  .sort();

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', 'out']);
const TEST_FILE_RE = /\.test\.(?:[cm]?[jt]sx?)$/;

const testFiles = [];
const collectTestFiles = dir => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.'))
        collectTestFiles(path.join(dir, entry.name));
    } else if (TEST_FILE_RE.test(entry.name)) {
      testFiles.push(path.join(dir, entry.name));
    }
  }
};
collectTestFiles(REPO_ROOT);

const TITLE_RE =
  /\b(?:it|test|describe)((?:\.[A-Za-z]+)*)\s*\(\s*(['"`])((?:\\.|(?!\2)[\s\S])*?)\2/g;
// `[LIST-3..8]` cites a span; unexpanded, its six interior rules read as unbacked while a test does
// assert them.
const CITATION_RE = /\[([A-Z][A-Z-]*)-(\d+)(?:\.\.(\d+))?\]/g;
// A `test.failing` pins behaviour as NOT working, and a skipped one asserts nothing at all, so a
// conformance claim citing only those would report itself backed by a test that contradicts it.
const INERT_MODIFIERS = new Set(['failing', 'skip', 'todo']);

const citedBy = new Map();
const namedAlone = new Set();
const sweptByRange = new Set();
let titles = 0;
let inertTitles = 0;
for (const file of testFiles) {
  const relative = path.relative(REPO_ROOT, file);
  let source;
  try {
    source = readFileSync(file, 'utf8');
  } catch (err) {
    setupError(CHECK, `could not read ${relative} — ${err.message}`);
  }
  for (const title of source.matchAll(TITLE_RE)) {
    titles += 1;
    if (title[1].split('.').some(modifier => INERT_MODIFIERS.has(modifier))) {
      inertTitles += 1;
      continue;
    }
    for (const [, prefix, first, last] of title[3].matchAll(CITATION_RE)) {
      const from = Number(first);
      const to = last === undefined ? from : Number(last);
      for (let n = from; n <= to; n += 1) {
        const id = `${prefix}-${n}`;
        if (!citedBy.has(id)) citedBy.set(id, new Set());
        citedBy.get(id).add(relative);
        if (last === undefined) namedAlone.add(id);
        else sweptByRange.add(id);
      }
    }
  }
}

console.log(
  `${CHECK}: ${Object.keys(spec.rules).length} rules · ${conforms.length} marked conforms · ${testFiles.length} test files · ${titles} titles` +
    (inertTitles ? ` (${inertTitles} failing/skipped, cited nothing)` : '')
);

// Tests this check stopped being able to parse would otherwise report every rule as unbacked, which
// reads as a conformance problem rather than as the parser breaking.
if (testFiles.length === 0 || titles === 0)
  setupError(
    CHECK,
    `parsed ${titles} test titles from ${testFiles.length} test files.`
  );

let exempt = {};
if (existsSync(EXEMPTIONS)) {
  try {
    exempt = JSON.parse(readFileSync(EXEMPTIONS, 'utf8')).exempt ?? {};
  } catch (err) {
    setupError(
      CHECK,
      `${RULE_EXEMPTIONS_RELATIVE} is not valid JSON — ${err.message}`
    );
  }
}

const failures = [];

for (const id of conforms) {
  if (citedBy.has(id) || id in exempt) continue;
  failures.push(
    `${id}: marked conforms, but no test title cites it and it is not exempt`
  );
}

for (const id of Object.keys(exempt).sort()) {
  const state = spec.rules[id]?.state;
  if (state === undefined)
    failures.push(`exempt ${id}: no rule by that id in the spec`);
  else if (state !== 'conforms')
    failures.push(
      `exempt ${id}: state is '${state}' — an exemption stands in for a missing test, which only a conformance claim needs`
    );
  else if (citedBy.has(id))
    failures.push(
      `exempt ${id}: now cited by ${[...citedBy.get(id)].sort().join(', ')} — drop the exemption`
    );
}

const cited = conforms.filter(id => citedBy.has(id));
const outsideSpec = [...citedBy.keys()]
  .filter(id => spec.rules[id] === undefined)
  .sort();
const citedNonConforming = [...citedBy.keys()]
  .filter(
    id => spec.rules[id] !== undefined && spec.rules[id].state !== 'conforms'
  )
  .sort();

console.log(
  `  ${cited.length} of ${conforms.length} rules the spec file marks conforms are cited by a test title`
);
// That fraction iterates rules, so a citation resolving to nothing in the spec file cannot lower it
// — the direction this check was blind to, and the larger share of the gap between what the suite
// asserts and what the spec file adjudicates.
const outsideCount = outsideSpec.length + citedNonConforming.length;
if (outsideCount) {
  console.log(
    `  It measures the spec file, not the suite: of the ${citedBy.size} rule ids live titles cite, ` +
      `${outsideCount} ${outsideCount === 1 ? 'sits' : 'sit'} outside that denominator, uncounted above.`
  );
}

if (outsideSpec.length) {
  console.log(
    `\n  ${outsideSpec.length} cited id(s) absent from ${TRANSACTION_TABLES_RELATIVE} — unadjudicated rule or typo is not decidable here; resolve against the transaction-tables tables:`
  );
  for (const id of outsideSpec)
    console.log(`    ${id} — ${[...citedBy.get(id)].sort().join(', ')}`);
}

if (citedNonConforming.length) {
  console.log(
    `\n  ${citedNonConforming.length} cited id(s) the spec file marks as not conforming here:`
  );
  for (const id of citedNonConforming) {
    const span = sweptByRange.has(id)
      ? `, ${namedAlone.has(id) ? 'also' : 'only ever'} swept in by a range citation`
      : '';
    console.log(
      `    ${id} (${spec.rules[id].state})${span} — ${[...citedBy.get(id)].sort().join(', ')}`
    );
  }
  console.log(
    `    Legitimate when the title is a guard or characterisation pin for the gap itself, false when it\n` +
      `    asserts the rule holds — which of the two a title is doing is not readable from its text. Each\n` +
      `    leaves this block the moment its state flips to conforms, and then counts as coverage unread.`
  );
}

// Printed on a pass too: these are the conformance claims a green run does not stand behind.
if (Object.keys(exempt).length) {
  console.log(
    `\n  ${Object.keys(exempt).length} rule(s) exempt in ${RULE_EXEMPTIONS_RELATIVE} — asserted by reading source, not by a test:`
  );
  for (const id of Object.keys(exempt).sort())
    console.log(`    ${id} — ${exempt[id]}`);
}

finish({
  check: CHECK,
  assertedCount: conforms.length,
  assertedUnit: 'conformance claims backed',
  failures,
  remediation:
    `  Either cite the rule from a test title — \`it('[RULE-ID] …')\`, or \`[RULE-3..8]\` for a span —\n` +
    `  or, if it genuinely cannot be tested here, record it with its reason in ${RULE_EXEMPTIONS_RELATIVE}.\n` +
    `  Downgrading the rule's state in ${TRANSACTION_TABLES_RELATIVE} is the third honest option.`,
  vacuousReason: `${TRANSACTION_TABLES_RELATIVE} marks no rule as conforming, so there was no claim to back.`,
  pass: 'every conforming rule is cited by a test or exempt with a recorded reason',
});
