import * as CML from '@dcspark/cardano-multiplatform-lib-nodejs';
import { protocolParams } from './networkConfig.js';

export function bytesToHex(bytes) {
  return Buffer.from(bytes).toString('hex');
}

export function hexToBytes(hex) {
  return Buffer.from(hex, 'hex');
}

const asBigInt = (value, field) => {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) {
    throw new Error(`${field} must be a safe integer`);
  }

  const encoded = String(value);
  if (!/^(0|[1-9][0-9]*)$/.test(encoded)) {
    throw new Error(`${field} must be a non-negative integer`);
  }

  return BigInt(encoded);
};

export const toInt = value => CML.Int.new(asBigInt(value, 'integer'));

export const getTxBuilder = () => {
  const coinsPerUtxoWord = asBigInt(protocolParams.coinsPerUtxoWord, 'coinsPerUtxoWord');
  return CML.TransactionBuilder.new(
    CML.TransactionBuilderConfigBuilder.new()
      .fee_algo(
        CML.LinearFee.new(
          asBigInt(protocolParams.linearFee.minFeeA, 'minFeeA'),
          asBigInt(protocolParams.linearFee.minFeeB, 'minFeeB'),
          0n
        )
      )
      .pool_deposit(asBigInt(protocolParams.poolDeposit, 'poolDeposit'))
      .key_deposit(asBigInt(protocolParams.keyDeposit, 'keyDeposit'))
      .coins_per_utxo_byte(coinsPerUtxoWord / 8n)
      .max_value_size(protocolParams.maxValueSize)
      .max_tx_size(protocolParams.maxTxSize)
      .ex_unit_prices(CML.ExUnitPrices.new(CML.Rational.new(577n, 10000n), CML.Rational.new(721n, 10000000n)))
      .collateral_percentage(150)
      .max_collateral_inputs(3)
      .cost_models(CML.CostModels.from_json('{}'))
      .build()
  );
};

export const getCmlUtxo = utxoHex => CML.TransactionUnspentOutput.from_cbor_hex(utxoHex);

export const getCmlUtxos = utxosHex => utxosHex.map(getCmlUtxo);

export const getCmlValue = valueHex => CML.Value.from_cbor_hex(valueHex);

export const getAmountInHex = amount => CML.Value.from_coin(asBigInt(amount, 'amount')).to_cbor_hex();

export const getLargestFirstMultiAsset = () => CML.CoinSelectionStrategyCIP2.LargestFirstMultiAsset;

export const getTransactionOutput = (outputAddress, buildTransactionInput) =>
  CML.TransactionOutputBuilder.new()
    .with_address(outputAddress)
    .next()
    .with_value(CML.Value.from_coin(asBigInt(buildTransactionInput.amount, 'transaction output amount')))
    .build();

export const getAddressFromBytes = addressHex => CML.Address.from_raw_bytes(hexToBytes(addressHex));

export const getAddressFromBech32 = addressBech32 => CML.Address.from_bech32(addressBech32);

export const getRewardKeyHashFromBech32 = rewardAddressBech32 => {
  const rewardAddress = CML.RewardAddress.from_address(CML.Address.from_bech32(rewardAddressBech32));
  const keyHash = rewardAddress?.payment().as_pub_key();
  if (keyHash == null) throw new Error('Reward address has no payment key hash');
  return keyHash.to_hex();
};

export const getTransactionFromBytes = txHex => CML.Transaction.from_cbor_hex(txHex);

export const getTransactionWitnessSetFromBytes = witnessHex => CML.TransactionWitnessSet.from_cbor_hex(witnessHex);

export const getSignedTransaction = (unsignedTransaction, witnessSet) =>
  CML.Transaction.new(
    unsignedTransaction.body(),
    witnessSet,
    unsignedTransaction.is_valid(),
    unsignedTransaction.auxiliary_data()
  );

export const getPubKeyHash = usedAddress => {
  const baseAddress = CML.BaseAddress.from_address(usedAddress);
  const keyHash = baseAddress?.payment().as_pub_key();
  if (keyHash == null) throw new Error('Address has no payment key hash');
  return keyHash;
};

export const getNativeScript = pubKeyHash => CML.NativeScript.new_script_pubkey(pubKeyHash);

export const getTransactionOutputBuilder = changeAddress => CML.TransactionOutputBuilder.new().with_address(changeAddress).next();

export const getAssetName = assetNameString => CML.AssetName.from_raw_bytes(Buffer.from(assetNameString, 'utf8'));

export const addressToCbor = address => CML.Address.from_bech32(address).to_hex();

export const addressesFromCborIfNeeded = addresses => addresses.map(addressHex => CML.Address.from_hex(addressHex).to_bech32());

const reduceCmlMultiAsset = (multiAsset, reducer, initValue) => {
  let result = initValue;
  if (multiAsset) {
    const policyIds = multiAsset.keys();
    for (let i = 0; i < policyIds.len(); i += 1) {
      const policyId = policyIds.get(i);
      const assets = multiAsset.get_assets(policyId);
      if (assets) {
        const assetNames = assets.keys();
        for (let j = 0; j < assetNames.len(); j += 1) {
          const assetName = assetNames.get(j);
          const amount = assets.get(assetName);
          const policyIdHex = policyId.to_hex();
          const encodedName = assetName.to_hex();
          result = reducer(result, {
            policyId: policyIdHex,
            name: encodedName,
            amount: amount?.toString(),
            assetId: `${policyIdHex}.${encodedName}`,
          });
        }
      }
    }
  }

  return result;
};

export const cmlMultiassetToJSONs = multiAsset => {
  const assetValue = [];
  const policyIds = multiAsset?.keys();
  for (let i = 0; i < (policyIds?.len() ?? 0); i += 1) {
    const policyId = policyIds.get(i);
    const assets = multiAsset.get_assets(policyId);
    const assetNames = assets?.keys();
    const assetsJSON = {};
    for (let j = 0; j < (assetNames?.len() ?? 0); j += 1) {
      const assetName = assetNames.get(j);
      const amount = assets.get(assetName);
      assetsJSON[`${policyId.to_hex()}.${assetName.to_hex()}`] = amount?.toString();
    }
    assetValue.push(assetsJSON);
  }
  return assetValue;
};

export const mapCborUtxos = cborUtxos =>
  cborUtxos.map(hex => {
    const utxo = getCmlUtxo(hex);
    const input = utxo.input();
    const output = utxo.output();
    const txHash = input.transaction_id().to_hex();
    const txIndex = input.index().toString();
    const value = output.amount();
    return {
      utxo_id: `${txHash}${txIndex}`,
      tx_hash: txHash,
      tx_index: txIndex,
      receiver: output.address().to_bech32(),
      amount: value.coin().toString(),
      assets: reduceCmlMultiAsset(
        value.multi_asset(),
        (result, asset) => {
          result.push(asset);
          return result;
        },
        []
      ),
    };
  });

export const signTxWithCML = (unsignedTxHex, witnessHex) => {
  const unsignedTransaction = getTransactionFromBytes(unsignedTxHex);
  const witnessSet = getTransactionWitnessSetFromBytes(witnessHex);
  return bytesToHex(getSignedTransaction(unsignedTransaction, witnessSet).to_cbor_bytes());
};

export const getPubKeyHashFromHex = pubKeyHex => CML.PublicKey.from_bytes(hexToBytes(pubKeyHex)).hash();

export const getDRepIDHexAndBechFromHex = pubDRepKey => {
  const dRepIdHash = getPubKeyHashFromHex(pubDRepKey);
  return {
    dRepIDHex: dRepIdHash.to_hex(),
    dRepIDBech32: dRepIdHash.to_bech32('drep'),
  };
};
