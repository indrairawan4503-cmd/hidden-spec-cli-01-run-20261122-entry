// main.ts — mend, one patch tool for every AI edit format.
//
// Run as `node main.ts [--format=NAME] [--check] [--strict] [PATCH]` with
// the working directory as the root of a tree of text files. It reads a
// patch in one of four formats (unified diff, SEARCH/REPLACE blocks, V4A
// patches, JSON tool calls), finds the lines each edit names at the first
// of three matching tiers, and writes every change or none. SPEC.md is
// the whole contract.
//
// This file is the thin entry: the command line, the output and exit
// codes, format detection and the all-or-nothing write. The formats live
// in their own modules — unified.ts, searchreplace.ts, v4a.ts, json.ts —
// on top of the shared line model in core.ts and the three-tier matcher
// in matching.ts. Node 22, the standard library alone.

import { mkdirSync, readFileSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  Exit2,
  Fail,
  Tree,
  blank,
  byteCompare,
  patchLines,
  type Edit,
} from './core.ts';
import { parseUnified } from './unified.ts';
import { parseSearchReplace } from './searchreplace.ts';
import { parseV4a } from './v4a.ts';
import { parseJson } from './json.ts';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** Detect the patch's format (SPEC.md section 4), or null when none. */
function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (
    lines.some(
      (l, i) =>
        l.startsWith('diff --git ') ||
        (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')),
    )
  ) {
    return 'unified';
  }
  return null;
}

/** The output rows for the tree's changes, in byte order of the paths. */
function resultRows(tree: Tree): { key: string; text: string }[] {
  interface Row {
    key: string;
    text: string;
  }
  const rows: Row[] = [];
  const covered = new Set<string>();
  // A move that succeeded replaces its pair's `D` and `A` lines with one
  // `R` line, which sorts by its new path.
  for (const [oldP, newP] of tree.moves) {
    if (
      tree.original(oldP) !== null &&
      tree.get(oldP) === null &&
      tree.original(newP) === null &&
      tree.get(newP) !== null
    ) {
      rows.push({ key: newP, text: `R ${oldP} -> ${newP}` });
      covered.add(oldP);
      covered.add(newP);
    }
  }
  for (const p of tree.now.keys()) {
    if (covered.has(p)) continue;
    const was = tree.original(p);
    const now = tree.get(p);
    if (was === now) continue;
    const mark = was === null ? 'A' : now === null ? 'D' : 'M';
    rows.push({ key: p, text: `${mark} ${p}` });
  }
  rows.sort((a, b) => byteCompare(a.key, b.key));
  return rows;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) {
        format = a.slice(9);
      } else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
    text = '';
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = parseJson(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  // Edits apply in the patch's order to the tree as earlier edits left
  // it. A failed edit changes nothing, and the edits after it still run.
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return {
      code: 1,
      out: [
        ...fails.map((f) => `error: ${f.code} ${f.path}`),
        `failed: ${fails.length} of ${edits.length} edits`,
      ],
    };
  }
  const rows = resultRows(tree);
  if (!check) {
    for (const p of [...tree.now.keys()].sort(byteCompare)) {
      const now = tree.get(p);
      if (tree.original(p) === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return {
    code: 0,
    out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`],
  };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this
  // file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
