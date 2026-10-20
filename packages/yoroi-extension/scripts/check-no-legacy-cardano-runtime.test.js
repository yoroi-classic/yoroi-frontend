const { scanWorkspace, sourceFindings } = require('./check-no-legacy-cardano-runtime');

test('extension and E2E sources and package graphs contain no legacy serialization bridge', () => {
  expect(scanWorkspace()).toEqual([]);
});

test('finds old package imports and runtime bridge symbols', () => {
  expect(sourceFindings('import * as CSL from \'@emurgo/cardano-serialization-lib-browser\';', 'fixture.js')).toContain(
    'fixture.js: @emurgo/cardano-serialization-lib-browser'
  );
  expect(sourceFindings('const csl = RustModule.WalletV4;', 'fixture.js')).toContain('fixture.js: WalletV4');
  expect(sourceFindings('const builder = Module.CSL.TransactionBuilder;', 'fixture.js')).toContain('fixture.js: Module.CSL');
});

test('does not flag the local CML bridge or unrelated Emurgo protocols', () => {
  expect(
    sourceFindings(
      'import * as CML from \'@dcspark/cardano-multiplatform-lib-browser\'; import { sign } from \'@emurgo/cardano-message-signing-browser\';',
      'fixture.js'
    )
  ).toEqual([]);
});
