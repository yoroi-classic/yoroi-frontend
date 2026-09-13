# TypeScript ESLint baseline

`typescript-eslint-baseline.json` is the reviewed per-rule ceiling for the
non-clean rules listed in `typescript-eslint-baseline-rules.js`. The normal
`npm run eslint` command activates those rules as debt warnings in the same
flat-config block used by CI, counts them during its single full-tree lint
traversal, and fails if any rule grows. Every untracked ESLint error still
fails immediately.

Full-tree linting uses `TSESTREE_SINGLE_RUN=true` explicitly in both the
baseline checker and `eslint-loud`. This is the canonical parser mode for
reviewed counts and raw diagnostics. The in-memory lint mutation contract is
the only exception: it disables single-run inference so each supplied source
string is parsed instead of reusing an on-disk Program.

When a count decreases, the check passes and prints the lower observed value.
Lower the corresponding JSON value in the same cleanup pull request so the
improvement cannot regress. Adding or removing a tracked rule requires an
intentional matching edit to both files; mismatched keys fail before linting.
