// core.ts — the pieces every format of mend shares: errors, patch lines,
// safe paths, the file line model, and the in-memory tree edits apply to.
//
// A file is read as lines plus the line break it uses plus whether it ends
// with one. Section 3 of SPEC.md fixes that model: the break is CRLF when
// the file's first line feed follows a carriage return, the lines are the
// text split at that break, and a trailing break means the last empty piece
// is not a line. An empty file has no lines and no final break.

import { readFileSync, statSync } from 'node:fs';

/** An exit-2 answer: the one line the CLI prints for it. */
export class Exit2 extends Error {
  readonly line: string;
  constructor(line: string) {
    super(line);
    this.line = line;
  }
}

/** One edit failed: the code and the path its error line names. */
export class Fail extends Error {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    super(`${code} ${path}`);
    this.code = code;
    this.path = path;
  }
}

/** An edit: it changes the tree, or throws Fail when it cannot. */
export type Edit = (tree: Tree) => void;

/** Empty, or only whitespace. */
export const blank = (s: string): boolean => s.trim() === '';

/**
 * A patch's lines (SPEC.md section 3): split at \n, one trailing \r removed
 * from each, and no empty piece after a final \n. An empty patch has none.
 */
export function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** A path is safe when it is not empty, not absolute, holds no backslash,
 *  and none of its segments is empty, `.` or `..` (SPEC.md section 3). */
export function safePath(p: string): boolean {
  return (
    p !== '' &&
    !p.startsWith('/') &&
    !p.includes('\\') &&
    p.split('/').every((s) => s !== '' && s !== '.' && s !== '..')
  );
}

/** Byte order of UTF-8 paths, for the output rows (SPEC.md section 2). */
export function byteCompare(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/** A file as lines, its own line break, and whether it ends with one. */
export interface FileDoc {
  lines: string[];
  br: '\n' | '\r\n';
  final: boolean;
}

/** Split a file's text into the line model of SPEC.md section 3. */
export function parseFile(text: string): FileDoc {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br: '\n' | '\r\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

/** Write a file's lines back with its own break and final break. */
export function renderFile(doc: FileDoc): string {
  if (doc.lines.length === 0) return '';
  return doc.lines.join(doc.br) + (doc.final ? doc.br : '');
}

/** A created file's text: LF breaks, ending with one unless it is empty. */
export function createdText(lines: string[]): string {
  if (lines.length === 0) return '';
  return `${lines.join('\n')}\n`;
}

/**
 * The tree as the edits leave it. `now` holds every path an edit touched
 * (null: deleted); anything else is read from disk on demand and cached.
 * `moves` records the move edits that applied, for the `R` output rows.
 */
export class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<[string, string]> = [];

  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }

  /** The text a path holds now: an edit's result, else what is on disk. */
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }

  set(p: string, v: string | null): void {
    this.now.set(p, v);
  }

  recordMove(oldPath: string, newPath: string): void {
    this.moves.push([oldPath, newPath]);
  }
}
