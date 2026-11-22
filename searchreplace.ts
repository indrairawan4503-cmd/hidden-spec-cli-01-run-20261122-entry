// searchreplace.ts — SEARCH/REPLACE blocks, SPEC.md section 7.
//
// A block is:
//
//     <path>
//     <<<<<<< SEARCH
//     <old lines>
//     =======
//     <new lines>
//     >>>>>>> REPLACE
//
// The three marker lines are matched with their trailing whitespace
// removed. The path is the nearest line before the `<<<<<<< SEARCH` line,
// and after the previous block's `>>>>>>> REPLACE` line (or the start of
// the patch), that is not blank and does not start with three backticks
// once its surrounding whitespace is removed; the path is that line with
// its surrounding whitespace removed. When there is no such line the block
// takes the previous block's path; the first block with none is a parse
// error at its SEARCH line. A SEARCH line with no `=======` and then
// `>>>>>>> REPLACE` after it is a parse error at the SEARCH line. Lines
// outside blocks are otherwise ignored.
//
// Each block is one edit, applied in order: with empty old lines the file
// is created with the new lines (else `exists`); otherwise the file exists
// (else `missing`), and the old lines occur at their tier exactly once, or
// the block fails with `ambiguous`; the new lines replace them.

import {
  Exit2,
  Fail,
  createdText,
  parseFile,
  renderFile,
  safePath,
  type Edit,
} from './core.ts';
import {
  firstTierWithOccurrence,
  spliceReplacement,
  type NewLine,
} from './matching.ts';

const SEARCH = '<<<<<<< SEARCH';
const MIDDLE = '=======';
const REPLACE = '>>>>>>> REPLACE';

interface Block {
  path: string;
  oldLines: string[];
  newLines: string[];
}

/** Parse a patch of SEARCH/REPLACE blocks into its edits. */
export function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const blocks: Block[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== SEARCH) {
      i += 1;
      continue;
    }
    const searchNo = i + 1;
    let path: string | null = null;
    for (let j = i - 1; j >= prevEnd; j -= 1) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchNo}`);
      path = prevPath;
    }
    let eq = -1;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === MIDDLE) {
        eq = j;
        break;
      }
      if (lines[j]!.trimEnd() === REPLACE) break;
    }
    if (eq === -1) throw new Exit2(`error: parse ${searchNo}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === REPLACE) {
        rep = j;
        break;
      }
    }
    if (rep === -1) throw new Exit2(`error: parse ${searchNo}`);
    blocks.push({
      path,
      oldLines: lines.slice(i + 1, eq),
      newLines: lines.slice(eq + 1, rep),
    });
    prevPath = path;
    prevEnd = rep + 1;
    i = rep + 1;
  }
  return blocks.map((b) => blockEdit(b, strict));
}

/** One block's edit. */
function blockEdit(b: Block, strict: boolean): Edit {
  return (tree) => {
    if (!safePath(b.path)) throw new Fail('unsafe', b.path);
    if (b.oldLines.length === 0) {
      if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
      tree.set(b.path, createdText(b.newLines));
      return;
    }
    const before = tree.get(b.path);
    if (before === null) throw new Fail('missing', b.path);
    const doc = parseFile(before);
    const found = firstTierWithOccurrence(doc.lines, b.oldLines, 0, strict);
    if (found === null) throw new Fail('no-match', b.path);
    if (found.positions.length > 1) throw new Fail('ambiguous', b.path);
    const fresh: NewLine[] = b.newLines.map((text) => ({ ctx: -1, text }));
    const out = spliceReplacement(doc.lines, b.oldLines, fresh, found.positions[0]!, found.tier);
    tree.set(b.path, renderFile({ lines: out, br: doc.br, final: doc.final }));
  };
}
