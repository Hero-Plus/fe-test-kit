// The v0.1.3 cell reader, kept as an opt-in helper a host may call from its own `enumerateCells`.
//
// It is no longer the engine's cell source. Reading host source from inside the engine is what made
// two representation choices — single-quoted imports and a page-and-rows list model — conditions of
// adoption rather than one repo's preferences; a host whose corpus is TypeScript, or double-quoted,
// resolved zero cells and said so nowhere. Every such choice is a parameter here instead.
import { readFileSync } from 'node:fs';

const QUOTE_PATTERN = Object.freeze({
  single: "(')",
  double: '(")',
  both: `(['"])`,
});

// Wider than the `[a-z0-9-]+` the merchant registry needs, because a key style is a host's to pick
// and a key this misses resolves no cell while reporting nothing. A match still has to land on an
// imported body to enter the result, so widening it cannot invent a cell.
const KEY = '([A-Za-z0-9_$-]+)';

export function makeRegistryParser({
  absolute,
  fixturesRelative,
  registryRelative,
  quotes = 'both',
  detailConstruct = 'railed',
  auxConstruct = 'deepFreeze',
  listPageRelative,
  listRowsKey,
  readBody = relative => JSON.parse(readFileSync(absolute(relative), 'utf8')),
}) {
  const q = QUOTE_PATTERN[quotes];
  if (!q)
    throw new Error(
      `makeRegistryParser: quotes must be one of ${Object.keys(QUOTE_PATTERN).join(', ')}`
    );

  const IMPORT_RE = new RegExp(
    `^import\\s+(\\w+)\\s+from\\s+${q}(\\.[^'"]+)\\2;`,
    'gm'
  );
  const DETAIL_RE = new RegExp(
    `${q}${KEY}\\1:\\s*${detailConstruct}\\(\\s*(\\w+)`,
    'g'
  );
  const LIST_RE = new RegExp(`${q}${KEY}\\1:\\s*(\\w+)\\s*[,}]`, 'g');
  const AUX_RE = new RegExp(`(\\w+):\\s*${auxConstruct}\\((\\w+)\\)`, 'g');

  const importMap = source => {
    const map = new Map();
    for (const [, ident, , specifier] of source.matchAll(IMPORT_RE))
      map.set(ident, `${fixturesRelative}/${specifier.replace(/^\.\//, '')}`);
    return map;
  };

  /**
   * Every match is resolved through the import map and dropped when it does not land on an imported
   * body, so a same-shaped expression elsewhere in the file cannot enter the result.
   */
  const readRegistry = source => {
    const imports = importMap(source);
    const details = new Map();
    const listPages = new Map();
    const aux = new Map();

    for (const [, , scenario, ident] of source.matchAll(DETAIL_RE)) {
      const relative = imports.get(ident);
      if (relative) details.set(scenario, relative);
    }
    for (const [, , name, ident] of source.matchAll(LIST_RE)) {
      const relative = imports.get(ident);
      if (listPageRelative && relative?.startsWith(`${listPageRelative}/`))
        listPages.set(name, relative);
    }
    for (const [, name, ident] of source.matchAll(AUX_RE)) {
      const relative = imports.get(ident);
      if (relative) aux.set(name, relative);
    }

    return { details, listPages, aux };
  };

  /**
   * The `list` half re-derives the registry's own row lookup rather than reading it — a list cell is
   * a selector into a stored page, not a payload, and this helper may not import the module that
   * builds it. So this is a second copy of that rule, and changing one without the other is what
   * `cell-map`'s printed ragged set exists to surface.
   */
  return function enumerateCells() {
    const registry = readRegistry(
      readFileSync(absolute(registryRelative), 'utf8')
    );
    const pages = [...registry.listPages].map(([name, relative]) => ({
      name,
      relative,
      ids: new Set(readBody(relative)[listRowsKey].map(row => row.id)),
    }));

    const cells = [];
    const ragged = [];
    const duplicated = [];
    for (const [scenario, relative] of registry.details) {
      const id = readBody(relative).id ?? null;
      cells.push({ scenario, view: 'detail', source: relative, id });

      const holding = pages.filter(page => page.ids.has(id));
      if (holding.length === 0) {
        ragged.push(scenario);
        continue;
      }
      // Last page wins because the registry's row lookup is a Map filled in literal order and a
      // repeated id overwrites. Mirrored rather than rejected, so the check reports the cell the
      // suite reads.
      if (holding.length > 1) duplicated.push({ scenario, id });
      const page = holding[holding.length - 1];
      cells.push({ scenario, view: 'list', source: page.relative, id });
    }

    const aux = [...registry.aux].map(([name, relative]) => ({
      name,
      source: relative,
      // An aux body need not carry a top-level id, and for those the source path is the whole pin —
      // still enough, since a re-pointed `aux` entry moves the path.
      id: readBody(relative).id ?? null,
    }));

    return {
      cells,
      aux,
      scenarios: [...registry.details.keys()],
      views: ['detail', 'list'],
      ragged,
      duplicated,
    };
  };
}
