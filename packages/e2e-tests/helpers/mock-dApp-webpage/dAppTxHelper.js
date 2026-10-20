import * as CML from '@dcspark/cardano-multiplatform-lib-nodejs';
import { protocolParams } from './networkConfig.js';

export function bytesToHex(bytes) {
  return Buffer.from(bytes).toString('hex');
}

export function hexToBytes(hex) {
  return Buffer.from(hex, 'hex');
}

export function multiassetToJSONs(multiAsset) {
  const result = [];
  if (multiAsset == null) return result;

  const policyIds = multiAsset.keys();
  for (let i = 0; i < policyIds.len(); i++) {
    const policyId = policyIds.get(i);
    const assets = multiAsset.get_assets(policyId);
    if (assets == null) continue;
    const assetNames = assets.keys();
    const assetsJSON = {};
    for (let j = 0; j < assetNames.len(); j++) {
      const assetName = assetNames.get(j);
      assetsJSON[`${policyId.to_hex()}.${bytesToHex(assetName.to_raw_bytes())}`] = assets.get(assetName).toString();
    }
    result.push(assetsJSON);
  }
  return result;
}

export const getTxBuilder = () => {
  const config = CML.TransactionBuilderConfigBuilder.new()
    .fee_algo(CML.LinearFee.new(BigInt(protocolParams.linearFee.minFeeA), BigInt(protocolParams.linearFee.minFeeB), 0n))
    .pool_deposit(BigInt(protocolParams.poolDeposit))
    .key_deposit(BigInt(protocolParams.keyDeposit))
    .coins_per_utxo_byte(BigInt(protocolParams.coinsPerUtxoWord) / 8n)
    .max_value_size(protocolParams.maxValueSize)
    .max_tx_size(protocolParams.maxTxSize)
    .ex_unit_prices(CML.ExUnitPrices.new(CML.Rational.new(577n, 10000n), CML.Rational.new(721n, 10000000n)))
    .collateral_percentage(150)
    .max_collateral_inputs(3)
    .build();
  return CML.TransactionBuilder.new(config);
};

export const getCmlUtxo = utxoHex => CML.TransactionUnspentOutput.from_cbor_hex(utxoHex);

export const getCmlUtxos = utxosHex => utxosHex.map(getCmlUtxo);

export const addCmlUtxosToBuilder = (txBuilder, utxosHex) => {
  for (const utxo of getCmlUtxos(utxosHex)) {
    txBuilder.add_utxo(CML.SingleInputBuilder.from_transaction_unspent_output(utxo).payment_key());
  }
};

export const getCmlValue = valueHex => CML.Value.from_cbor_hex(valueHex);

export const getAmountInHex = amount => CML.Value.from_coin(BigInt(amount)).to_cbor_hex();

export const getLargestFirstMultiAsset = () => CML.CoinSelectionStrategyCIP2.LargestFirstMultiAsset;

export const getTransactionOutput = (outputAddress, buildTransactionInput) =>
  CML.SingleOutputBuilderResult.new(
    CML.TransactionOutput.new(outputAddress, CML.Value.from_coin(BigInt(buildTransactionInput.amount)))
  );

export const getAddressFromBytes = addressHex => CML.Address.from_hex(addressHex);

export const getAddressFromBech32 = addressBech32 => CML.Address.from_bech32(addressBech32);

export const getRewardKeyHashFromBech32 = rewardAddressBech32 => {
  const credential = CML.Address.from_bech32(rewardAddressBech32).payment_cred();
  const hash = credential?.as_pub_key();
  if (hash == null) throw new Error('Reward address does not contain a key credential');
  return hash.to_hex();
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

export const getPubKeyHash = address => {
  const credential = address.payment_cred();
  const hash = credential?.as_pub_key();
  if (hash == null) throw new Error('Address does not contain a key payment credential');
  return hash;
};

export const addressToCbor = address => CML.Address.from_bech32(address).to_hex();

export const addressesFromCborIfNeeded = addresses => addresses.map(addressHex => CML.Address.from_hex(addressHex).to_bech32());

export const mapCborUtxos = cborUtxos => cborUtxos.map(hex => {
  const utxo = getCmlUtxo(hex);
  const input = utxo.input();
  const output = utxo.output();
  const value = output.amount();
  return {
    utxo_id: `${input.transaction_id().to_hex()}${input.index()}`,
    tx_hash: input.transaction_id().to_hex(),
    tx_index: Number(input.index()),
    receiver: output.address().to_bech32(),
    amount: value.coin().toString(),
    assets: (multiassetToJSONs(value.multi_asset()).flatMap(policyAssets => Object.entries(policyAssets).map(([assetId, amount]) => {
      const [policyId, name] = assetId.split('.');
      return { policyId, name, amount, assetId };
    }))),
  };
});

export const signTxWithCML = (unsignedTxHex, witnessHex) => {
  const unsignedTransaction = getTransactionFromBytes(unsignedTxHex);
  const witnessSet = getTransactionWitnessSetFromBytes(witnessHex);
  return getSignedTransaction(unsignedTransaction, witnessSet).to_cbor_hex();
};

export const getPublicKeyHash = publicKeyHex => CML.PublicKey.from_bytes(hexToBytes(publicKeyHex)).hash();

export const getDRepIDHexAndBechFromHex = publicKeyHex => {
  const hash = getPublicKeyHash(publicKeyHex);
  return { dRepIDHex: hash.to_hex(), dRepIDBech32: hash.to_bech32('drep') };
};
