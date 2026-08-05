#!/usr/bin/env node
// Named `-test` rather than `.test`: jest 30's default testMatch claims `*.test.mjs`, and jest
// cannot execute node:test.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { after, describe, test } from 'node:test';

import { ASSERTED, FAILED, SETUP_ERROR, VACUOUS } from './lib/outcomes.mjs';
import { FIXTURES_RELATIVE, makeScratch, PATHS_MODULE } from './scratch-repo.mjs';

const { scratch, makeRepo, run: runCheck } = makeScratch('outcomes');
after(() => rmSync(scratch, { recursive: true, force: true }));

// A `.replace` that matched nothing would leave the test running the unmodified config against a
// check that never misbehaved — a green test proving nothing, which is the shape this suite exists
// to catch elsewhere.
const rewriteConfig = (repo, pattern, replacement) => {
  const next = PATHS_MODULE.replace(pattern, replacement);
  assert.notEqual(next, PATHS_MODULE, 'the scratch config rewrite matched nothing');
  repo.write('tools/paths.mjs', next);
};

const NO_VALUE_READ_BODY = [
  /export const readBody = [\s\S]*?;\n/,
  'export const readBody = async () => undefined;\n',
];

describe('a check that asserted nothing is vacuous, whatever branch it took', () => {
  // The bug the vocabulary exists for: with no captured body at HEAD the comparison loop never runs,
  // every live body lands in `added`, and v0.1.3 printed a green PASS having compared nothing.
  test('verbatim over an empty HEAD is vacuous, not a green PASS', () => {
    const repo = makeRepo({ commitCorpus: false });
    const run = runCheck(repo, 'checks/verbatim.mjs');
    assert.equal(run.status, VACUOUS);
    assert.match(run.stderr, /VACUOUS/);
    assert.match(run.stdout, /asserted 0 captured bodies/);
  });

  test('origin-set with nothing at HEAD to compare is vacuous', () => {
    const repo = makeRepo({ commitCorpus: false });
    assert.equal(runCheck(repo, 'checks/origin-set.mjs').status, VACUOUS);
  });

  test('capture-provenance with no capture on disk is vacuous', () => {
    const repo = makeRepo({ commitCorpus: false });
    assert.equal(
      runCheck(repo, 'checks/capture-provenance.mjs').status,
      VACUOUS
    );
  });

  test('capture-provenance with nothing new against HEAD is vacuous', () => {
    const repo = makeRepo();
    repo.write(
      'tools/captures/one.json',
      JSON.stringify({ id: 'purchase-alpha', total: 100 })
    );
    assert.equal(
      runCheck(repo, 'checks/capture-provenance.mjs').status,
      VACUOUS
    );
  });

  test('cell-map with no committed manifest is vacuous', () => {
    const repo = makeRepo();
    assert.equal(runCheck(repo, 'checks/cell-map.mjs').status, VACUOUS);
  });

  test('rule-coverage with no rule spec is vacuous', () => {
    const repo = makeRepo();
    assert.equal(runCheck(repo, 'checks/rule-coverage.mjs').status, VACUOUS);
  });

  test('no-pan over an absent corpus root is vacuous', () => {
    const repo = makeRepo({ withCorpus: false });
    assert.equal(runCheck(repo, 'checks/no-pan.mjs').status, VACUOUS);
  });

  // The same two states through `origin-set`, which judged them per-branch as exit 2 — the one
  // outcome `onVacuous` cannot soften. A repo adopting both checks before its corpus lands had no
  // way to say that the emptiness is normal, while `no-pan` above let it.
  test('origin-set over an absent corpus root is vacuous', () => {
    const repo = makeRepo({ withCorpus: false });
    assert.equal(runCheck(repo, 'checks/origin-set.mjs').status, VACUOUS);
  });

  test('origin-set over a corpus root holding no body is vacuous', () => {
    const repo = makeRepo({ commitCorpus: false });
    rmSync(path.join(repo.root, FIXTURES_RELATIVE, 'captured/alpha.json'));
    assert.equal(runCheck(repo, 'checks/origin-set.mjs').status, VACUOUS);
  });
});

describe('a check with something to compare asserts', () => {
  test('verbatim over a committed corpus passes and says what it compared', () => {
    const repo = makeRepo();
    const run = runCheck(repo, 'checks/verbatim.mjs');
    assert.equal(run.status, ASSERTED);
    assert.match(run.stdout, /asserted 1 captured bodies/);
  });

  test('origin-set over a committed corpus passes', () => {
    const repo = makeRepo();
    assert.equal(runCheck(repo, 'checks/origin-set.mjs').status, ASSERTED);
  });

  test('cell-map --write generates and exits 0, then the check asserts', () => {
    const repo = makeRepo();
    assert.equal(
      runCheck(repo, 'checks/cell-map.mjs', ['--write']).status,
      ASSERTED
    );
    const run = runCheck(repo, 'checks/cell-map.mjs');
    assert.equal(run.status, ASSERTED);
    assert.match(run.stdout, /asserted 1 pinned bodies/);
  });

  test('capture-provenance matches a fresh promotion to its capture', () => {
    const repo = makeRepo({ commitCorpus: false });
    repo.write(
      'tools/captures/one.json',
      JSON.stringify({ id: 'purchase-alpha', total: 100 })
    );
    assert.equal(
      runCheck(repo, 'checks/capture-provenance.mjs').status,
      ASSERTED
    );
  });
});

describe('a check with something to object to fails', () => {
  test('verbatim catches an edited captured body', () => {
    const repo = makeRepo();
    repo.write(
      `${FIXTURES_RELATIVE}/captured/alpha.json`,
      `${JSON.stringify({ id: 'purchase-alpha', total: 999 }, null, 2)}\n`
    );
    const run = runCheck(repo, 'checks/verbatim.mjs');
    assert.equal(run.status, FAILED);
    assert.match(run.stderr, /value differs from HEAD/);
  });

  test('verbatim ignores a reflow that changes no value', () => {
    const repo = makeRepo();
    repo.write(
      `${FIXTURES_RELATIVE}/captured/alpha.json`,
      JSON.stringify({ total: 100, id: 'purchase-alpha' })
    );
    assert.equal(runCheck(repo, 'checks/verbatim.mjs').status, ASSERTED);
  });

  test('origin-set catches a body moved between buckets', () => {
    const repo = makeRepo();
    mkdirSync(path.join(repo.root, FIXTURES_RELATIVE, 'authored'), {
      recursive: true,
    });
    renameSync(
      path.join(repo.root, FIXTURES_RELATIVE, 'captured/alpha.json'),
      path.join(repo.root, FIXTURES_RELATIVE, 'authored/alpha.json')
    );
    const run = runCheck(repo, 'checks/origin-set.mjs');
    assert.equal(run.status, FAILED);
    assert.match(run.stderr, /captured → authored/);
  });

  test('cell-map catches a dropped manifest entry', () => {
    const repo = makeRepo();
    runCheck(repo, 'checks/cell-map.mjs', ['--write']);
    repo.write(
      'tools/cell-manifest.json',
      JSON.stringify({ counts: {}, ragged: [], cells: {}, aux: {} })
    );
    assert.equal(runCheck(repo, 'checks/cell-map.mjs').status, FAILED);
  });

  test('capture-provenance catches a body matching no capture', () => {
    const repo = makeRepo({ commitCorpus: false });
    repo.write(
      'tools/captures/one.json',
      JSON.stringify({ id: 'purchase-beta', total: 7 })
    );
    const run = runCheck(repo, 'checks/capture-provenance.mjs');
    assert.equal(run.status, FAILED);
    assert.match(run.stderr, /matches no capture on disk/);
  });

  test('no-pan catches a card-number shape', () => {
    const repo = makeRepo();
    repo.write(
      `${FIXTURES_RELATIVE}/captured/beta.json`,
      JSON.stringify({ note: '4111111111111111' })
    );
    assert.equal(runCheck(repo, 'checks/no-pan.mjs').status, FAILED);
  });

  // Both halves of the identity-resolution rule: one wrapper call around a registry value drops
  // exactly one body, and a printed note would let the next `--write` mint a manifest one short.
  test('cell-map fails on a body no registry entry names', () => {
    const repo = makeRepo();
    runCheck(repo, 'checks/cell-map.mjs', ['--write']);
    const run = runCheck(repo, 'checks/cell-map.mjs', [], {
      HP_TEST_DROP: 'alpha',
    });
    assert.equal(run.status, FAILED);
    assert.match(run.stderr, /no cell and no aux entry names this body/);
  });

  test('cell-map fails on a cell value that resolved to no file', () => {
    const repo = makeRepo();
    const run = runCheck(repo, 'checks/cell-map.mjs', [], {
      HP_TEST_UNRESOLVED: 'alpha',
    });
    assert.equal(run.status, FAILED);
    assert.match(run.stderr, /resolved to no file/);
  });

  test('an unresolvable cell blocks --write from minting a manifest', () => {
    const repo = makeRepo();
    const run = runCheck(repo, 'checks/cell-map.mjs', ['--write'], {
      HP_TEST_UNRESOLVED: 'alpha',
    });
    assert.equal(run.status, FAILED);
    assert.equal(runCheck(repo, 'checks/cell-map.mjs').status, VACUOUS);
  });

  test('an orphaned body blocks --write from minting a manifest', () => {
    const repo = makeRepo();
    const run = runCheck(repo, 'checks/cell-map.mjs', ['--write'], {
      HP_TEST_DROP: 'alpha',
    });
    assert.equal(run.status, FAILED);
    assert.equal(existsSync(path.join(repo.root, 'tools/cell-manifest.json')), false);
  });

  // The corpus-root allowlist reads only the filesystem, so it holds when there is nothing to
  // compare. Softening the empty corpus to vacuous would otherwise hide a stray root file from any
  // host that set `onVacuous: 'warn'`.
  test('an unlisted corpus-root file fails even with no body to compare', () => {
    const repo = makeRepo({ commitCorpus: false });
    rmSync(path.join(repo.root, FIXTURES_RELATIVE, 'captured/alpha.json'));
    repo.write(`${FIXTURES_RELATIVE}/stray.txt`, 'x\n');
    const run = runCheck(repo, 'checks/origin-set.mjs');
    assert.equal(run.status, FAILED);
    assert.match(run.stderr, /unlisted file at the corpus root/);
  });

  test('two captured bodies sharing a basename stop capture-provenance', () => {
    const repo = makeRepo();
    repo.write(
      `${FIXTURES_RELATIVE}/captured/nested/alpha.json`,
      JSON.stringify({ id: 'purchase-alpha', total: 100 })
    );
    const run = runCheck(repo, 'checks/capture-provenance.mjs');
    assert.equal(run.status, SETUP_ERROR);
    assert.match(run.stderr, /basename\(s\) are not unique/);
  });
});

// `assertedCount` counts comparisons attempted, not values read, so a host reading that yields no
// value is invisible to the uniform vacuity rule: `undefined` deep-equals `undefined`, every
// comparison passes, and the count is non-zero. `(await import(url)).default` over a corpus of named
// exports reads exactly this way, on both sides at once.
describe('a host reading that yields no value is a setup error, not a comparison', () => {
  test('verbatim refuses a readBody returning undefined, over an edited body', () => {
    const repo = makeRepo();
    rewriteConfig(repo, ...NO_VALUE_READ_BODY);
    repo.write(
      `${FIXTURES_RELATIVE}/captured/alpha.json`,
      `${JSON.stringify({ id: 'purchase-alpha', total: 999999 }, null, 2)}\n`
    );
    const run = runCheck(repo, 'checks/verbatim.mjs');
    assert.equal(run.status, SETUP_ERROR);
    assert.match(run.stderr, /readBody returned undefined/);
  });

  test('capture-provenance refuses a readBody returning undefined', () => {
    const repo = makeRepo({ commitCorpus: false });
    rewriteConfig(repo, ...NO_VALUE_READ_BODY);
    repo.write(
      'tools/captures/one.json',
      JSON.stringify({ id: 'purchase-alpha', total: 100 })
    );
    const run = runCheck(repo, 'checks/capture-provenance.mjs');
    assert.equal(run.status, SETUP_ERROR);
    assert.match(run.stderr, /readBody returned undefined/);
  });
});
