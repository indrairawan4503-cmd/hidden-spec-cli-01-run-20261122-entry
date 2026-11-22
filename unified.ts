// unified.ts — unified diffs, SPEC.md section 6.
//
// A patch is read section by section. A section starts at a
// `diff --git a/<X> b/<Y>` line, or at a `--- ` line followed by a `+++ `
// line. Its header names the old and new path (`---`/`+++`, else
// `rename from`/`rename to`, else the `diff --git` paths), marks a
// creation (`new file mode`, old path `/dev/null`) or a deletion
// (`deleted file mode`, new path `/dev/null`), and then come its hunks.
//
// A hunk starts at `@@ -A[,B] +C[,D] @@`; its body is the lines after the
// header that start with ` `, `-`, `+` or `\`, or are empty (an empty line
// is a context line with empty text). Empty lines at the end of a body are
// not part of it. Outside bodies, lines that are not part of a section
// header are ignored.
//
// One section is one edit: a creation, a deletion, a move (old and new
// path differ), or a change of the one path. Its hunks apply in order,
// each to the result of the ones before it. Of the occurrences at the tier
// where the hunk's old lines are found, the hunk takes the one nearest to
// A - 1 + d, where d is the drift of the hunks applied so far; an empty
// old block is inserted after the first A + d lines.

import {
  Exit2,
  Fail,
  parseFile,
  renderFile,
  safePath,
  type Edit,
  type FileDoc,
} from './core.ts';
import {
  firstTierWithOccurrence,
  nearestPosition,
  renderReplacement,
  spliceReplacement,
  type NewLine,
} from './matching.ts';

type BodyKind = 'ctx' | 'old' | 'new' | 'mark';

interface BodyLine {
  kind: BodyKind;
  text: string;
  /** The raw patch line was empty (a context line written as nothing). */
  rawEmpty: boolean;
}

interface Hunk {
  /** The A of `@@ -A[,B] +C[,D] @@`. */
  a: number;
  body: BodyLine[];
}

interface Section {
  oldPath: string | null;
  newPath: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  gitOld: string | null;
  gitNew: string | null;
  isCreate: boolean;
  isDelete: boolean;
  hunks: Hunk[];
}

const DIFF_GIT = /^diff --git a\/(\S+) b\/(\S+)[ \t]*$/;
const HUNK_HEAD = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

/** A `diff --git` line's paths, or a parse error at its line. */
function diffGitPaths(line: string, lineNo: number): [string, string] {
  const m = DIFF_GIT.exec(line);
  if (m === null) throw new Exit2(`error: parse ${lineNo}`);
  return [m[1]!, m[2]!];
}

/** A hunk header's A, or a parse error at its line. */
function hunkStart(line: string, lineNo: number): Hunk {
  const m = HUNK_HEAD.exec(line);
  if (m === null) throw new Exit2(`error: parse ${lineNo}`);
  return { a: parseInt(m[1]!, 10), body: [] };
}

/**
 * A `--- `/`+++ ` path: the text after the four characters, up to the
 * first tab, with surrounding spaces removed; `/dev/null` means no file,
 * and a leading `a/` or `b/` is removed.
 */
function headerPath(line: string): string | null {
  const raw = line.slice(4).split('\t')[0]!.trim();
  if (raw === '/dev/null') return null;
  if (raw.startsWith('a/') || raw.startsWith('b/')) return raw.slice(2);
  return raw;
}

function startsSection(line: string, next: string | undefined): boolean {
  return line.startsWith('--- ') && next !== undefined && next.startsWith('+++ ');
}

/** A body line's kind and text, or null when the line is not one. */
function bodyLine(line: string): BodyLine | null {
  if (line === '') return { kind: 'ctx', text: '', rawEmpty: true };
  if (line.startsWith(' ')) return { kind: 'ctx', text: line.slice(1), rawEmpty: false };
  if (line.startsWith('-')) return { kind: 'old', text: line.slice(1), rawEmpty: false };
  if (line.startsWith('+')) return { kind: 'new', text: line.slice(1), rawEmpty: false };
  if (line.startsWith('\\')) return { kind: 'mark', text: line.slice(1), rawEmpty: false };
  return null;
}

/** A hunk's old lines (context and `-`) and new lines (context and `+`),
 *  each new line marked with the old line it is a context line of. */
function hunkSplice(hunk: Hunk): { oldLines: string[]; newLines: NewLine[] } {
  const oldLines: string[] = [];
  const newLines: NewLine[] = [];
  for (const b of hunk.body) {
    if (b.kind === 'ctx') {
      oldLines.push(b.text);
      newLines.push({ ctx: oldLines.length - 1, text: b.text });
    } else if (b.kind === 'old') {
      oldLines.push(b.text);
    } else if (b.kind === 'new') {
      newLines.push({ ctx: -1, text: b.text });
    }
  }
  return { oldLines, newLines };
}

/**
 * Whether a `\` line follows the hunk's last context or `+` line: then the
 * result does not end with a line break (SPEC.md section 6).
 */
function hunkNoEol(hunk: Hunk): boolean {
  let last = -1;
  for (let i = 0; i < hunk.body.length; i += 1) {
    if (hunk.body[i]!.kind === 'ctx' || hunk.body[i]!.kind === 'new') last = i;
  }
  if (last < 0) return false;
  return hunk.body[last + 1]?.kind === 'mark';
}

/** Whether a `\` line follows the created file's last `+` line. */
function creationNoEol(hunks: Hunk[]): boolean {
  for (let h = hunks.length - 1; h >= 0; h -= 1) {
    const body = hunks[h]!.body;
    let last = -1;
    for (let i = 0; i < body.length; i += 1) {
      if (body[i]!.kind === 'new') last = i;
    }
    if (last >= 0) return body[last + 1]?.kind === 'mark';
  }
  return false;
}

/** Apply a section's hunks in order to a file, tracking the drift `d`. */
function applyHunks(doc: FileDoc, hunks: Hunk[], strict: boolean, path: string): FileDoc {
  let lines = [...doc.lines];
  let { br } = doc;
  let final = doc.final;
  let d = 0;
  for (const hunk of hunks) {
    const { oldLines, newLines } = hunkSplice(hunk);
    const noEol = hunkNoEol(hunk);
    if (oldLines.length > 0) {
      const found = firstTierWithOccurrence(lines, oldLines, 0, strict);
      if (found === null) throw new Fail('no-match', path);
      const pos = nearestPosition(found.positions, hunk.a - 1 + d);
      const touchesEnd = pos + oldLines.length === lines.length;
      lines = spliceReplacement(lines, oldLines, newLines, pos, found.tier);
      if (touchesEnd) final = !noEol;
    } else {
      const at = Math.min(Math.max(hunk.a + d, 0), lines.length);
      const rendered = renderReplacement(lines, [], newLines, at, 0);
      const touchesEnd = at === lines.length;
      lines.splice(at, 0, ...rendered);
      if (touchesEnd) final = !noEol;
    }
    d += newLines.length - oldLines.length;
  }
  return { lines, br, final };
}

/** Parse a unified patch into its sections' edits. */
export function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let inHeader = false;
  let inBody = false;
  let curHunk: Hunk | null = null;

  const endBody = (): void => {
    if (curHunk !== null) {
      // Empty lines at the end of a body are not part of it.
      while (curHunk.body.length > 0) {
        const last = curHunk.body[curHunk.body.length - 1]!;
        if (last.kind === 'ctx' && last.rawEmpty) curHunk.body.pop();
        else break;
      }
    }
    inBody = false;
    curHunk = null;
  };

  const newSection = (gitOld: string | null, gitNew: string | null): Section => {
    const s: Section = {
      oldPath: null,
      newPath: null,
      renameFrom: null,
      renameTo: null,
      gitOld,
      gitNew,
      isCreate: false,
      isDelete: false,
      hunks: [],
    };
    sections.push(s);
    cur = s;
    inHeader = true;
    return s;
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const next = lines[i + 1];
    if (inBody) {
      if (line.startsWith('diff --git ') || startsSection(line, next)) {
        endBody();
        continue;
      }
      if (line.startsWith('@@')) {
        endBody();
        continue;
      }
      const b = bodyLine(line);
      if (b !== null) {
        curHunk!.body.push(b);
        i += 1;
        continue;
      }
      endBody();
      continue;
    }
    if (line.startsWith('diff --git ')) {
      const [x, y] = diffGitPaths(line, i + 1);
      newSection(x, y);
      i += 1;
      continue;
    }
    if ((cur === null || !inHeader) && startsSection(line, next)) {
      newSection(null, null);
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('--- ')) {
        if (next === undefined || !next.startsWith('+++ ')) {
          throw new Exit2(`error: parse ${i + 2}`);
        }
        cur.oldPath = headerPath(line);
        i += 1;
        continue;
      }
      if (line.startsWith('+++ ')) {
        cur.newPath = headerPath(line);
        i += 1;
        continue;
      }
      if (line.startsWith('rename from ')) {
        cur.renameFrom = line.slice('rename from '.length).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('rename to ')) {
        cur.renameTo = line.slice('rename to '.length).trim();
        i += 1;
        continue;
      }
      if (line === 'new file mode' || line.startsWith('new file mode ')) {
        cur.isCreate = true;
        i += 1;
        continue;
      }
      if (line === 'deleted file mode' || line.startsWith('deleted file mode ')) {
        cur.isDelete = true;
        i += 1;
        continue;
      }
      if (line.startsWith('@@')) {
        curHunk = hunkStart(line, i + 1);
        cur.hunks.push(curHunk);
        inHeader = false;
        inBody = true;
        i += 1;
        continue;
      }
      i += 1;
      continue;
    }
    if (cur !== null) {
      if (line.startsWith('@@')) {
        curHunk = hunkStart(line, i + 1);
        cur.hunks.push(curHunk);
        inBody = true;
        i += 1;
        continue;
      }
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
    i += 1;
  }
  if (inBody) endBody();

  return sections.map((s) => sectionEdit(s, strict));
}

/** One section's edit, with its paths resolved from the header. */
function sectionEdit(s: Section, strict: boolean): Edit {
  const oldP = s.oldPath ?? s.renameFrom ?? s.gitOld;
  const newP = s.newPath ?? s.renameTo ?? s.gitNew;
  return (tree) => {
    if (oldP === null || s.isCreate) {
      // A creation: the new path does not exist; the file is the `+` lines
      // of all its hunks, in order.
      if (newP === null) return;
      if (!safePath(newP)) throw new Fail('unsafe', newP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const plus: string[] = [];
      for (const h of s.hunks) {
        for (const b of h.body) if (b.kind === 'new') plus.push(b.text);
      }
      // A created file ends with a line break unless a `\` line follows
      // its last `+` line; with no `+` lines at all it is empty.
      const text =
        plus.length === 0 ? '' : `${plus.join('\n')}${creationNoEol(s.hunks) ? '' : '\n'}`;
      tree.set(newP, text);
      return;
    }
    if (newP === null || s.isDelete) {
      // A deletion: the old path exists; its hunks are not read.
      if (!safePath(oldP)) throw new Fail('unsafe', oldP);
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.set(oldP, null);
      return;
    }
    if (oldP !== newP) {
      // A move: the hunks apply to the old file's lines, the result is
      // written at the new path, the old path deleted.
      if (!safePath(oldP)) throw new Fail('unsafe', oldP);
      if (!safePath(newP)) throw new Fail('unsafe', newP);
      const before = tree.get(oldP);
      if (before === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const doc = applyHunks(parseFile(before), s.hunks, strict, oldP);
      tree.set(newP, renderFile(doc));
      tree.set(oldP, null);
      tree.recordMove(oldP, newP);
      return;
    }
    // A change of the one path, which exists.
    if (!safePath(oldP)) throw new Fail('unsafe', oldP);
    const before = tree.get(oldP);
    if (before === null) throw new Fail('missing', oldP);
    const doc = applyHunks(parseFile(before), s.hunks, strict, oldP);
    tree.set(oldP, renderFile(doc));
  };
}
