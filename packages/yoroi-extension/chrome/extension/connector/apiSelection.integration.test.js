// @flow

import '../../../app/api/ada/lib/test-config.forTests';
import { RustModule } from '../../../app/api/ada/lib/cardanoCrypto/rustLoader';

describe('connectorGetUtxosCardano CML selection', () => {
  test('returns token-bearing UTxOs for a serialized multiasset value', async () => {
    await RustModule.load();
    const fixture = RustModule.WasmScope(Module => {
      const cml = Module.CML;
      const policyId = cml.NativeScript.new_script_pubkey(cml.Ed25519KeyHash.from_hex('44'.repeat(28))).hash().to_hex();
      const assetName = '74657374';
      const multiAsset = cml.MultiAsset.new();
      const assets = cml.MapAssetNameToCoin.new();
      assets.insert(cml.AssetName.from_hex(assetName), 2n);
      multiAsset.insert_assets(cml.ScriptHash.from_hex(policyId), assets);
      return {
        address: cml.EnterpriseAddress.new(
          1,
          cml.Credential.new_pub_key(cml.Ed25519KeyHash.from_hex('11'.repeat(28)))
        ).to_address().to_hex(),
        policyId,
        assetName,
        valueHex: cml.Value.new(1000000n, multiAsset).to_cbor_hex(),
      };
    });
    const tokenId = `${fixture.policyId}.${fixture.assetName}`;
    const dbUtxos = ['1', '2'].map((hash, index) => ({
      address: fixture.address,
      addressing: { path: [0, index], startLevel: 3 },
      output: {
        tokens: [
          { Token: { Identifier: '' }, TokenList: { Amount: '5000000' } },
          { Token: { Identifier: tokenId }, TokenList: { Amount: '1' } },
        ],
        Transaction: { Hash: hash.repeat(64) },
        UtxoTransactionOutput: { OutputIndex: 0 },
      },
    }));
    jest.doMock('../../../app/api/ada/lib/storage/models/PublicDeriver/traits', () => {
      const actual = jest.requireActual('../../../app/api/ada/lib/storage/models/PublicDeriver/traits');
      return {
        ...actual,
        asGetAllUtxos: wallet => ({ getAllUtxos: async () => wallet.testUtxos }),
      };
    });
    jest.doMock('../../../app/api/localStorage', () => {
      const actual = jest.requireActual('../../../app/api/localStorage');
      return { ...actual, loadSubmittedTransactions: async () => [] };
    });
    jest.doMock('../../../app/api/ada', () => {
      const actual = jest.requireActual('../../../app/api/ada');
      return {
        __esModule: true,
        ...actual,
        default: class {
          utxosWithSubmittedTxs(utxos) { return utxos; }
        },
      };
    });
    const { connectorGetUtxosCardano } = require('./api');
    const result = await connectorGetUtxosCardano(
      { publicDeriverId: 1, testUtxos: dbUtxos },
      fixture.valueHex,
      null,
      '4310'
    );

    expect(result).toHaveLength(2);
    expect(result.every(utxo => utxo.assets.some(asset => asset.assetId === tokenId))).toBe(true);
  });
});
