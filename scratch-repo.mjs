// A throwaway git repo whose HEAD state is the thing under test, shared by the suites that exercise
// outcomes. The checks that compare against HEAD cannot be tested any other way: their subject is
// the difference between a working tree and a commit, which no in-process fixture can stand in for.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const FIXTURES_RELATIVE = 'src/test/fixtures';

// Identity and signing are pinned rather than inherited: a machine whose global config demands a GPG
// signature would otherwise fail the commit and surface it as a check outcome.
const git = (root, args) =>
  execFileSync(
    'git',
    [
      '-c',
      'user.email=kit@example.test',
      '-c',
      'user.name=fe-test-kit',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    { cwd: root, stdio: 'pipe' }
  );

// `HP_TEST_DROP` and `HP_TEST_UNRESOLVED` let a test make this provider misbehave the two ways a real
// one does: a body the registry stopped naming, and a registry value that resolves to no file.
export const PATHS_MODULE = `
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, '..');
export const absolute = relative => path.join(REPO_ROOT, relative);
export const TOOLS_RELATIVE = 'tools';
export const FIXTURES_RELATIVE = '${FIXTURES_RELATIVE}';
export const FIXTURES_DIR = absolute(FIXTURES_RELATIVE);
export const ORIGIN_RELATIVE = [
  FIXTURES_RELATIVE + '/captured',
  FIXTURES_RELATIVE + '/authored',
];
export const CAPTURED_ORIGIN = 'captured';
export const CORPUS_ROOT_FILES = ['README.md'];
export const CORPUS_ROOT_SUFFIXES = [];
export const PAN_ALLOWLIST_RELATIVE = 'tools/pan-allowlist.json';
export const PAN_ALLOWLIST = absolute(PAN_ALLOWLIST_RELATIVE);
export const CELL_MANIFEST_RELATIVE = 'tools/cell-manifest.json';
export const CELL_MANIFEST = absolute(CELL_MANIFEST_RELATIVE);
export const TRANSACTION_TABLES_RELATIVE = 'tools/transaction-tables.json';
export const TRANSACTION_TABLES = absolute(TRANSACTION_TABLES_RELATIVE);
export const RULE_EXEMPTIONS_RELATIVE = 'tools/rule-coverage-exemptions.json';
export const SCRIPTS = {
  verify: 'npm run fixtures:verify',
  pinCells: 'npm run fixtures:pin-cells',
  listCells: 'npm run fixtures:list-cells',
};

export const readBody = async absolutePath =>
  JSON.parse(readFileSync(absolutePath, 'utf8'));

export const listCaptures = async () => {
  const dir = absolute('tools/captures');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).map(name => ({
    label: name,
    body: JSON.parse(readFileSync(path.join(dir, name), 'utf8')),
  }));
};

export const enumerateCells = async () => {
  const cells = [];
  for (const relativeDir of ORIGIN_RELATIVE) {
    const dir = absolute(relativeDir);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      const source = relativeDir + '/' + name;
      const scenario = name.replace(/\\.json$/, '');
      if (process.env.HP_TEST_DROP === scenario) continue;
      const body = JSON.parse(readFileSync(absolute(source), 'utf8'));
      cells.push({
        scenario,
        view: 'detail',
        source: process.env.HP_TEST_UNRESOLVED === scenario ? null : source,
        id: body.id ?? null,
      });
    }
  }
  return {
    cells,
    aux: [],
    scenarios: cells.map(cell => cell.scenario),
    views: ['detail'],
    ragged: [],
    duplicated: [],
  };
};

export const CHECKS = [
  { name: 'no-pan', kit: 'checks/no-pan.mjs', required: true },
  { name: 'verbatim', kit: 'checks/verbatim.mjs' },
  { name: 'origin-set', kit: 'checks/origin-set.mjs' },
  { name: 'cell-map', kit: 'checks/cell-map.mjs' },
  { name: 'capture-provenance', kit: 'checks/capture-provenance.mjs' },
  { name: 'rule-coverage', kit: 'checks/rule-coverage.mjs' },
];
`;

export function makeScratch(prefix) {
  const scratch = mkdtempSync(path.join(tmpdir(), `hp-fixtures-${prefix}-`));
  let made = 0;

  const makeRepo = ({ withCorpus = true, commitCorpus = true } = {}) => {
    const root = path.join(scratch, `repo-${(made += 1)}`);
    const write = (relative, contents) => {
      const full = path.join(root, relative);
      mkdirSync(path.dirname(full), { recursive: true });
      writeFileSync(full, contents);
      return full;
    };

    mkdirSync(root, { recursive: true });
    git(root, ['init', '-q']);
    write('tools/paths.mjs', PATHS_MODULE);
    if (withCorpus) {
      write(`${FIXTURES_RELATIVE}/README.md`, '# corpus\n');
      git(root, ['add', '-A']);
      git(root, ['commit', '-qm', 'corpus root']);
      write(
        `${FIXTURES_RELATIVE}/captured/alpha.json`,
        `${JSON.stringify({ id: 'purchase-alpha', total: 100 }, null, 2)}\n`
      );
      if (commitCorpus) {
        git(root, ['add', '-A']);
        git(root, ['commit', '-qm', 'promote alpha']);
      }
    } else {
      write('README.md', '# no corpus\n');
      git(root, ['add', '-A']);
      git(root, ['commit', '-qm', 'root']);
    }

    return { root, write, config: path.join(root, 'tools/paths.mjs') };
  };

  const run = (repo, file, args = [], env = {}) =>
    spawnSync(process.execPath, [path.join(__dirname, file), ...args], {
      cwd: repo.root,
      env: { ...process.env, HP_FIXTURES_CONFIG: repo.config, ...env },
      encoding: 'utf8',
    });

  return { scratch, makeRepo, run };
}
