# Testing Yoroi

Use Node.js 22.22.2 and npm 10.9.7, as declared by the repository root
`.nvmrc` and `package.json`. Complete [SETUP.md](./SETUP.md) before running the
checks below.

GitHub Actions runs these checks as separate jobs. The commands here provide
the equivalent local signals in sequence.

## Core checks

Run the repository-wide checks from the repository root:

```bash
npm run check:toolchain
npm run flow
npm run eslint
npm run tsc
npm run test
npm run fmt:check
```

To focus on the extension after installing dependencies, run from
`packages/yoroi-extension`:

```bash
npm run flow
npm run eslint
npm run tsc
npm run test -- --runInBand
```

## Extension build smoke check

The CI build-smoke job first verifies that the extension smoke specifications
can be discovered, then builds the test extension:

```bash
cd packages/e2e-tests
npm run test:ext:smoke:dry-run

cd ../yoroi-extension
npm run prod:build -- --env test --isE2E
test -f build/js/inject.js
```

The smoke-spec command is a dry run; it validates test discovery without
launching a browser or contacting wallet services. The build uses the checked-in
test configuration and does not require a production signing key.

## Focused unit tests

Jest accepts a file or pattern after `--`. For example, from
`packages/yoroi-extension`:

```bash
npm run test -- --runInBand path/to/example.test.js
```

Run the full relevant checks before requesting review, even when a focused test
passes.
