// @flow

import '../../../app/api/ada/lib/test-config.forTests';
import { RustModule } from '../../../app/api/ada/lib/cardanoCrypto/rustLoader';
import { NotEnoughMoneyToSendError } from '../../../app/api/common/errors';

describe('CML connector UTxO selection', () => {
  let selectCmlUtxosForValue;
  let addressHex;
  let policyId;
  let assetName;

  beforeAll(async () => {
    ({ selectCmlUtxosForValue } = require('./api'));
    await RustModule.load();
    ({ addressHex, policyId, assetName } = RustModule.WasmScope(Module => {
      const cml = Module.CML;
      return {
        addressHex: cml.EnterpriseAddress.new(
          1,
          cml.Credential.new_pub_key(cml.Ed25519KeyHash.from_hex('11'.repeat(28)))
        ).to_address().to_hex(),
        policyId: cml.NativeScript.new_script_pubkey(cml.Ed25519KeyHash.from_hex('22'.repeat(28))).hash().to_hex(),
        assetName: '74657374',
      };
    }));
  });

  function adaUtxo(hash: string, amount: string) {
    return {
      amount,
      receiver: addressHex,
      tx_hash: hash.repeat(64),
      tx_index: 0,
      utxo_id: `${hash.repeat(64)}0`,
      assets: [],
    };
  }

  test('selects sufficient ADA UTxOs and rejects insufficient funds', async () => {
    const selected = await selectCmlUtxosForValue(
      [adaUtxo('a', '2000000'), adaUtxo('b', '8000000')],
      '5000000',
      '4310'
    );
    expect(selected.length).toBeGreaterThan(0);
    // eslint-disable-next-line no-undef
    expect(selected.reduce((sum, utxo) => sum + BigInt(utxo.amount), 0n)).toBeGreaterThanOrEqual(5000000n);
    expect(selected.map(utxo => utxo.amount)).toEqual(['8000000']);
    await expect(selectCmlUtxosForValue([adaUtxo('c', '1000000')], '5000000', '4310'))
      .rejects.toThrow(NotEnoughMoneyToSendError);
  });

  test('selects all token-bearing inputs needed for a multiasset value and its minimum ADA', async () => {
    const targetValue = RustModule.WasmScope(Module => {
      const cml = Module.CML;
      const assets = cml.MapAssetNameToCoin.new();
      assets.insert(cml.AssetName.from_hex(assetName), 2n);
      const multiAsset = cml.MultiAsset.new();
      multiAsset.insert_assets(cml.ScriptHash.from_hex(policyId), assets);
      return cml.Value.new(1000000n, multiAsset).to_cbor_hex();
    });
    const makeTokenUtxo = (hash: string) => ({
      ...adaUtxo(hash, '5000000'),
      assets: [{
        amount: '1',
        assetId: `${policyId}.${assetName}`,
        policyId,
        name: assetName,
      }],
    });

    const selected = await selectCmlUtxosForValue(
      [makeTokenUtxo('d'), makeTokenUtxo('e')],
      targetValue,
      '4310'
    );
    expect(selected).toHaveLength(2);
    expect(selected.every(utxo => utxo.assets.length === 1)).toBe(true);
  });

  test('CML LargestFirstMultiAsset selects a balanced multiasset target', async () => {
    await RustModule.load();
    RustModule.WasmScope(Module => {
      const cml = Module.CML;
      const address = cml.Address.from_hex(addressHex);
      const assets = cml.MapAssetNameToCoin.new();
      assets.insert(cml.AssetName.from_hex(assetName), 2n);
      const multiAsset = cml.MultiAsset.new();
      multiAsset.insert_assets(cml.ScriptHash.from_hex(policyId), assets);
      const target = cml.TransactionOutput.new(address, cml.Value.new(5000000n, multiAsset));
      const config = cml.TransactionBuilderConfigBuilder.new()
        .fee_algo(cml.LinearFee.new(44n, 155381n, 0n))
        .coins_per_utxo_byte(4310n)
        .pool_deposit(500000000n)
        .key_deposit(2000000n)
        .max_value_size(5000)
        .max_tx_size(16384)
        .ex_unit_prices(cml.ExUnitPrices.new(cml.Rational.new(577n, 10000n), cml.Rational.new(721n, 10000000n)))
        .collateral_percentage(150)
        .max_collateral_inputs(3)
        .build();
      const builder = cml.TransactionBuilder.new(config);
      builder.add_output(cml.SingleOutputBuilderResult.new(target));
      for (const hash of ['d', 'e']) {
        const txInput = cml.TransactionInput.new(cml.TransactionHash.from_hex(hash.repeat(64)), 0n);
        const utxoOutput = cml.TransactionOutput.new(address, cml.Value.new(5000000n, (() => {
          const inputAssets = cml.MapAssetNameToCoin.new();
          inputAssets.insert(cml.AssetName.from_hex(assetName), 1n);
          const inputMulti = cml.MultiAsset.new();
          inputMulti.insert_assets(cml.ScriptHash.from_hex(policyId), inputAssets);
          return inputMulti;
        })()));
        builder.add_utxo(cml.SingleInputBuilder.new(txInput, utxoOutput).payment_key());
      }
      const surplusInput = cml.TransactionInput.new(cml.TransactionHash.from_hex('f'.repeat(64)), 0n);
      const surplusOutput = cml.TransactionOutput.new(address, cml.Value.from_coin(20000000n));
      builder.add_utxo(cml.SingleInputBuilder.new(surplusInput, surplusOutput).payment_key());
      builder.select_utxos(cml.CoinSelectionStrategyCIP2.LargestFirstMultiAsset);
      const total = builder.get_total_input();
      // The selector must not consume the large pure-ADA candidate when the
      // two smaller inputs already cover the asset target.
      expect(total.coin().toString()).toBe('10000000');
      const selectedAssets = total.multi_asset().get_assets(cml.ScriptHash.from_hex(policyId));
      expect(selectedAssets.get(cml.AssetName.from_hex(assetName)).toString()).toBe('2');
      const minAda = cml.min_ada_required(target, 4310n);
      expect(target.amount().coin()).toBeGreaterThanOrEqual(minAda);
      expect(builder.add_change_if_needed(address, false)).toBe(true);
      const built = builder.build(cml.ChangeSelectionAlgo.Default, address);
      const body = built.body();
      expect(body.inputs().len()).toBe(2);
      expect(body.outputs().len()).toBeGreaterThanOrEqual(2);
      const outputTotal = Array.from({ length: body.outputs().len() }, (_, index) => body.outputs().get(index).amount().coin())
        .reduce((sum, coin) => sum + coin, 0n);
      // eslint-disable-next-line no-undef
      expect(total.coin() - outputTotal).toBeGreaterThanOrEqual(BigInt(body.fee().toString()));
      // eslint-disable-next-line no-undef
      expect(BigInt(body.fee().toString())).toBeGreaterThanOrEqual(builder.min_fee(false));
    });
  });
});
