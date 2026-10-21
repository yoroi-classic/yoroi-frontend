const { scanWorkspace, sourceFindings, SOURCE_DIRECTORIES, ROOT_SOURCE_FILES } = require('./check-no-legacy-cardano-runtime');

test('extension and E2E sources and package graphs contain no legacy serialization bridge', () => {
  expect(scanWorkspace()).toEqual([]);
});

test('finds old package imports and runtime bridge symbols', () => {
  expect(sourceFindings("import * as CSL from '@emurgo/cardano-serialization-lib-browser';", 'fixture.js')).toContain(
    'fixture.js: @emurgo/cardano-serialization-lib-browser'
  );
  expect(sourceFindings('const csl = RustModule.WalletV4;', 'fixture.js')).toContain('fixture.js: WalletV4');
  expect(sourceFindings('const builder = Module.CSL.TransactionBuilder;', 'fixture.js')).toContain('fixture.js: Module.CSL');
  expect(sourceFindings("import crossCsl from '@emurgo/cross-csl-browser';", 'fixture.js')).toContain(
    'fixture.js: @emurgo/cross-csl-browser'
  );
});

test('scans extension and E2E support sources and root configuration files', () => {
  expect(SOURCE_DIRECTORIES).toEqual(
    expect.arrayContaining([
      'packages/yoroi-extension/api',
      'packages/yoroi-extension/config',
      'packages/yoroi-extension/flow',
      'packages/yoroi-extension/posthog',
      'packages/e2e-tests/pages',
      'packages/e2e-tests/utils',
    ])
  );
  expect(ROOT_SOURCE_FILES).toEqual(
    expect.arrayContaining(['packages/yoroi-extension/jestSetup.js', 'packages/yoroi-extension/jest.config.js'])
  );
});

test('does not flag the local CML bridge or unrelated Emurgo protocols', () => {
  expect(
    sourceFindings(
      "import * as CML from '@dcspark/cardano-multiplatform-lib-browser'; import { sign } from '@emurgo/cardano-message-signing-browser';",
      'fixture.js'
    )
  ).toEqual([]);
});
