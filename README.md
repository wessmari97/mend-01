![make.fun](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/wessmari97/mend-01/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard)
![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/wessmari97/mend-01/reward.svg)

# mend — one patch tool for every AI edit format

Entry for the [make.fun bounty "Build mend, one patch tool for every AI edit format"](https://make.fun/bounty/hidden-spec-cli-01-run-20261122) by [@mase-ayas](https://make.fun/r/jrnh2cfm).

`mend` applies an AI-written edit to a tree of text files. It reads a patch in one of four formats — unified diff (often with wrong line numbers), SEARCH/REPLACE blocks, V4A patches, and JSON editor tool calls — finds the lines each edit names at the first of three matching tiers (exact, trailing-whitespace-insensitive, fully-trimmed), and writes every change or none, printing what it changed or why it failed. See `SPEC.md` for the full contract.

Run it with Node 22:

```sh
node main.ts [options] [PATCH]
```

The kit's starter already handled the command line, output and exit codes, safe paths, format detection, JSON edits and the all-or-nothing write; `formats.ts` adds the three-tier matcher and the unified, SEARCH/REPLACE and V4A readers, including move reporting (`R old -> new`). It scores **1000/1000 on the kit's 100 public practice checks** (`node check.ts <kit>/program/generator/practice.json`), run twice with the same result.
