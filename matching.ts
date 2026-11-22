// matching.ts — the three-tier line matcher of SPEC.md section 5, kept in
// one place so every format matches the same way.
//
// A tier is how alike two lines must be:
//   tier 0: every line equal;
//   tier 1: equal once trailing spaces and tabs are removed from both;
//   tier 2: equal once leading and trailing spaces and tabs are removed.
// An old block is found at the first tier at which it occurs at least once.
// Each format then says which occurrence it takes.
//
// When new lines replace matched ones, a context line (a line of both the
// old and the new block) is written as the file's own matched line, never
// the patch's. At tier 2 every other new line is re-indented: let F be the
// leading spaces and tabs of the file's first matched line and P those of
// the old block's first line; a new line that is not empty, not only
// whitespace, and starts with P has that P replaced by F; any other line is
// written as it is. (When P is empty every such line starts with it, so F
// is put in front of each.) At tiers 0 and 1 new lines are written as they
// are.

/** A matching tier: 0 exact, 1 trailing whitespace, 2 both sides. */
export type Tier = 0 | 1 | 2;

/** The tiers to try, in order; `--strict` tries tier 0 only. */
export function tiersToTry(strict: boolean): Tier[] {
  return strict ? [0] : [0, 1, 2];
}

function stripTrailing(line: string): string {
  return line.replace(/[ \t]+$/, '');
}

function stripBoth(line: string): string {
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** A line as a tier sees it. */
export function tierKey(line: string, tier: Tier): string {
  if (tier === 0) return line;
  if (tier === 1) return stripTrailing(line);
  return stripBoth(line);
}

/** The leading spaces and tabs of a line. */
export function leadingWs(line: string): string {
  const m = /^[ \t]*/.exec(line);
  return m === null ? '' : m[0];
}

/**
 * Every 0-based position at which `oldLines` occurs in `fileLines` at
 * `tier`, at or after `from`. Occurrences may overlap.
 */
export function occurrencesAt(
  fileLines: string[],
  oldLines: string[],
  tier: Tier,
  from = 0,
): number[] {
  const out: number[] = [];
  if (oldLines.length === 0) return out;
  const keys = oldLines.map((l) => tierKey(l, tier));
  outer: for (let i = from; i + oldLines.length <= fileLines.length; i += 1) {
    for (let j = 0; j < oldLines.length; j += 1) {
      if (tierKey(fileLines[i + j]!, tier) !== keys[j]) continue outer;
    }
    out.push(i);
  }
  return out;
}

/**
 * The first tier at which `oldLines` occurs at or after `from`, with every
 * occurrence there; null when it occurs at no tier.
 */
export function firstTierWithOccurrence(
  fileLines: string[],
  oldLines: string[],
  from: number,
  strict: boolean,
): { tier: Tier; positions: number[] } | null {
  for (const tier of tiersToTry(strict)) {
    const positions = occurrencesAt(fileLines, oldLines, tier, from);
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

/**
 * Of the occurrences, the one whose position is nearest to `target`; of two
 * equally near, the earlier. The list is in ascending order, so keeping the
 * first strictly-nearest one settles ties towards the earlier position.
 */
export function nearestPosition(positions: number[], target: number): number {
  let best = positions[0]!;
  let bestDist = Math.abs(best - target);
  for (const p of positions) {
    const d = Math.abs(p - target);
    if (d < bestDist) {
      best = p;
      bestDist = d;
    }
  }
  return best;
}

/**
 * A V4A anchor: the first line at or after `from` equal to the anchor at
 * the first tier where one is (both sides a single line); null when none.
 */
export function findAnchor(
  fileLines: string[],
  anchor: string,
  from: number,
  strict: boolean,
): number | null {
  for (const tier of tiersToTry(strict)) {
    const key = tierKey(anchor, tier);
    for (let i = from; i < fileLines.length; i += 1) {
      if (tierKey(fileLines[i]!, tier) === key) return i;
    }
  }
  return null;
}

/**
 * One line of a replacement block. `ctx` is the index of the old line it
 * is a context line of, or -1 when it is a fresh line of the new block.
 */
export interface NewLine {
  ctx: number;
  text: string;
}

/**
 * The lines that replace the matched block at `pos`: context lines as the
 * file's own matched lines, other lines re-indented at tier 2 (see above).
 * With no old lines there is nothing to re-indent from, so new lines are
 * written as they are.
 */
export function renderReplacement(
  fileLines: string[],
  oldLines: string[],
  newLines: NewLine[],
  pos: number,
  tier: Tier,
): string[] {
  if (oldLines.length === 0) {
    return newLines.map((n) => (n.ctx >= 0 ? fileLines[pos + n.ctx]! : n.text));
  }
  const f = leadingWs(fileLines[pos]!);
  const p = leadingWs(oldLines[0]!);
  return newLines.map((n) => {
    if (n.ctx >= 0) return fileLines[pos + n.ctx]!;
    if (tier !== 2) return n.text;
    if (n.text === '' || n.text.trim() === '') return n.text;
    if (!n.text.startsWith(p)) return n.text;
    return f + n.text.slice(p.length);
  });
}

/**
 * Splice a replacement into a file's lines: the `oldLines` at `pos` give
 * way to the rendered new lines. Returns the new lines.
 */
export function spliceReplacement(
  fileLines: string[],
  oldLines: string[],
  newLines: NewLine[],
  pos: number,
  tier: Tier,
): string[] {
  const rendered = renderReplacement(fileLines, oldLines, newLines, pos, tier);
  const out = [...fileLines];
  out.splice(pos, oldLines.length, ...rendered);
  return out;
}
