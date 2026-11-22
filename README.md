# mend: one patch tool for every AI edit format

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/slow-respon/mend-cli-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/slow-respon/mend-cli-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

`mend` applies an edit that an AI model wrote to a tree of text files. Models
write edits in four formats: a unified diff (often with wrong line numbers),
SEARCH/REPLACE blocks, the V4A patch format, and text-editor tool calls as
JSON. `mend` reads all four to one specification (`SPEC.md`), finds the lines
an edit names even when the model drifted their whitespace or indentation,
and changes every file or none.

## Usage

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

- The working directory is the root of the tree. Every path in a patch is
  relative to it.
- `PATCH` is the path of the patch file, relative to the working directory.
  When `PATCH` is absent or is `-`, the patch is read from standard input.
- `--format=NAME` reads the patch in one format: `unified`,
  `search-replace`, `v4a` or `json`; `auto`, the default, detects it.
- `--check` does everything but write: the same output and exit code as
  without it, and no file is created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).
- Options and `PATCH` may come in any order. `--` ends the options.

## Matching

An edit's old lines are found at the first of three tiers at which they
occur at least once: exact, trailing whitespace ignored, then leading and
trailing whitespace ignored (with new lines re-indented to the file's own
indentation). A unified hunk takes the occurrence nearest to the line number
it names; a SEARCH/REPLACE block fails as ambiguous when its old lines occur
more than once; a V4A chunk follows a cursor through the file.

## Atomicity

Edits apply in the patch's order to the tree as earlier edits left it. A
failed edit changes nothing, and the edits after it still run, so every
failure is reported. When any edit failed, no file is written (exit 1).
When none failed, every change is written (exit 0), or with `--check` none
is.

## Requirements

Node 22 and its standard library alone; nothing is installed before the
program runs. Deterministic: the same check gives the same exit code,
stdout and files every run.

## Files

- `main.ts`: the CLI.
- `runner.ts`: the kit's runner (kept as it is).
- `check.ts`: the practice set on your own machine:

      node check.ts <practice.json>

- `SPEC.md`: the whole specification.
- `LICENSE`: MIT.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
