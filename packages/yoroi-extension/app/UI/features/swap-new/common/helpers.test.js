// @flow
import '../../../../api/ada/lib/test-config.forTests';
import { RustModule } from '../../../../api/ada/lib/cardanoCrypto/rustLoader';
import { useGetInputs } from './helpers';

beforeAll(async () => {
  await RustModule.load();
});

test('swap input conversion preserves legacy UTxO CBOR for ADA, assets, datum, and script references', async () => {
  // Frozen bytes captured from the prior serialized UTxO contract. The fixture
  // keeps the historical native script-ref and inline datum wire shape without
  // requiring the retired serialization package as a test oracle.
  const fixture = {
    address: '6011111111111111111111111111111111111111111111111111111111',
    datumCborHex: '182a',
    scriptRefCborHex: 'd818582282008200581c22222222222222222222222222222222222222222222222222222222',
    expected:
      '82825820333333333333333333333333333333333333333333333333333333333333333307a400581d601111111111111111111111111111111111111111111111111111111101821a001e8480a1581c44444444444444444444444444444444444444444444444444444444a142aabb03028201d81842182a03d818582282008200581c22222222222222222222222222222222222222222222222222222222',
  };
  const inputs = await useGetInputs([
    {
      address: fixture.address,
      output: {
        Transaction: { Hash: '33'.repeat(32) },
        UtxoTransactionOutput: { OutputIndex: 7 },
        tokens: [
          { Token: { Identifier: '.', Metadata: { ticker: 'ADA' } }, TokenList: { Amount: '2000000' } },
          {
            Token: { Identifier: '44'.repeat(28) + '.aabb', Metadata: { policyId: '44'.repeat(28), assetName: 'aabb' } },
            TokenList: { Amount: '3' },
          },
        ],
        inlineDatumCborHex: fixture.datumCborHex,
        scriptRefCborHex: fixture.scriptRefCborHex,
      },
    },
  ]).getInputs();
  expect(inputs).toEqual([fixture.expected]);
});
