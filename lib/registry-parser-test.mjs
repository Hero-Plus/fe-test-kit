#!/usr/bin/env node
// Named `-test` rather than `.test`: jest 30's default testMatch claims `*.test.mjs`, and jest
// cannot execute node:test.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';

import { makeRegistryParser } from './registry-parser.mjs';

const scratch = mkdtempSync(path.join(tmpdir(), 'hp-fixtures-parser-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

const FIXTURES_RELATIVE = 'src/test/fixtures';
const LIST_PAGE_RELATIVE = `${FIXTURES_RELATIVE}/captured/list-page`;

const REGISTRY = [
  "import first from './captured/detail/first.json';",
  "import page from './captured/list-page/page-one.json';",
  "import lonely from './captured/detail/lonely.json';",
  "import users from './captured/support/users.json';",
  '',
  'export const cells = {',
  "  'first-sale': railed(first),",
  "  'no-list-row': railed(lonely),",
  '};',
  '',
  'export const pages = {',
  "  'page-one': page,",
  '};',
  '',
  'export const aux = {',
  '  merchantUsers: deepFreeze(users),',
  '};',
].join('\n');

const repoFor = source => {
  const root = path.join(scratch, `repo-${Math.random()}`);
  const write = (relative, contents) => {
    const full = path.join(root, relative);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, contents);
  };
  write(`${FIXTURES_RELATIVE}/corpus.ts`, source);
  write(
    `${FIXTURES_RELATIVE}/captured/detail/first.json`,
    JSON.stringify({ id: 'purchase-1' })
  );
  write(
    `${FIXTURES_RELATIVE}/captured/detail/lonely.json`,
    JSON.stringify({ id: 'purchase-2' })
  );
  write(
    `${FIXTURES_RELATIVE}/captured/list-page/page-one.json`,
    JSON.stringify({ purchases: [{ id: 'purchase-1' }] })
  );
  write(`${FIXTURES_RELATIVE}/captured/support/users.json`, JSON.stringify({}));
  return relative => path.join(root, relative);
};

const parserFor = (source, quotes) =>
  makeRegistryParser({
    absolute: repoFor(source),
    fixturesRelative: FIXTURES_RELATIVE,
    registryRelative: `${FIXTURES_RELATIVE}/corpus.ts`,
    quotes,
    listPageRelative: LIST_PAGE_RELATIVE,
    listRowsKey: 'purchases',
  });

const doubled = REGISTRY.replaceAll("'", '"');

describe('quote style is a parameter, not a condition of adoption', () => {
  for (const [style, source, quotes] of [
    ['single-quoted source', REGISTRY, 'single'],
    ['double-quoted source', doubled, 'double'],
    ['single under the permissive default', REGISTRY, 'both'],
    ['double under the permissive default', doubled, 'both'],
  ])
    test(`${style} resolves the same corpus`, () => {
      const result = parserFor(source, quotes)();

      assert.deepEqual(result.scenarios, ['first-sale', 'no-list-row']);
      assert.deepEqual(result.views, ['detail', 'list']);
      assert.equal(result.cells.length, 3);
      assert.deepEqual(result.cells[0], {
        scenario: 'first-sale',
        view: 'detail',
        source: `${FIXTURES_RELATIVE}/captured/detail/first.json`,
        id: 'purchase-1',
      });
      assert.deepEqual(result.cells[1], {
        scenario: 'first-sale',
        view: 'list',
        source: `${LIST_PAGE_RELATIVE}/page-one.json`,
        id: 'purchase-1',
      });
      assert.deepEqual(result.ragged, ['no-list-row']);
      assert.deepEqual(result.aux, [
        {
          name: 'merchantUsers',
          source: `${FIXTURES_RELATIVE}/captured/support/users.json`,
          id: null,
        },
      ]);
    });

  // The blocker this parameter exists for: the mismatch resolved zero cells and reported nothing,
  // because an unresolved import is indistinguishable from a registry that names no body.
  test('a quote style the parser is not told about resolves nothing', () => {
    assert.deepEqual(parserFor(doubled, 'single')().cells, []);
  });
});

describe('construct names are a parameter', () => {
  test('a registry using its own wrappers resolves', () => {
    const source = REGISTRY.replace(/railed\(/g, 'wired(').replace(
      /deepFreeze\(/g,
      'frozen('
    );
    const result = makeRegistryParser({
      absolute: repoFor(source),
      fixturesRelative: FIXTURES_RELATIVE,
      registryRelative: `${FIXTURES_RELATIVE}/corpus.ts`,
      detailConstruct: 'wired',
      auxConstruct: 'frozen',
      listPageRelative: LIST_PAGE_RELATIVE,
      listRowsKey: 'purchases',
    })();

    assert.equal(result.cells.length, 3);
    assert.equal(result.aux.length, 1);
  });

  test('a camelCase scenario key resolves', () => {
    const source = REGISTRY.replace("'first-sale'", "'firstSale'");
    const result = parserFor(source, 'single')();
    assert.ok(result.scenarios.includes('firstSale'));
  });

  test('an unknown quote style is refused at construction', () => {
    assert.throws(
      () =>
        makeRegistryParser({
          absolute: repoFor(REGISTRY),
          fixturesRelative: FIXTURES_RELATIVE,
          registryRelative: `${FIXTURES_RELATIVE}/corpus.ts`,
          quotes: 'backtick',
        }),
      /quotes must be one of/
    );
  });
});
