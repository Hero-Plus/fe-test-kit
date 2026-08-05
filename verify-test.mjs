#!/usr/bin/env node
// Deliberately NOT in `verify.mjs`'s appended unit suites, and it must stay out: it spawns the
// runner, and the runner spawns every appended suite, so listing it there is an infinite recursion
// that presents as a hung machine rather than a failed test. `npm test` covers it instead. The
// runner's own depth guard turns that mistake into a clean exit 2 if anyone reintroduces it.
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { after, describe, test } from 'node:test';

import { ASSERTED, SETUP_ERROR, VACUOUS } from './lib/outcomes.mjs';
import { makeScratch, PATHS_MODULE } from './scratch-repo.mjs';

const { scratch, makeRepo, run } = makeScratch('verify');
after(() => rmSync(scratch, { recursive: true, force: true }));

const withChecks = (repo, checks) =>
  repo.write(
    'tools/paths.mjs',
    PATHS_MODULE.replace(
      /export const CHECKS = \[[\s\S]*?\];/,
      `export const CHECKS = ${checks};`
    )
  );

describe('the vacuity policy is the host’s to set', () => {
  test("onVacuous: 'warn' keeps the tag and stops it reddening the run", () => {
    const repo = makeRepo({ commitCorpus: false });
    withChecks(
      repo,
      `[{ name: 'verbatim', kit: 'checks/verbatim.mjs', onVacuous: 'warn' }]`
    );
    const outcome = run(repo, 'verify.mjs');
    assert.equal(outcome.status, ASSERTED);
    assert.match(outcome.stdout, /VACUOUS/);
    assert.match(outcome.stdout, /tolerated by onVacuous: warn/);
  });

  test('the same vacuity under the default policy reddens the run', () => {
    const repo = makeRepo({ commitCorpus: false });
    withChecks(repo, `[{ name: 'verbatim', kit: 'checks/verbatim.mjs' }]`);
    assert.equal(run(repo, 'verify.mjs').status, VACUOUS);
  });
});

describe('a check set the runner cannot run', () => {
  test('a host: file the repo named but does not carry is a setup error', () => {
    const repo = makeRepo();
    withChecks(repo, `[{ name: 'local', host: 'tools/checks/absent.mjs' }]`);
    const outcome = run(repo, 'verify.mjs');
    assert.equal(outcome.status, SETUP_ERROR);
    assert.match(outcome.stderr, /Host check file\(s\) not found/);
  });

  test('a malformed entry is refused by index, before anything runs', () => {
    const repo = makeRepo();
    withChecks(repo, `[{ kit: 'checks/no-pan.mjs' }]`);
    const outcome = run(repo, 'verify.mjs');
    assert.equal(outcome.status, SETUP_ERROR);
    assert.match(outcome.stderr, /CHECKS\[0\]/);
  });

  test('a name reserved for a unit suite is refused', () => {
    const repo = makeRepo();
    withChecks(repo, `[{ name: 'config-unit', kit: 'checks/no-pan.mjs' }]`);
    const outcome = run(repo, 'verify.mjs');
    assert.equal(outcome.status, SETUP_ERROR);
    assert.match(outcome.stderr, /reserves for its unit suites/);
  });

  test('a nested run is refused rather than recursing', () => {
    const repo = makeRepo();
    const outcome = run(repo, 'verify.mjs', [], {
      HP_FIXTURES_VERIFY_RUNNING: '1',
    });
    assert.equal(outcome.status, SETUP_ERROR);
    assert.match(outcome.stderr, /already running/);
  });
});

// The unit suites are appended to every host's list, so a total taken over all results is never
// zero: the "no check ran" guard that read one could not fire, and five green unit-suite PASS lines
// read as coverage of a corpus nothing looked at.
describe('a run that reaches no corpus check is refused', () => {
  test('an empty CHECKS is a setup error, not a green run of the unit suites', () => {
    const repo = makeRepo();
    withChecks(repo, '[]');
    const outcome = run(repo, 'verify.mjs');
    assert.equal(outcome.status, SETUP_ERROR);
    assert.match(outcome.stderr, /No corpus check ran/);
    assert.match(outcome.stderr, /CHECKS is empty/);
  });

  test('a declared check that is absent and not required is a setup error', () => {
    const repo = makeRepo();
    withChecks(repo, `[{ name: 'gone', kit: 'checks/not-shipped.mjs' }]`);
    const outcome = run(repo, 'verify.mjs');
    assert.equal(outcome.status, SETUP_ERROR);
    assert.match(outcome.stderr, /No corpus check ran/);
  });
});

describe('a host check keeps its own exit code', () => {
  for (const [outcome, code] of [
    ['passing', 0],
    ['failing', 1],
    ['erroring', 2],
  ])
    test(`a ${outcome} host check is read literally as ${code}`, () => {
      const repo = makeRepo();
      repo.write('tools/checks/local.mjs', `process.exit(${code});\n`);
      withChecks(repo, `[{ name: 'local', host: 'tools/checks/local.mjs' }]`);
      assert.equal(run(repo, 'verify.mjs').status, code);
    });
});
