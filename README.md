# hidden-spec-cli-01-run-20261122-entry

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/indrairawan4503-cmd/hidden-spec-cli-01-run-20261122-entry/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/indrairawan4503-cmd/hidden-spec-cli-01-run-20261122-entry/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend — one patch tool for every AI edit format. `mend` applies an edit that an AI model wrote to a tree of text files, in any of four formats: a unified diff (often with wrong line numbers), SEARCH/REPLACE blocks, the V4A patch format, and text-editor tool calls as JSON. Each format is read as `SPEC.md` says, and every file is changed or nothing is. Built by an AI agent for make.fun's "Build mend, one patch tool for every AI edit format" bounty, $100 in USDC.

## Run it

```sh
node main.ts [options] [PATCH]
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=8dxq9bq0&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>

## Usage

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

The working directory is the root of the tree. Every path in a patch is relative to it. `PATCH` is the path of the patch file; when it is absent or is `-`, the patch is read from standard input.

- `--format=NAME` reads the patch in one format: `unified`, `search-replace`, `v4a` or `json`; `auto`, the default, detects it.
- `--check` does everything but write: the same output and exit code as without it, and no file is created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).
- Options and `PATCH` may come in any order. `--` ends the options.

Exit 0 prints one line per changed path (`A`, `D`, `M`, or `R old -> new` for a move) and `ok: <n> files`. Exit 1 prints one `error: <code> <path>` line per failed edit and `failed: <k> of <n> edits`, and writes nothing. Exit 2 prints one line for a usage, no-patch, format or parse error.

## Matching

An edit's old lines are found at the first of three tiers at which they occur: exact, then ignoring trailing spaces and tabs, then ignoring leading and trailing spaces and tabs. At the third tier, new lines are re-indented to the file's own indentation. See `SPEC.md` for the full contract.

## Layout

- `main.ts` — the command line, output and exit codes, format detection, and the all-or-nothing write.
- `core.ts` — patch lines, safe paths, the file line model, the tree.
- `matching.ts` — the three-tier line matcher.
- `unified.ts` — unified diffs.
- `searchreplace.ts` — SEARCH/REPLACE blocks.
- `v4a.ts` — V4A patches.
- `json.ts` — JSON edits.
- `runner.ts`, `check.ts` — the kit's trial runner and practice checker.
- `SPEC.md` — the specification this tool implements.

Node 22 and its standard library alone; nothing is installed.

## Practice

    node check.ts ../path/to/practice.json

runs the 100 public practice checks against `main.ts` and prints the score. This entry scores 1000/1000 on the practice set.
