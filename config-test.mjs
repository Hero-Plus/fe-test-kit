#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';

import {
  CONFIG_NAMES,
  CONFIG_VAR,
  HostConfigError,
  loadHostConfig,
} from './lib/host-config.mjs';

const scratch = mkdtempSync(path.join(tmpdir(), 'hp-fixtures-config-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

// Generated from CONFIG_NAMES rather than written out, so the fixture cannot drift from the list it
// is meant to satisfy and leave the assertion below passing against a stale pair.
const hostModule = (names, value = name => `'${name}'`) => {
  const file = path.join(scratch, `host-${names.length}-${Math.random()}.mjs`);
  writeFileSync(
    file,
    `${names.map(name => `export const ${name} = ${value(name)};`).join('\n')}\n`
  );
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
    for (const name of CONFIG_NAMES) assert.equal(config[name], name);
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

  test('missing names are listed, not silently undefined', async () => {
    const withoutTwo = CONFIG_NAMES.filter(
      name => name !== 'CELL_MANIFEST' && name !== 'REPO_ROOT'
    );
    process.env[CONFIG_VAR] = hostModule(withoutTwo);
    await assert.rejects(loadHostConfig(), err => {
      assert.ok(err instanceof HostConfigError);
      assert.match(err.message, /CELL_MANIFEST, REPO_ROOT/);
      return true;
    });
  });

  test('a name exported as undefined counts as missing', async () => {
    process.env[CONFIG_VAR] = hostModule([...CONFIG_NAMES], name =>
      name === 'FIXTURES_DIR' ? 'undefined' : `'${name}'`
    );
    await assert.rejects(loadHostConfig(), err => {
      assert.match(err.message, /FIXTURES_DIR/);
      return true;
    });
  });
});
