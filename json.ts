// json.ts — JSON edits, SPEC.md section 9.
//
// The patch is either one JSON array of edit objects, or JSON Lines: one
// edit object a line, blank lines ignored. In array form any fault is
// `error: parse <the line where the array starts>`; in JSON Lines form a
// line that does not hold one valid edit object is `error: parse <that
// line>`. An edit object has a string `path` and a `command`; keys other
// than those below are ignored:
//
// - `create`: the file does not exist (else `exists`); it is written with
//   `file_text`'s bytes.
// - `str_replace`: `old_str` a non-empty string, `new_str` a string
//   (absent is empty). The file exists (else `missing`). In a CRLF file
//   the file's text and both strings are read with every `\r\n` as `\n`,
//   and the result is written back with `\r\n`. `old_str` occurs in the
//   text exactly once (positions may overlap), else `no-match` or
//   `ambiguous`; it is replaced by `new_str`. No tier applies: the match
//   is exact.
// - `insert`: `insert_line` an integer, `new_str` a string. The file
//   exists (else `missing`), and `insert_line` is from 0 to its number of
//   lines (else `no-match`). `new_str`'s lines are inserted after line
//   `insert_line` (0 is the top). The file's final break stays as it was.
//
// A wrong command or a missing or mistyped key is a parse fault.

import {
  Exit2,
  Fail,
  blank,
  parseFile,
  patchLines,
  renderFile,
  safePath,
  type Edit,
} from './core.ts';

/** One JSON edit object, or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;

  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safePath(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.set(p, text);
    };
  }

  if (
    o.command === 'str_replace' &&
    typeof o.old_str === 'string' &&
    o.old_str !== '' &&
    (o.new_str === undefined || typeof o.new_str === 'string')
  ) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      if (!safePath(p)) throw new Fail('unsafe', p);
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      // In a CRLF file the text and both strings are read with every
      // `\r\n` as `\n`, and the result is written back with `\r\n`.
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const toLf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const text = toLf(before);
      const old = toLf(oldStr);
      let count = 0;
      for (let k = text.indexOf(old); k >= 0; k = text.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = text.indexOf(old);
      const out = text.slice(0, at) + toLf(newStr) + text.slice(at + old.length);
      tree.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }

  if (
    o.command === 'insert' &&
    typeof o.insert_line === 'number' &&
    Number.isInteger(o.insert_line) &&
    typeof o.new_str === 'string'
  ) {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      if (!safePath(p)) throw new Fail('unsafe', p);
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const doc = parseFile(before);
      if (line < 0 || line > doc.lines.length) throw new Fail('no-match', p);
      const lines = [...doc.lines];
      lines.splice(line, 0, ...add);
      tree.set(p, renderFile({ lines, br: doc.br, final: doc.final }));
    };
  }

  return null;
}

/** Parse a JSON patch (array form or JSON Lines) into its edits. */
export function parseJson(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}
