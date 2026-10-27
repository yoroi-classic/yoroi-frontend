// @flow
/* global BigInt */

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
        addressHex: cml.EnterpriseAddress.new(1, cml.Credential.new_pub_key(cml.Ed25519KeyHash.from_hex('11'.repeat(28))))
          .to_address()
          .to_hex(),
        policyId: cml.NativeScript.new_script_pubkey(cml.Ed25519KeyHash.from_hex('22'.repeat(28)))
          .hash()
          .to_hex(),
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
    const selected = await selectCmlUtxosForValue([adaUtxo('a', '2000000'), adaUtxo('b', '8000000')], '5000000', '4310');
    expect(selected.length).toBeGreaterThan(0);
    expect(selected.map(utxo => utxo.amount)).toEqual(['8000000']);
    await expect(selectCmlUtxosForValue([adaUtxo('c', '1000000')], '5000000', '4310')).rejects.toThrow(NotEnoughMoneyToSendError);
  });

  test('uses a collateral-sized ADA UTxO when it is needed to fund the requested value', async () => {
    const candidate = adaUtxo('f', '1900000');
    await expect(selectCmlUtxosForValue([candidate], '1000000', '4310')).resolves.toEqual([candidate]);
  });

  test('selects all token-bearing inputs needed for a multiasset value', async () => {
    const targetValue = RustModule.WasmScope(Module => {
      const cml = Module.CML;
      const assets = cml.MapAssetNameToCoin.new();
      assets.insert(cml.AssetName.from_hex(assetName), BigInt('2'));
      const multiAsset = cml.MultiAsset.new();
      multiAsset.insert_assets(cml.ScriptHash.from_hex(policyId), assets);
      return cml.Value.new(BigInt('1000000'), multiAsset).to_cbor_hex();
    });
    const makeTokenUtxo = (hash: string) => ({
      ...adaUtxo(hash, '5000000'),
      assets: [
        {
          amount: '1',
          assetId: `${policyId}.${assetName}`,
          policyId,
          name: assetName,
        },
      ],
    });

    const selected = await selectCmlUtxosForValue([makeTokenUtxo('d'), makeTokenUtxo('e')], targetValue, '4310');
    expect(selected).toHaveLength(2);
    expect(selected.every(utxo => utxo.assets.length === 1)).toBe(true);
  });

  test('CML LargestFirstMultiAsset avoids an unnecessary pure-ADA input for the token target', async () => {
    await RustModule.load();
    RustModule.WasmScope(Module => {
      const cml = Module.CML;
      const address = cml.Address.from_hex(addressHex);
      const assets = cml.MapAssetNameToCoin.new();
      assets.insert(cml.AssetName.from_hex(assetName), BigInt('2'));
      const multiAsset = cml.MultiAsset.new();
      multiAsset.insert_assets(cml.ScriptHash.from_hex(policyId), assets);
      const target = cml.TransactionOutput.new(address, cml.Value.new(BigInt('5000000'), multiAsset));
      const config = cml.TransactionBuilderConfigBuilder.new()
        .fee_algo(cml.LinearFee.new(BigInt('44'), BigInt('155381'), BigInt('0')))
        .coins_per_utxo_byte(BigInt('4310'))
        .pool_deposit(BigInt('500000000'))
        .key_deposit(BigInt('2000000'))
        .max_value_size(5000)
        .max_tx_size(16384)
        .ex_unit_prices(
          cml.ExUnitPrices.new(
            cml.Rational.new(BigInt('577'), BigInt('10000')),
            cml.Rational.new(BigInt('721'), BigInt('10000000'))
          )
        )
        .collateral_percentage(150)
        .max_collateral_inputs(3)
        .build();
      const builder = cml.TransactionBuilder.new(config);
      builder.add_output(cml.SingleOutputBuilderResult.new(target));
      for (const hash of ['d', 'e']) {
        const txInput = cml.TransactionInput.new(cml.TransactionHash.from_hex(hash.repeat(64)), BigInt('0'));
        const utxoOutput = cml.TransactionOutput.new(
          address,
          cml.Value.new(
            BigInt('5000000'),
            (() => {
              const inputAssets = cml.MapAssetNameToCoin.new();
              inputAssets.insert(cml.AssetName.from_hex(assetName), BigInt('1'));
              const inputMulti = cml.MultiAsset.new();
              inputMulti.insert_assets(cml.ScriptHash.from_hex(policyId), inputAssets);
              return inputMulti;
            })()
          )
        );
        builder.add_utxo(cml.SingleInputBuilder.new(txInput, utxoOutput).payment_key());
      }
      const surplusInput = cml.TransactionInput.new(cml.TransactionHash.from_hex('f'.repeat(64)), BigInt('0'));
      const surplusOutput = cml.TransactionOutput.new(address, cml.Value.from_coin(BigInt('20000000')));
      builder.add_utxo(cml.SingleInputBuilder.new(surplusInput, surplusOutput).payment_key());
      builder.select_utxos(cml.CoinSelectionStrategyCIP2.LargestFirstMultiAsset);
      const total = builder.get_total_input();
      // The selector must not consume the large pure-ADA candidate when the
      // two smaller inputs already cover the asset target.
      expect(total.coin().toString()).toBe('10000000');
      const selectedAssets = total.multi_asset().get_assets(cml.ScriptHash.from_hex(policyId));
      const assetAmount = selectedAssets?.get(cml.AssetName.from_hex(assetName));
      if (assetAmount == null) throw new Error('Missing selected asset');
      expect(assetAmount.toString()).toBe('2');
      const minAda = cml.min_ada_required(target, BigInt('4310'));
      expect(target.amount().coin()).toBeGreaterThanOrEqual(minAda);
      expect(builder.add_change_if_needed(address, false)).toBe(true);
      const built = builder.build(cml.ChangeSelectionAlgo.Default, address);
      const body = built.body();
      expect(body.inputs().len()).toBe(2);
      expect(body.outputs().len()).toBeGreaterThanOrEqual(2);
      const outputTotal = Array.from({ length: body.outputs().len() }, (_, index) =>
        body.outputs().get(index).amount().coin()
      ).reduce((sum, coin) => sum + coin, BigInt('0'));
      expect(total.coin() - outputTotal).toBeGreaterThanOrEqual(BigInt(body.fee().toString()));
      expect(BigInt(body.fee().toString())).toBeGreaterThanOrEqual(builder.min_fee(false));
    });
  });
});
