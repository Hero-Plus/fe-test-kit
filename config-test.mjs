#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';

import {
  CHECK_CONFIG_NAMES,
  CONFIG_NAMES,
  CONFIG_VAR,
  CORE_CONFIG_NAMES,
  HostConfigError,
  loadHostConfig,
  requiredNamesFor,
  validateChecks,
} from './lib/host-config.mjs';

const scratch = mkdtempSync(path.join(tmpdir(), 'hp-fixtures-config-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

const EVERY_CHECK = Object.keys(CHECK_CONFIG_NAMES).map(name => ({
  name,
  kit: `checks/${name}.mjs`,
}));

// Only the names carrying a shape are spelled out; the rest are their own name as a string, so the
// fixture cannot drift from the list it is meant to satisfy.
const SHAPED = {
  absolute: 'relative => relative',
  CORPUS_ROOT_FILES: '[]',
  CORPUS_ROOT_SUFFIXES: '[]',
  ORIGIN_RELATIVE: '[]',
  enumerateCells: 'async () => ({})',
  readBody: 'async () => ({})',
  listCaptures: 'async () => []',
  SCRIPTS: '{}',
  WIRE_CONVENTIONS: '{}',
};

const hostModule = (names, { checks = EVERY_CHECK, override = {} } = {}) => {
  const file = path.join(scratch, `host-${names.length}-${Math.random()}.mjs`);
  const source = names
    .map(name => {
      const value =
        override[name] ??
        (name === 'CHECKS'
          ? JSON.stringify(checks)
          : (SHAPED[name] ?? `'${name}'`));
      return `export const ${name} = ${value};`;
    })
    .join('\n');
  writeFileSync(file, `${source}\n`);
  return file;
};

// Set unconditionally, never defaulted: `verify.mjs` runs this file with the host's own value
// already in the environment, and a test that inherited it would assert against that repo instead.
process.env[CONFIG_VAR] = hostModule([...CONFIG_NAMES]);
const config = await import('./config.mjs');

describe('the config contract', () => {
  test('config.mjs re-exports exactly the names it validates', () => {
    assert.deepEqual(
      Object.keys(config).sort(),
      [...CONFIG_NAMES].sort(),
      'CONFIG_NAMES and the re-export lines in config.mjs have drifted apart'
    );
  });

  test('every re-exported name carries the host value', () => {
    for (const name of CONFIG_NAMES.filter(n => !(n in SHAPED)))
      if (name !== 'CHECKS') assert.equal(config[name], name);
    assert.equal(typeof config.absolute, 'function');
    assert.equal(config.CHECKS.length, EVERY_CHECK.length);
  });

  test('every per-check name is reachable from CONFIG_NAMES', () => {
    for (const names of Object.values(CHECK_CONFIG_NAMES))
      for (const name of names) assert.ok(CONFIG_NAMES.includes(name));
  });
});

describe('per-check requirements', () => {
  test('a two-check host boots without the other checks’ names', async () => {
    const checks = [
      { name: 'no-pan', kit: 'checks/no-pan.mjs', required: true },
      { name: 'origin-set', kit: 'checks/origin-set.mjs' },
    ];
    const needed = requiredNamesFor(checks);
    process.env[CONFIG_VAR] = hostModule(needed, { checks });

    const host = await loadHostConfig();

    assert.equal(host.PAN_ALLOWLIST, 'PAN_ALLOWLIST');
    for (const absent of [
      'CELL_MANIFEST',
      'TRANSACTION_TABLES',
      'enumerateCells',
      'readBody',
      'listCaptures',
    ])
      assert.equal(host[absent], undefined);
  });

  test('a name the enabled checks read is listed when missing', async () => {
    const checks = [{ name: 'cell-map', kit: 'checks/cell-map.mjs' }];
    const needed = requiredNamesFor(checks).filter(
      name => name !== 'CELL_MANIFEST'
    );
    process.env[CONFIG_VAR] = hostModule(needed, { checks });

    await assert.rejects(loadHostConfig(), err => {
      assert.ok(err instanceof HostConfigError);
      assert.match(err.message, /CELL_MANIFEST/);
      return true;
    });
  });

  test('a name no enabled check reads is not required', () => {
    assert.ok(!requiredNamesFor([]).includes('CELL_MANIFEST'));
    assert.deepEqual(requiredNamesFor([]), [...CORE_CONFIG_NAMES].sort());
  });

  test('requirements key off the kit file, not the host’s name for it', () => {
    const renamed = [{ name: 'pan', kit: 'checks/no-pan.mjs' }];
    assert.ok(requiredNamesFor(renamed).includes('PAN_ALLOWLIST'));
  });

  test('a host: entry pulls in no kit config names', () => {
    const hostOwned = [{ name: 'no-pan', host: 'tools/checks/no-pan.mjs' }];
    assert.deepEqual(requiredNamesFor(hostOwned), [...CORE_CONFIG_NAMES].sort());
  });

  for (const name of ['SCRIPTS', 'WIRE_CONVENTIONS'])
    test(`${name} is optional`, async () => {
      const checks = [{ name: 'no-pan', kit: 'checks/no-pan.mjs' }];
      const needed = requiredNamesFor(checks);
      assert.ok(!needed.includes(name));
      process.env[CONFIG_VAR] = hostModule(needed, { checks });
      const host = await loadHostConfig();
      assert.equal(host[name], undefined);
    });
});

describe('a wrong-shaped export', () => {
  for (const [name, wrong] of [
    ['absolute', `'not-a-function'`],
    ['enumerateCells', `'not-a-function'`],
    ['readBody', '42'],
    ['listCaptures', 'null'],
    ['ORIGIN_RELATIVE', `'a-string-not-an-array'`],
    ['CORPUS_ROOT_FILES', '[1, 2]'],
    ['SCRIPTS', '[]'],
    ['WIRE_CONVENTIONS', 'null'],
  ])
    test(`${name} is refused, not deferred to a TypeError mid-check`, async () => {
      process.env[CONFIG_VAR] = hostModule([...CONFIG_NAMES], {
        override: { [name]: wrong },
      });
      await assert.rejects(loadHostConfig(), err => {
        assert.ok(err instanceof HostConfigError);
        assert.match(err.message, new RegExp(name));
        return true;
      });
    });

  test('CHECKS that is not an array names itself', async () => {
    process.env[CONFIG_VAR] = hostModule([...CONFIG_NAMES], {
      override: { CHECKS: `'no-pan'` },
    });
    await assert.rejects(loadHostConfig(), err => {
      assert.match(err.message, /CHECKS/);
      return true;
    });
  });
});

describe('a malformed CHECKS entry', () => {
  for (const [why, entry] of [
    ['no name', { kit: 'checks/no-pan.mjs' }],
    ['neither kit nor host', { name: 'x' }],
    ['both kit and host', { name: 'x', kit: 'a.mjs', host: 'b.mjs' }],
    ['an unknown onVacuous', { name: 'x', kit: 'a.mjs', onVacuous: 'ignore' }],
    ['a non-boolean required', { name: 'x', kit: 'a.mjs', required: 'yes' }],
    ['not an object', 'checks/no-pan.mjs'],
  ])
    test(`${why} is reported by index`, () => {
      const problems = validateChecks([entry]);
      assert.equal(problems.length, 1);
      assert.match(problems[0], /^CHECKS\[0\]/);
    });

  test('a duplicate name is reported', () => {
    const problems = validateChecks([
      { name: 'x', kit: 'a.mjs' },
      { name: 'x', kit: 'b.mjs' },
    ]);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /already used/);
  });

  // A host check never reports `vacuous`, and an absent host file already fails the run outright, so
  // either knob declared on one is a decision that does nothing — refused rather than silently ignored.
  for (const [knob, entry, expected] of [
    [
      'onVacuous',
      { name: 'x', host: 'tools/x.mjs', onVacuous: 'warn' },
      /`onVacuous` has no effect on a `host:` check/,
    ],
    [
      'required',
      { name: 'x', host: 'tools/x.mjs', required: true },
      /`required` has no effect on a `host:` check/,
    ],
  ])
    test(`${knob} on a host: entry is refused`, () => {
      const problems = validateChecks([entry]);
      assert.equal(problems.length, 1);
      assert.match(problems[0], expected);
    });

  // One problem per mistake: a `host:` entry whose `required` is also wrong-typed must not report both
  // the type and the inertness, or the table above stops being able to pin either.
  test('a wrong-typed required on a host: entry reports only the type', () => {
    const problems = validateChecks([
      { name: 'x', host: 'tools/x.mjs', required: 'yes' },
    ]);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /must be true or false/);
  });

  test('a well-formed pair is accepted', () => {
    assert.deepEqual(
      validateChecks([
        { name: 'no-pan', kit: 'checks/no-pan.mjs', required: true },
        { name: 'local', host: 'tools/fixtures/checks/local.mjs' },
      ]),
      []
    );
  });
});

describe('an unusable host config', () => {
  test('unset names the variable', async () => {
    delete process.env[CONFIG_VAR];
    await assert.rejects(loadHostConfig(), err => {
      assert.ok(err instanceof HostConfigError);
      assert.match(err.message, new RegExp(`${CONFIG_VAR} is not set`));
      return true;
    });
  });

  test('unresolvable names the path it resolved', async () => {
    process.env[CONFIG_VAR] = path.join(scratch, 'no-such-config.mjs');
    await assert.rejects(loadHostConfig(), err => {
      assert.ok(err instanceof HostConfigError);
      assert.match(err.message, /no-such-config\.mjs/);
      return true;
    });
  });

  test('a relative spec resolves against cwd rather than this package', async () => {
    process.env[CONFIG_VAR] = path.relative(
      process.cwd(),
      hostModule([...CONFIG_NAMES])
    );
    const host = await loadHostConfig();
    assert.equal(host.REPO_ROOT, 'REPO_ROOT');
  });

  test('missing core names are listed, not silently undefined', async () => {
    const withoutTwo = CONFIG_NAMES.filter(
      name => name !== 'FIXTURES_DIR' && name !== 'REPO_ROOT'
    );
    process.env[CONFIG_VAR] = hostModule(withoutTwo);
    await assert.rejects(loadHostConfig(), err => {
      assert.ok(err instanceof HostConfigError);
      assert.match(err.message, /FIXTURES_DIR, REPO_ROOT/);
      return true;
    });
  });

  test('a name exported as undefined counts as missing', async () => {
    process.env[CONFIG_VAR] = hostModule([...CONFIG_NAMES], {
      override: { FIXTURES_DIR: 'undefined' },
    });
    await assert.rejects(loadHostConfig(), err => {
      assert.match(err.message, /FIXTURES_DIR/);
      return true;
    });
  });
});
