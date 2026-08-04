// lib/cells.mjs — answers, by reading files, the two questions the corpus checks ask
// of the corpus: which body backs each `(scenario, view)` cell, and which origin bucket every body
// sits in.
//
// It never imports the corpus: importing needs a TS loader and a resolvable module graph, which the
// sibling repo adopting these checks will not have until long after it has the corpus. `corpus.ts`
// is read as source text instead — the technique terminal's `lib/corpus.mjs:33` uses on its
// SYNTHETIC markers.
//
// The textual read fails closed: `checks/cell-map.mjs` compares this against a committed manifest,
// so a cell this file stops recognising reports as missing, never as a pass.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import {
  absolute,
  FIXTURES_RELATIVE,
  LIST_PAGE_RELATIVE,
  LIST_ROWS_KEY,
  ORIGIN_RELATIVE,
  REPO_ROOT,
} from '../config.mjs';

export const REGISTRY_RELATIVE = `${FIXTURES_RELATIVE}/corpus.ts`;

// An origin directory legitimately holds non-bodies — `authored/.gitkeep` carries that directory's
// editorial policy — and only a wire body is classified.
const BODY_EXTENSIONS = new Set(['.json', '.ts']);

// Exported so both sides of a live-vs-HEAD comparison spell the condition once: filtering one side
// on extension and the other on origin alone reported `authored/.gitkeep` as a departed body.
export const isBody = relative =>
  originOf(relative) !== null && BODY_EXTENSIONS.has(path.extname(relative));

const posix = full => path.relative(REPO_ROOT, full).split(path.sep).join('/');

export function originOf(relative) {
  for (const dir of ORIGIN_RELATIVE) {
    if (relative.startsWith(`${dir}/`)) return path.basename(dir);
  }
  return null;
}

function filesUnder(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) filesUnder(full, out);
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

/** Every classified body in the working tree, read from disk so an unstaged move is still visible. */
export function listBodies() {
  const bodies = [];
  for (const relativeDir of ORIGIN_RELATIVE) {
    const dir = absolute(relativeDir);
    if (!existsSync(dir)) continue;
    for (const full of filesUnder(dir)) {
      const relative = posix(full);
      if (!isBody(relative)) continue;
      bodies.push({
        relative,
        basename: path.basename(full),
        origin: originOf(relative),
      });
    }
  }
  return bodies;
}

export function readJson(relative) {
  return JSON.parse(readFileSync(absolute(relative), 'utf8'));
}

export function headPaths() {
  const listed = execFileSync(
    'git',
    ['ls-tree', '-r', '--name-only', 'HEAD', '--', FIXTURES_RELATIVE],
    { cwd: REPO_ROOT, encoding: 'utf8' }
  );
  return listed.split('\n').filter(Boolean);
}

export function headContent(relative) {
  return execFileSync('git', ['show', `HEAD:${relative}`], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

function importMap(source) {
  const map = new Map();
  for (const [, ident, specifier] of source.matchAll(
    /^import\s+(\w+)\s+from\s+'(\.[^']+)';/gm
  )) {
    map.set(ident, `${FIXTURES_RELATIVE}/${specifier.replace(/^\.\//, '')}`);
  }
  return map;
}

/**
 * The registry read off `corpus.ts`'s source. Every match is resolved through the import map and
 * dropped when it does not land on an imported body, so a same-shaped expression elsewhere in the
 * file cannot enter the result.
 */
export function readRegistry(source) {
  const imports = importMap(source);
  const details = new Map();
  const listPages = new Map();
  const aux = new Map();

  for (const [, scenario, ident] of source.matchAll(
    /'([a-z0-9-]+)':\s*railed\(\s*(\w+)/g
  )) {
    const relative = imports.get(ident);
    if (relative) details.set(scenario, relative);
  }
  for (const [, name, ident] of source.matchAll(
    /'([a-z0-9-]+)':\s*(\w+)\s*[,}]/g
  )) {
    const relative = imports.get(ident);
    if (relative?.startsWith(`${LIST_PAGE_RELATIVE}/`))
      listPages.set(name, relative);
  }
  for (const [, name, ident] of source.matchAll(
    /(\w+):\s*deepFreeze\((\w+)\)/g
  )) {
    const relative = imports.get(ident);
    if (relative) aux.set(name, relative);
  }

  return { details, listPages, aux };
}

/**
 * Resolves every filled cell to the file backing it and the purchase it carries.
 *
 * The `list` half re-derives `corpus.ts:147-151`'s `ROW_BY_ID` rather than reading it — a list cell
 * is a selector into a stored page, not a payload, and the check may not import the module that
 * builds it. So this is a second copy of that rule, and changing one without the other is what
 * `checks/cell-map.mjs`'s printed ragged set exists to surface.
 */
export function enumerateCells() {
  const registry = readRegistry(
    readFileSync(absolute(REGISTRY_RELATIVE), 'utf8')
  );
  const pages = [...registry.listPages].map(([name, relative]) => ({
    name,
    relative,
    ids: new Set(readJson(relative)[LIST_ROWS_KEY].map(row => row.id)),
  }));

  const cells = [];
  const ragged = [];
  const duplicated = [];
  for (const [scenario, relative] of registry.details) {
    const purchase = readJson(relative).id;
    cells.push({ scenario, view: 'detail', source: relative, purchase });

    const holding = pages.filter(page => page.ids.has(purchase));
    if (holding.length === 0) {
      ragged.push(scenario);
      continue;
    }
    // Last page wins because `ROW_BY_ID` is a Map filled in literal order and a repeated id
    // overwrites. Mirrored rather than rejected, so the check reports the cell the suite reads.
    if (holding.length > 1) duplicated.push({ scenario, purchase });
    const page = holding[holding.length - 1];
    cells.push({ scenario, view: 'list', source: page.relative, purchase });
  }

  const aux = [...registry.aux].map(([name, relative]) => ({
    name,
    source: relative,
    // An aux body need not carry a top-level id, and for those the source path is the whole pin —
    // still enough, since a re-pointed `aux` entry moves the path.
    id: readJson(relative).id ?? null,
  }));

  return {
    cells,
    aux,
    ragged,
    duplicated,
    scenarios: [...registry.details.keys()],
    listPages: [...registry.listPages.keys()],
  };
}

export const cellKey = cell => `${cell.scenario}.${cell.view}`;

export const splitCellKey = key => {
  const at = key.lastIndexOf('.');
  return { scenario: key.slice(0, at), view: key.slice(at + 1) };
};
