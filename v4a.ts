// v4a.ts — V4A patches, SPEC.md section 8.
//
//     *** Begin Patch
//     *** Add File: <path>
//     +<line>
//     *** Delete File: <path>
//     *** Update File: <path>
//     *** Move to: <new path>
//     @@ <anchor>
//      <context>
//     -<old>
//     +<new>
//     *** End of File
//     *** End Patch
//
// The first non-blank line is `*** Begin Patch` (else a parse error at
// that line, or at 1 when there is none) and the last non-blank line is
// `*** End Patch` (else a parse error at the number of patch lines plus
// 1), both compared with their surrounding whitespace removed. Between
// them, sections start at `*** Add File: `, `*** Delete File: ` and
// `*** Update File: ` lines. Blank lines at the end of a section (before
// the next section or `*** End Patch`) are not part of it. Blank lines
// between sections are ignored. Any other line is a parse error at its
// line.
//
// An Add File section's lines start with `+` or are empty; a Delete File
// section has no lines; an Update File section may have `*** Move to: `
// as its first line, then chunks. A chunk starts at an `@@` line (the
// text after `@@`, its surrounding spaces removed, is the anchor; an
// empty text is no anchor) or, for the first chunk, at a body line. Body
// lines start with ` `, `-` or `+`, or are empty (an empty context line).
// A `*** End of File` line ends a chunk and anchors it to the end of the
// file. An Update File section with no chunk and no `*** Move to:` is a
// parse error at its Update File line.
//
// Each section is one edit, applied in order. Chunks apply with a cursor
// that starts at line 0: a chunk with an anchor first finds the first line
// at or after the cursor equal to the anchor at the first tier where one
// is, else `no-match`, and the cursor moves past it. The chunk takes the
// first occurrence of its old lines at or after the cursor, at the first
// tier with one; an end-of-file chunk takes only an occurrence that ends
// at the file's last line. With empty old lines the new lines are inserted
// at the cursor, or at the end of the file for an end-of-file chunk. The
// cursor then moves to just after the lines written.

import {
  Exit2,
  Fail,
  blank,
  createdText,
  parseFile,
  renderFile,
  safePath,
  type Edit,
} from './core.ts';
import {
  findAnchor,
  firstTierWithOccurrence,
  renderReplacement,
  tierKey,
  type NewLine,
  type Tier,
} from './matching.ts';

const BEGIN = '*** Begin Patch';
const END = '*** End Patch';
const ADD = '*** Add File: ';
const DELETE = '*** Delete File: ';
const UPDATE = '*** Update File: ';
const MOVE_TO = '*** Move to: ';
const END_OF_FILE = '*** End of File';

interface Chunk {
  /** The anchor text, or null when the chunk has none. */
  anchor: string | null;
  /** The chunk is anchored to the end of the file. */
  eof: boolean;
  oldLines: string[];
  newLines: NewLine[];
}

type Section =
  | { kind: 'add'; path: string; lines: string[] }
  | { kind: 'delete'; path: string }
  | { kind: 'update'; path: string; moveTo: string | null; chunks: Chunk[]; lineNo: number };

/** A chunk's body lines as old lines and new lines (context marked). */
function chunkSplice(body: string[]): { oldLines: string[]; newLines: NewLine[] } {
  const oldLines: string[] = [];
  const newLines: NewLine[] = [];
  for (const l of body) {
    if (l === '' || l.startsWith(' ')) {
      const text = l === '' ? '' : l.slice(1);
      oldLines.push(text);
      newLines.push({ ctx: oldLines.length - 1, text });
    } else if (l.startsWith('-')) {
      oldLines.push(l.slice(1));
    } else if (l.startsWith('+')) {
      newLines.push({ ctx: -1, text: l.slice(1) });
    }
  }
  return { oldLines, newLines };
}

function isBodyLine(l: string): boolean {
  return l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+');
}

/** Parse a V4A patch into its sections' edits. */
export function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== BEGIN) throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== END) throw new Exit2(`error: parse ${lines.length + 1}`);

  const sections: Section[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    if (line.startsWith(ADD) || line.startsWith(DELETE) || line.startsWith(UPDATE)) {
      const headerNo = i + 1;
      const kind = line.startsWith(ADD) ? 'add' : line.startsWith(DELETE) ? 'delete' : 'update';
      const path = line.slice((kind === 'add' ? ADD : kind === 'delete' ? DELETE : UPDATE).length).trim();
      i += 1;
      // The section's lines run to the next section header or End Patch.
      const raw: string[] = [];
      const rawNos: number[] = [];
      while (i < last) {
        const l = lines[i]!;
        if (l.startsWith(ADD) || l.startsWith(DELETE) || l.startsWith(UPDATE)) break;
        raw.push(l);
        rawNos.push(i + 1);
        i += 1;
      }
      // Blank lines at the end of a section are not part of it.
      while (raw.length > 0 && blank(raw[raw.length - 1]!)) {
        raw.pop();
        rawNos.pop();
      }
      sections.push(parseSection(kind, path, raw, rawNos, headerNo));
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return sections.map((s) => sectionEdit(s, strict));
}

/** One section's lines, validated for its kind. */
function parseSection(
  kind: 'add' | 'delete' | 'update',
  path: string,
  raw: string[],
  rawNos: number[],
  headerNo: number,
): Section {
  if (kind === 'add') {
    const out: string[] = [];
    for (let k = 0; k < raw.length; k += 1) {
      const l = raw[k]!;
      if (l === '') out.push('');
      else if (l.startsWith('+')) out.push(l.slice(1));
      else throw new Exit2(`error: parse ${rawNos[k]!}`);
    }
    return { kind: 'add', path, lines: out };
  }
  if (kind === 'delete') {
    if (raw.length > 0) throw new Exit2(`error: parse ${rawNos[0]!}`);
    return { kind: 'delete', path };
  }
  let moveTo: string | null = null;
  let j = 0;
  if (raw.length > 0 && raw[0]!.startsWith(MOVE_TO)) {
    moveTo = raw[0]!.slice(MOVE_TO.length).trim();
    j = 1;
  }
  const chunks: Chunk[] = [];
  let cur: { anchor: string | null; eof: boolean; body: string[] } | null = null;
  const closeChunk = (): void => {
    if (cur !== null) {
      const { oldLines, newLines } = chunkSplice(cur.body);
      chunks.push({ anchor: cur.anchor, eof: cur.eof, oldLines, newLines });
      cur = null;
    }
  };
  for (; j < raw.length; j += 1) {
    const l = raw[j]!;
    const no = rawNos[j]!;
    if (l.startsWith('@@')) {
      closeChunk();
      cur = { anchor: l.slice(2).trim() === '' ? null : l.slice(2).trim(), eof: false, body: [] };
      continue;
    }
    if (l === END_OF_FILE) {
      if (cur === null) throw new Exit2(`error: parse ${no}`);
      cur.eof = true;
      closeChunk();
      continue;
    }
    if (isBodyLine(l)) {
      if (cur === null) {
        if (chunks.length > 0) throw new Exit2(`error: parse ${no}`);
        cur = { anchor: null, eof: false, body: [] };
      }
      cur.body.push(l);
      continue;
    }
    throw new Exit2(`error: parse ${no}`);
  }
  closeChunk();
  if (chunks.length === 0 && moveTo === null) {
    throw new Exit2(`error: parse ${headerNo}`);
  }
  return { kind: 'update', path, moveTo, chunks, lineNo: headerNo };
}

/** One section's edit. */
function sectionEdit(s: Section, strict: boolean): Edit {
  if (s.kind === 'add') {
    return (tree) => {
      if (!safePath(s.path)) throw new Fail('unsafe', s.path);
      if (tree.get(s.path) !== null) throw new Fail('exists', s.path);
      tree.set(s.path, createdText(s.lines));
    };
  }
  if (s.kind === 'delete') {
    return (tree) => {
      if (!safePath(s.path)) throw new Fail('unsafe', s.path);
      if (tree.get(s.path) === null) throw new Fail('missing', s.path);
      tree.set(s.path, null);
    };
  }
  return (tree) => {
    if (!safePath(s.path)) throw new Fail('unsafe', s.path);
    if (s.moveTo !== null && !safePath(s.moveTo)) throw new Fail('unsafe', s.moveTo);
    const before = tree.get(s.path);
    if (before === null) throw new Fail('missing', s.path);
    if (s.moveTo !== null && tree.get(s.moveTo) !== null) throw new Fail('exists', s.moveTo);
    const doc = parseFile(before);
    let lines = [...doc.lines];
    let cursor = 0;
    for (const chunk of s.chunks) {
      if (chunk.anchor !== null) {
        const at = findAnchor(lines, chunk.anchor, cursor, strict);
        if (at === null) throw new Fail('no-match', s.path);
        cursor = at + 1;
      }
      if (chunk.oldLines.length === 0) {
        const at = chunk.eof ? lines.length : cursor;
        const rendered = chunk.newLines.map((n) => n.text);
        lines.splice(at, 0, ...rendered);
        cursor = at + rendered.length;
        continue;
      }
      const found = chunkOccurrence(lines, chunk, cursor, strict);
      if (found === null) throw new Fail('no-match', s.path);
      const rendered = renderReplacement(
        lines,
        chunk.oldLines,
        chunk.newLines,
        found.pos,
        found.tier,
      );
      lines.splice(found.pos, chunk.oldLines.length, ...rendered);
      cursor = found.pos + rendered.length;
    }
    const out = renderFile({ lines, br: doc.br, final: doc.final });
    if (s.moveTo !== null) {
      tree.set(s.moveTo, out);
      tree.set(s.path, null);
      tree.recordMove(s.path, s.moveTo);
    } else {
      tree.set(s.path, out);
    }
  };
}

/**
 * Where a chunk's old lines are taken, with the tier they are found at.
 * A plain chunk takes the first occurrence at or after the cursor, at the
 * first tier with one. An end-of-file chunk takes only an occurrence that
 * ends at the file's last line, so its position is fixed and only the tier
 * is searched. Null when there is no such occurrence.
 */
function chunkOccurrence(
  lines: string[],
  chunk: Chunk,
  cursor: number,
  strict: boolean,
): { pos: number; tier: Tier } | null {
  if (!chunk.eof) {
    const found = firstTierWithOccurrence(lines, chunk.oldLines, cursor, strict);
    if (found === null) return null;
    return { pos: found.positions[0]!, tier: found.tier };
  }
  const end = lines.length - chunk.oldLines.length;
  if (end < cursor) return null;
  const tiers: Tier[] = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    let ok = true;
    for (let j = 0; j < chunk.oldLines.length; j += 1) {
      if (tierKey(lines[end + j]!, tier) !== tierKey(chunk.oldLines[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) return { pos: end, tier };
  }
  return null;
}
