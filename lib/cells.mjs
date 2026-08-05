// lib/cells.mjs — answers, by reading files and never their contents, the one question the corpus
// checks ask of the filesystem: which origin bucket every body sits in.
//
// Until v1.0 this file also resolved cells, by parsing `corpus.ts` as source text, under a rule that
// read "checks read files, never modules". That rule is overturned for cell resolution, and
// deliberately: its premise was that an adopting repo would have no TS loader, which is false — a
// 41-line one built on the `typescript` devDependency is enough. The property it protected survives
// intact, because the engine still ships no loader and imports no corpus: the *host* resolves its own
// cells and hands back plain data through `enumerateCells`. Restoring a parser here would put host
// syntax back inside the engine, which is what made single-quote-only source and JSON-only bodies
// hard blockers for two of the three repos.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

import {
  absolute,
  FIXTURES_RELATIVE,
  ORIGIN_RELATIVE,
  REPO_ROOT,
} from '../config.mjs';

// An origin directory legitimately holds non-bodies — `authored/.gitkeep` carries that directory's
// editorial policy — and only a wire body is classified.
//
// Deliberately not on the config contract in v1.0, unlike the hardcodes around it: three repos
// resolve against that contract, and a name added to it is one each of them must then get right. The
// residual risk this accepts is a *mixed* corpus, where the unlisted bodies drop out while the counts
// stay green — stated in the README so an adopter meets it before writing one.
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

export function headPaths() {
  const listed = execFileSync(
    'git',
    ['ls-tree', '-r', '--name-only', 'HEAD', '--', FIXTURES_RELATIVE],
    // stderr is piped rather than left to execFileSync's default, which forwards it to the parent
    // and prints git's raw `fatal:` line ahead of the check's own message about it.
    { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  );
  return listed.split('\n').filter(Boolean);
}
