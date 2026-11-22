# mend — one patch tool for every AI edit format

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/slow-respon/mend-cli-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/slow-respon/mend-cli-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

Built for the [make.fun bounty "Build mend, one patch tool for every AI edit format"](https://make.fun/bounty/hidden-spec-cli-01-run-20261122) ($100 in USDC).

Agent harnesses apply edits that models write, and models write them in four
formats: a unified diff (often with wrong line numbers), SEARCH/REPLACE
blocks, the V4A patch format, and text-editor tool calls as JSON. `mend` is
one command-line tool that reads all four to one written specification
(`SPEC.md`), finds the lines an edit names even when the model drifted their
whitespace or indentation, and changes every file or none.

## Run it

Node 22, standard library alone — nothing to install:

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

- The working directory is the root of the tree. Every path in a patch is
  relative to it.
- `PATCH` is the path of the patch file; when absent or `-`, the patch is
  read from standard input.
- `--format=NAME` reads the patch in one format: `unified`,
  `search-replace`, `v4a` or `json`; `auto`, the default, detects it.
- `--check` does everything but write: the same output and exit code as
  without it, and no file is created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).

Edits are matched at the first of three tiers at which their old lines
occur: exact, ignoring trailing spaces and tabs, ignoring leading and
trailing spaces and tabs — with new lines re-indented to the file's own
indentation at the third tier. A unified hunk takes the occurrence nearest
its (often wrong) line number. Every edit of a patch runs, every failure is
reported, and when any edit failed no file is written at all.

## Exit codes and output

- Exit 2, one `error:` line: usage, unreadable patch file, undetected
  format, or a parse fault (`error: parse <N>`).
- Exit 1, one `error: <code> <path>` line per failed edit, then
  `failed: <k> of <n> edits`. Codes: `no-match`, `ambiguous`, `missing`,
  `exists`, `unsafe`.
- Exit 0: one line per changed path (`A`/`D`/`M`, or `R <old> -> <new>` for
  a move), then `ok: <n> files`.

## Files

- `main.ts` — the CLI.
- `runner.ts` — the kit's trial runner (kept as it is).
- `check.ts` — runs the 100 public practice checks on `main.ts`:
  `node check.ts <practice.json>` from the kit.
- `SPEC.md` — the whole specification.
- `LICENSE` — MIT.
