// @flow

// Handles interfacing w/ cardano-serialization-lib to create transaction

import BigNumber from 'bignumber.js';
import type {
  CardanoAddressedUtxo,
  CardanoUtxoScriptWitness,
  V4UnsignedTxAddressedUtxoResponse,
  V4UnsignedTxUtxoResponse,
} from '../types';
import type { RemoteUnspentOutput } from '../../lib/state-fetch/types';
import {
  AssetOverflowError,
  CannotSendBelowMinimumValueError,
  NotEnoughMoneyToSendError,
  NoOutputsError,
  OversizedTransactionError,
} from '../../../common/errors';

import { RustModule } from '../../lib/cardanoCrypto/rustLoader';

import { Bip44DerivationLevels } from '../../lib/storage/database/walletTypes/bip44/api/utils';
import type { Address, Addressing, IGetAllUtxosResponse } from '../../lib/storage/models/PublicDeriver/interfaces';
import { getCardanoSpendingKeyHash, normalizeToAddress } from '../../lib/storage/bridge/utils';
import { normalizeAddressToHex } from '../../lib/cardanoCrypto/cmlAddress';
import { MultiToken } from '../../../common/lib/MultiToken';
import { PRIMARY_ASSET_CONSTANTS } from '../../lib/storage/database/primitives/enums';
import {
  cardanoValueFromRemoteFormat,
  identifierSplit,
  asAddressedUtxo,
  multiTokenFromRemote,
} from '../utils';
import { iterateLenGet, forceNonNull } from '../../../../coreUtils';
import { getCardanoHaskellBaseConfig, getNetworkById } from '../../lib/storage/database/prepackaged/networks';
import { builtSendTokenList } from '../../../common';
import type { TokenRow } from '../../lib/storage/database/primitives/tables';
import blake2b from 'blake2b';
import { derivePrivateByAddressing } from '../../lib/cardanoCrypto/deriveByAddressing';
import { PublicDeriver } from '../../lib/storage/models/PublicDeriver';
import { asGetAllAccounting, asGetSigningKey } from '../../lib/storage/models/PublicDeriver/traits';
import { genOwnStakingKey } from '../../staking';
import { getStakingKeyHashesInTransactionBody } from '../../lib/cardanoCrypto/utils';
import { getAllAddressesForWallet } from '../../lib/storage/bridge/traitUtils';

// <TODO:FETCH> unmagic this
const COSTMODELS =
  'a30098a61a000189b41901a401011903e818ad00011903e819ea350401192baf18201a000312591920a404193e801864193e801864193e801864193e801864193e801864193e80186418641864193e8018641a000170a718201a00020782182019f016041a0001194a18b2000119568718201a0001643519030104021a00014f581a00037c71187a0001011903e819a7a90402195fe419733a1826011a000db464196a8f0119ca3f19022e011999101903e819ecb2011a00022a4718201a000144ce1820193bc318201a0001291101193371041956540a197147184a01197147184a0119a9151902280119aecd19021d0119843c18201a00010a9618201a00011aaa1820191c4b1820191cdf1820192d1a18201a00014f581a00037c71187a0001011a0001614219020700011a000122c118201a00014f581a00037c71187a0001011a00014f581a00037c71187a0001011a0004213c19583c041a00163cad19fc3604194ff30104001a00022aa818201a000189b41901a401011a00013eff182019e86a1820194eae182019600c1820195108182019654d182019602f18201a032e93af1937fd0a0198af1a000189b41901a401011903e818ad00011903e819ea350401192baf18201a000312591920a404193e801864193e801864193e801864193e801864193e801864193e80186418641864193e8018641a000170a718201a00020782182019f016041a0001194a18b2000119568718201a0001643519030104021a00014f581a00037c71187a0001011903e819a7a90402195fe419733a1826011a000db464196a8f0119ca3f19022e011999101903e819ecb2011a00022a4718201a000144ce1820193bc318201a0001291101193371041956540a197147184a01197147184a0119a9151902280119aecd19021d0119843c18201a00010a9618201a00011aaa1820191c4b1820191cdf1820192d1a18201a00014f581a00037c71187a0001011a0001614219020700011a000122c118201a00014f581a00037c71187a0001011a00014f581a00037c71187a0001011a000e94721a0003414000021a0004213c19583c041a00163cad19fc3604194ff30104001a00022aa818201a000189b41901a401011a00013eff182019e86a1820194eae182019600c1820195108182019654d182019602f18201a0290f1e70a1a032e93af1937fd0a1a0298e40b1966c40a029901291a000189b41901a401011903e818ad00011903e819ea350401192baf18201a000312591920a404193e801864193e801864193e801864193e801864193e801864193e80186418641864193e8018641a000170a718201a00020782182019f016041a0001194a18b2000119568718201a0001643519030104021a00014f581a0001e143191c893903831906b419022518391a00014f580001011903e819a7a90402195fe419733a1826011a000db464196a8f0119ca3f19022e011999101903e819ecb2011a00022a4718201a000144ce1820193bc318201a0001291101193371041956540a197147184a01197147184a0119a9151902280119aecd19021d0119843c18201a00010a9618201a00011aaa1820191c4b1820191cdf1820192d1a18201a00014f581a0001e143191c893903831906b419022518391a00014f5800011a0001614219020700011a000122c118201a00014f581a0001e143191c893903831906b419022518391a00014f580001011a00014f581a0001e143191c893903831906b419022518391a00014f5800011a000e94721a0003414000021a0004213c19583c041a00163cad19fc3604194ff30104001a00022aa818201a000189b41901a401011a00013eff182019e86a1820194eae182019600c1820195108182019654d182019602f18201a0290f1e70a1a032e93af1937fd0a1a0298e40b1966c40a193e801864193e8018641a000eaf1f121a002a6e06061a0006be98011a0321aac7190eac121a00041699121a048e466e1922a4121a0327ec9a121a001e743c18241a0031410f0c1a000dbf9e011a09f2f6d31910d318241a0004578218241a096e44021967b518241a0473cee818241a13e62472011a0f23d40118481a00212c5618481a0022814619fc3b041a00032b00192076041a0013be0419702c183f00011a000f59d919aa6718fb00011a000187551902d61902cf00011a000187551902d61902cf00011a000187551902d61902cf00011a0001a5661902a800011a00017468011a00044a391949a000011a0002bfe2189f01011a00026b371922ee00011a00026e9219226d00011a0001a3e2190ce2011a00019e4919028f011a001df8bb195fc803';

/**
 * based off what the cardano-wallet team found worked empirically
 * note: slots are 1 second in Shelley mainnet, so this is 2hrs
 */
const defaultTtlOffset = 7200;
const MAX_VALUE_SIZE = 5000;
const MAX_TRANSACTION_SIZE = 16384;

export type TxOutput = {|
  ...Address,
  amount: MultiToken,
  dataHash?: string,
  data?: string,
|};

type TxAuxiliaryData = {|
  metadata: ?TxMetadata,
  nativeScripts: ?Array<string>,
|};

type TxMetadata = {
  [tag: string]: string,
};

type TxMint = {|
  policyScript: string,
  assetName: string,
  amount: string,
|};

export function sendAllUnsignedTx(
  receiver: { ...Address, ...InexactSubset<Addressing>, ... },
  allUtxos: Array<CardanoAddressedUtxo>,
  absSlotNumber: BigNumber,
  protocolParams: {|
    linearFee: RustModule.WalletV4.LinearFee,
    coinsPerUtxoByte: RustModule.WalletV4.BigNum,
    poolDeposit: RustModule.WalletV4.BigNum,
    keyDeposit: RustModule.WalletV4.BigNum,
    networkId: number,
  |},
  metadata: RustModule.WalletV4.AuxiliaryData | void,
  networkId: number
): V4UnsignedTxAddressedUtxoResponse {
  const addressingMap = new Map<RemoteUnspentOutput, CardanoAddressedUtxo>();
  for (const utxo of allUtxos) {
    addressingMap.set(
      {
        amount: utxo.amount,
        receiver: utxo.receiver,
        tx_hash: utxo.tx_hash,
        tx_index: utxo.tx_index,
        utxo_id: utxo.utxo_id,
        assets: utxo.assets,
      },
      utxo
    );
  }
  const unsignedTxResponse = sendAllUnsignedTxFromUtxo(
    receiver,
    Array.from(addressingMap.keys()),
    absSlotNumber,
    protocolParams,
    metadata,
    networkId
  );

  const addressedUtxos = unsignedTxResponse.senderUtxos.map(utxo => {
    const addressedUtxo = addressingMap.get(utxo);
    if (addressedUtxo == null) {
      throw new Error(`${nameof(sendAllUnsignedTx)} utxo reference was changed. Should not happen`);
    }
    return addressedUtxo;
  });

  return {
    senderUtxos: addressedUtxos,
    txBuilder: unsignedTxResponse.txBuilder,
    changeAddr: unsignedTxResponse.changeAddr,
    certificates: [],
  };
}

export function sendAllUnsignedTxFromUtxo(
  receiver: { ...Address, ...InexactSubset<Addressing>, ... },
  allUtxos: Array<RemoteUnspentOutput>,
  absSlotNumber: BigNumber,
  protocolParams: {|
    linearFee: RustModule.WalletV4.LinearFee,
    coinsPerUtxoByte: RustModule.WalletV4.BigNum,
    poolDeposit: RustModule.WalletV4.BigNum,
    keyDeposit: RustModule.WalletV4.BigNum,
    networkId: number,
  |},
  metadata: RustModule.WalletV4.AuxiliaryData | void,
  _networkId: number
): V4UnsignedTxUtxoResponse {
  if (allUtxos.length === 0) {
    throw new NotEnoughMoneyToSendError();
  }
  return RustModule.WasmScope(Module => {
    const cml = Module.CML;
    const config = cml.TransactionBuilderConfigBuilder.new()
      .fee_algo(cml.LinearFee.new(
        // eslint-disable-next-line no-undef
        BigInt(protocolParams.linearFee.coefficient().to_str()),
        // eslint-disable-next-line no-undef
        BigInt(protocolParams.linearFee.constant().to_str()),
        0n
      ))
      // eslint-disable-next-line no-undef
      .coins_per_utxo_byte(BigInt(protocolParams.coinsPerUtxoByte.to_str()))
      // eslint-disable-next-line no-undef
      .pool_deposit(BigInt(protocolParams.poolDeposit.to_str()))
      // eslint-disable-next-line no-undef
      .key_deposit(BigInt(protocolParams.keyDeposit.to_str()))
      .max_value_size(MAX_VALUE_SIZE)
      .max_tx_size(MAX_TRANSACTION_SIZE)
      .ex_unit_prices(cml.ExUnitPrices.new(cml.Rational.new(577n, 10000n), cml.Rational.new(721n, 10000000n)))
      .collateral_percentage(150)
      .max_collateral_inputs(3)
      .build();
    const txBuilder = cml.TransactionBuilder.new(config);
    // eslint-disable-next-line no-undef
    txBuilder.set_ttl(BigInt(absSlotNumber.plus(defaultTtlOffset).toFixed(0)));
    const address = cml.Address.from_hex(receiver.address);
    for (const utxo of allUtxos) {
      let value;
      try {
        value = cmlValueFromRemoteFormat(cml, utxo);
      } catch (_error) {
        throw new AssetOverflowError();
      }
      // eslint-disable-next-line no-undef
      const input = cml.TransactionInput.new(cml.TransactionHash.from_hex(utxo.tx_hash), BigInt(utxo.tx_index));
      const output = cml.TransactionOutput.new(cml.Address.from_hex(utxo.receiver), value);
      txBuilder.add_input(cml.SingleInputBuilder.new(input, output).payment_key());
    }
    if (metadata != null) txBuilder.set_auxiliary_data(cml.AuxiliaryData.from_cbor_bytes(metadata.to_bytes()));
    try {
      if (!txBuilder.add_change_if_needed(address, false)) throw new NotEnoughMoneyToSendError();
    } catch (error) {
      if (error instanceof NotEnoughMoneyToSendError) throw error;
      if (/Maximum transaction size/.test(String(error))) throw new OversizedTransactionError();
      if (/overflow/i.test(String(error))) throw new AssetOverflowError();
      if (/Not enough ADA|Insufficient/.test(String(error))) throw new NotEnoughMoneyToSendError();
      throw error;
    }
    const body = txBuilder.build(cml.ChangeSelectionAlgo.Default, address).body();
    const outputs = body.outputs();
    const changeAddr = receiver.addressing == null ? [] : Array.from({ length: outputs.len() }, (_, index) => {
      const output = outputs.get(index);
      if (output.address().to_hex() !== receiver.address) return null;
      return {
        addressing: receiver.addressing,
        address: receiver.address,
        values: multiTokenFromCmlValue(output.amount(), {
          defaultNetworkId: protocolParams.networkId,
          defaultIdentifier: PRIMARY_ASSET_CONSTANTS.Cardano,
        }),
      };
    }).filter(item => item != null);
    return {
      senderUtxos: allUtxos,
      txBuilder: body.to_cbor_bytes(),
      changeAddr,
    };
  });
}

/**
 * we use all UTXOs as possible inputs for selection
 */
export async function newAdaUnsignedTx(
  outputs: Array<TxOutput>,
  changeAdaAddr: void | {| ...Address, ...Addressing |},
  allUtxos: Array<CardanoAddressedUtxo>,
  absSlotNumber: BigNumber,
  protocolParams: {|
    linearFeeCoefficient: string,
    linearFeeConstant: string,
    coinsPerUtxoByte: string,
    poolDeposit: string,
    keyDeposit: string,
    networkId: number,
  |},
  certificates: $ReadOnlyArray<string>,
  withdrawals: $ReadOnlyArray<{|
    address: RustModule.WalletV4.RewardAddress,
    amount: RustModule.WalletV4.BigNum,
  |}>,
  allowNoOutputs: boolean,
  metadata: RustModule.WalletV4.AuxiliaryData | void,
  networkId: number
): Promise<V4UnsignedTxAddressedUtxoResponse> {
  const addressingMap = new Map<RemoteUnspentOutput, CardanoAddressedUtxo>();
  for (const utxo of allUtxos) {
    addressingMap.set(
      {
        amount: utxo.amount,
        receiver: utxo.receiver,
        tx_hash: utxo.tx_hash,
        tx_index: utxo.tx_index,
        utxo_id: utxo.utxo_id,
        assets: utxo.assets,
      },
      utxo
    );
  }
  const unsignedTxResponse = await newAdaUnsignedTxFromUtxo(
    outputs,
    changeAdaAddr,
    Array.from(addressingMap.keys()),
    absSlotNumber,
    protocolParams,
    certificates,
    withdrawals,
    allowNoOutputs,
    metadata,
    networkId
  );

  const addressedUtxos = unsignedTxResponse.senderUtxos.map(utxo => {
    const addressedUtxo = addressingMap.get(utxo);
    if (addressedUtxo == null) {
      throw new Error(`${nameof(newAdaUnsignedTx)} utxo reference was changed. Should not happen`);
    }
    return addressedUtxo;
  });

  return {
    senderUtxos: addressedUtxos,
    txBuilder: unsignedTxResponse.txBuilder,
    changeAddr: unsignedTxResponse.changeAddr,
    implicitInputValue: unsignedTxResponse.implicitInputValue,
    depositAmount: unsignedTxResponse.depositAmount,
    certificates,
  };
}

export async function newAdaUnsignedTxForConnector(
  outputs: Array<TxOutput>,
  mint: Array<TxMint>,
  auxiliaryData: TxAuxiliaryData,
  changeAdaAddr: void | {| ...Address, ...Addressing |},
  mustIncludeUtxos: Array<[CardanoAddressedUtxo, ?CardanoUtxoScriptWitness]>,
  coinSelectUtxos: Array<CardanoAddressedUtxo>,
  absSlotNumber: BigNumber,
  validityStart: ?number,
  ttl: ?number,
  requiredSigners: ?Array<string>,
  protocolParams: {|
    linearFeeCoefficient: string,
    linearFeeConstant: string,
    coinsPerUtxoByte: string,
    poolDeposit: string,
    keyDeposit: string,
    networkId: number,
  |},
  networkId: number
): Promise<V4UnsignedTxAddressedUtxoResponse> {
  const toRemoteUnspentOutput = (utxo: CardanoAddressedUtxo): RemoteUnspentOutput => ({
    amount: utxo.amount,
    receiver: utxo.receiver,
    tx_hash: utxo.tx_hash,
    tx_index: utxo.tx_index,
    utxo_id: utxo.utxo_id,
    assets: utxo.assets,
  });
  const mustIncludeRemoteOutputs: Array<[RemoteUnspentOutput, ?CardanoUtxoScriptWitness]> = [];
  const addressingMapForMustIncludeUtxos = new Map<RemoteUnspentOutput, CardanoAddressedUtxo>();
  const addressingMapForCoinSelectUtxos = new Map<RemoteUnspentOutput, CardanoAddressedUtxo>();
  for (const [utxo, witness] of mustIncludeUtxos) {
    const remoteUnspentOutput = toRemoteUnspentOutput(utxo);
    mustIncludeRemoteOutputs.push([remoteUnspentOutput, witness]);
    addressingMapForMustIncludeUtxos.set(remoteUnspentOutput, utxo);
  }
  for (const utxo of coinSelectUtxos) {
    addressingMapForCoinSelectUtxos.set(toRemoteUnspentOutput(utxo), utxo);
  }
  const unsignedTxResponse = await newAdaUnsignedTxFromUtxoForConnector(
    outputs,
    mint,
    auxiliaryData,
    changeAdaAddr,
    mustIncludeRemoteOutputs,
    Array.from(addressingMapForCoinSelectUtxos.keys()),
    absSlotNumber,
    validityStart,
    ttl,
    requiredSigners,
    protocolParams,
    networkId
  );

  const addressedUtxos = unsignedTxResponse.senderUtxos.map(utxo => {
    const addressedUtxo = addressingMapForMustIncludeUtxos.get(utxo) || addressingMapForCoinSelectUtxos.get(utxo);
    if (addressedUtxo == null) {
      throw new Error(`${nameof(newAdaUnsignedTx)} utxo reference was changed. Should not happen`);
    }
    return addressedUtxo;
  });

  return {
    senderUtxos: addressedUtxos,
    txBuilder: unsignedTxResponse.txBuilder,
    changeAddr: unsignedTxResponse.changeAddr,
    certificates: [],
  };
}

function multiTokenFromCmlValue(value: any, defaults: {| defaultIdentifier: string, defaultNetworkId: number |}): MultiToken {
  const result = new MultiToken([], defaults);
  result.add({
    amount: new BigNumber(value.coin().toString()),
    identifier: defaults.defaultIdentifier,
    networkId: defaults.defaultNetworkId,
  });
  const multiAsset = value.multi_asset();
  if (multiAsset == null) return result;
  const policies = multiAsset.keys();
  for (let policyIndex = 0; policyIndex < policies.len(); policyIndex++) {
    const policy = policies.get(policyIndex);
    const assets = multiAsset.get_assets(policy);
    if (assets == null) continue;
    const names = assets.keys();
    for (let assetIndex = 0; assetIndex < names.len(); assetIndex++) {
      const name = names.get(assetIndex);
      const amount = assets.get(name);
      if (amount == null) continue;
      result.add({
        amount: new BigNumber(amount.toString()),
        identifier: `${policy.to_hex()}.${name.to_hex()}`,
        networkId: defaults.defaultNetworkId,
      });
    }
  }
  return result;
}

function cmlValueFromRemoteFormat(cml: any, utxo: RemoteUnspentOutput): any {
  const multiAsset = cml.MultiAsset.new();
  for (const asset of utxo.assets) {
    const { policyId, name } = identifierSplit(asset.assetId);
    const policy = cml.ScriptHash.from_hex(policyId);
    const policyAssets = multiAsset.get_assets(policy) ?? cml.MapAssetNameToCoin.new();
    // eslint-disable-next-line no-undef
    policyAssets.insert(cml.AssetName.from_hex(name), BigInt(asset.amount));
    multiAsset.insert_assets(policy, policyAssets);
  }
  // eslint-disable-next-line no-undef
  return cml.Value.new(BigInt(utxo.amount), multiAsset);
}

function cmlValueFromMultiToken(cml: any, tokens: MultiToken): any {
  const multiAsset = cml.MultiAsset.new();
  for (const entry of tokens.nonDefaultEntries()) {
    const { policyId, name } = identifierSplit(entry.identifier);
    const policy = cml.ScriptHash.from_hex(policyId);
    const policyAssets = multiAsset.get_assets(policy) ?? cml.MapAssetNameToCoin.new();
    // eslint-disable-next-line no-undef
    policyAssets.insert(cml.AssetName.from_hex(name), BigInt(entry.amount.toString()));
    multiAsset.insert_assets(policy, policyAssets);
  }
  // eslint-disable-next-line no-undef
  return cml.Value.new(BigInt(tokens.getDefaultEntry().amount.toString()), multiAsset);
}

/**
 * This function operates on UTXOs without a way to generate the private key for them
 * Private key needs to be added afterwards either through
 * A) Addressing
 * B) Having the key provided externally
 */
export async function newAdaUnsignedTxFromUtxo(
  outputs: Array<TxOutput>,
  changeAdaAddr: void | {| ...Address, ...Addressing |},
  utxos: Array<RemoteUnspentOutput>,
  absSlotNumber: BigNumber,
  protocolParams: {|
    linearFeeCoefficient: string,
    linearFeeConstant: string,
    coinsPerUtxoByte: string,
    poolDeposit: string,
    keyDeposit: string,
    networkId: number,
  |},
  certificates: $ReadOnlyArray<string>,
  withdrawals: $ReadOnlyArray<{|
    address: RustModule.WalletV4.RewardAddress,
    amount: RustModule.WalletV4.BigNum,
  |}>,
  allowNoOutputs: boolean,
  auxiliaryData: RustModule.WalletV4.AuxiliaryData | void,
  networkId: number
): Promise<V4UnsignedTxUtxoResponse> {
  await RustModule.load();
  const result = RustModule.WasmScope(Module => {
    const cml = Module.CML;
    const config = cml.TransactionBuilderConfigBuilder.new()
      .fee_algo(
        cml.LinearFee.new(
          // eslint-disable-next-line no-undef
          BigInt(protocolParams.linearFeeCoefficient),
          // eslint-disable-next-line no-undef
          BigInt(protocolParams.linearFeeConstant),
          0n
        )
      )
      // eslint-disable-next-line no-undef
      .coins_per_utxo_byte(BigInt(protocolParams.coinsPerUtxoByte))
      // eslint-disable-next-line no-undef
      .pool_deposit(BigInt(protocolParams.poolDeposit))
      // eslint-disable-next-line no-undef
      .key_deposit(BigInt(protocolParams.keyDeposit))
      .max_value_size(MAX_VALUE_SIZE)
      .max_tx_size(MAX_TRANSACTION_SIZE)
      .ex_unit_prices(cml.ExUnitPrices.new(cml.Rational.new(577n, 10000n), cml.Rational.new(721n, 10000000n)))
      .collateral_percentage(150)
      .max_collateral_inputs(3)
      .cost_models(cml.CostModels.from_cbor_hex(COSTMODELS))
      // The legacy builder keeps ADA and assets together when a single change
      // output can represent the remainder. Keep that contract for callers.
      .prefer_pure_change(false)
      .build();
    const txBuilder = cml.TransactionBuilder.new(config);
    // eslint-disable-next-line no-undef
    txBuilder.set_ttl(BigInt(absSlotNumber.plus(defaultTtlOffset).toFixed(0)));

    for (const certificateHex of certificates) {
      txBuilder.add_cert(cml.SingleCertificateBuilder.new(cml.Certificate.from_cbor_hex(certificateHex)).skip_witness());
    }
    for (const withdrawal of withdrawals) {
      txBuilder.add_withdrawal(
        cml.SingleWithdrawalBuilder.new(
          cml.RewardAddress.from_address(cml.Address.from_hex(withdrawal.address.to_address().to_hex())),
          // eslint-disable-next-line no-undef
          BigInt(withdrawal.amount.to_str())
        ).payment_key()
      );
    }
    if (auxiliaryData) txBuilder.set_auxiliary_data(cml.AuxiliaryData.from_cbor_bytes(auxiliaryData.to_bytes()));

    for (const output of outputs) {
      let datumOption;
      if (output.dataHash != null) {
        datumOption = cml.DatumOption.new_hash(cml.DatumHash.from_hex(output.dataHash));
      } else if (output.data != null) {
        datumOption = cml.DatumOption.new_datum(cml.PlutusData.from_cbor_hex(output.data));
      }
      const transactionOutput = cml.TransactionOutput.new(
        cml.Address.from_hex(output.address),
        cmlValueFromMultiToken(cml, output.amount),
        datumOption
      );
      txBuilder.add_output(cml.SingleOutputBuilderResult.new(transactionOutput));
    }

    const reservedCollateral = [];
    const spendableUtxos = [];
    for (const utxo of utxos) {
      const isPureAda = utxo.assets.length === 0;
      if (isPureAda && new BigNumber(utxo.amount).lte(2_000_000) && reservedCollateral.length < 3) {
        reservedCollateral.push(utxo);
      } else {
        spendableUtxos.push(utxo);
      }
    }
    const utxosByRef = new Map();
    const addSelectionCandidate = utxo => {
      const value = cmlValueFromRemoteFormat(cml, utxo);
      const input = cml.TransactionInput.new(
        cml.TransactionHash.from_hex(utxo.tx_hash),
        // eslint-disable-next-line no-undef
        BigInt(utxo.tx_index)
      );
      const output = cml.TransactionOutput.new(
        cml.Address.from_hex(utxo.receiver),
        value
      );
      txBuilder.add_utxo(cml.SingleInputBuilder.new(input, output).payment_key());
      utxosByRef.set(`${utxo.tx_hash}${utxo.tx_index}`, utxo);
    };
    spendableUtxos.forEach(addSelectionCandidate);

    try {
      const hasMultiAssetOutput = outputs.some(output => output.amount.nonDefaultEntries().length > 0);
      const strategy = hasMultiAssetOutput
        ? cml.CoinSelectionStrategyCIP2.RandomImproveMultiAsset
        : cml.CoinSelectionStrategyCIP2.RandomImprove;
      try {
        txBuilder.select_utxos(strategy);
      } catch (selectionError) {
        if (!String(selectionError).includes('Not enough ADA') && !String(selectionError).includes('Insufficient')) {
          throw selectionError;
        }
        reservedCollateral.forEach(addSelectionCandidate);
        txBuilder.select_utxos(strategy);
      }
    } catch (error) {
      if (String(error).includes('Not enough ADA') || String(error).includes('Insufficient')) {
        throw new NotEnoughMoneyToSendError();
      }
      if (String(error).includes('overflow') || String(error).includes('Overflow')) {
        throw new AssetOverflowError();
      }
      throw error;
    }

    const changeAddress = changeAdaAddr == null ? null : cml.Address.from_hex(changeAdaAddr.address);
    if (changeAddress != null) {
      const missingCollateralCount = Math.max(3 - reservedCollateral.length, 0);
      let available = txBuilder
        .get_total_input()
        .checked_sub(txBuilder.get_total_output())
        .coin() - txBuilder.min_fee(false);
      // Collateral recommendations are separate pure-ADA outputs in the old
      // builder; adding them alongside a multiasset change output changes the
      // established caller-visible change contract. Keep those transactions
      // as a single change output and reserve candidates for selection only.
      const hasAssetInputs = utxos.some(utxo => utxo.assets.length > 0);
      if (!hasAssetInputs && !outputs.some(output => output.amount.nonDefaultEntries().length > 0)) {
        for (let index = 0; index < missingCollateralCount; index++) {
          if (available <= 2_000_000n) break;
          const collateralOutput = cml.TransactionOutput.new(changeAddress, cml.Value.from_coin(2_000_000n));
          txBuilder.add_output(cml.SingleOutputBuilderResult.new(collateralOutput));
          available -= 2_000_000n;
        }
      }
      const hasChange = txBuilder.add_change_if_needed(changeAddress, false);
      if (outputs.length === 0 && !hasChange) throw new NotEnoughMoneyToSendError();
    } else {
      const remainder = txBuilder.get_total_input().checked_sub(txBuilder.get_total_output());
      txBuilder.set_fee(remainder.coin());
    }

    const changeForBuild = changeAddress ?? (outputs.length > 0 ? cml.Address.from_hex(outputs[0].address) : null);
    if (changeForBuild == null) throw new NoOutputsError();
    let signedBuilder;
    try {
      signedBuilder = txBuilder.build(cml.ChangeSelectionAlgo.Default, changeForBuild);
    } catch (error) {
      if (String(error).includes('No outputs')) throw new NoOutputsError();
      if (String(error).includes('Not enough ADA')) throw new NotEnoughMoneyToSendError();
      throw error;
    }

    const body = signedBuilder.body();
    const witnessBuilder = signedBuilder.witness_set();
    for (const output of outputs) {
      if (output.data != null && output.dataHash != null) {
        witnessBuilder.add_plutus_datum(cml.PlutusData.from_cbor_hex(output.data));
      }
    }
    const witnesses = witnessBuilder.build();
    if (outputs.some(output => output.data != null && output.dataHash != null)) {
      const costModels = cml.CostModels.from_cbor_hex(COSTMODELS);
      const scriptDataHash = cml.calc_script_data_hash_from_witness(witnesses, costModels);
      if (scriptDataHash == null) throw new Error('Unable to calculate script data hash');
      body.set_script_data_hash(scriptDataHash);
    }
    const bodyBytes = body.to_cbor_bytes();
    const selectedUtxos = [];
    const inputs = body.inputs();
    for (let index = 0; index < inputs.len(); index++) {
      const input = inputs.get(index);
      const utxo = utxosByRef.get(`${input.transaction_id().to_hex()}${input.index()}`);
      if (utxo == null) throw new Error('CML selected an unknown input');
      selectedUtxos.push(utxo);
    }

    const changeAddresses = [];
    if (changeAdaAddr != null) {
      const transactionOutputs = body.outputs();
      for (let index = outputs.length; index < transactionOutputs.len(); index++) {
        const output = transactionOutputs.get(index);
        const address = output.address();
        if (address.to_hex() !== changeAdaAddr.address) continue;
        changeAddresses.push({
          address: changeAdaAddr.address,
          addressing: changeAdaAddr.addressing,
          values: multiTokenFromCmlValue(output.amount(), {
            defaultIdentifier: PRIMARY_ASSET_CONSTANTS.Cardano,
            defaultNetworkId: networkId,
          }),
        });
      }
    }
    return {
      bodyBytes,
      implicitInputBytes: txBuilder.get_implicit_input().to_cbor_bytes(),
      deposit: txBuilder.get_deposit().toString(),
      selectedUtxos,
      changeAddresses,
    };
  });

  return {
    senderUtxos: result.selectedUtxos,
    txBuilder: result.bodyBytes,
    changeAddr: result.changeAddresses,
    implicitInputValue: result.implicitInputBytes,
    depositAmount: result.deposit,
  };
}

export async function maxSendableADA(request: {|
  publicDeriver: {
    networkId: number,
    utxos: IGetAllUtxosResponse,
    defaultTokenId: string,
    ...
  },
  absSlotNumber: BigNumber,
  receiver: string | null,
  tokens: Array<
    $ReadOnly<{|
      token: $ReadOnly<TokenRow>,
      shouldSendAll?: boolean,
      amount?: string,
    |}>,
  >,
|}): Promise<BigNumber> {
  try {
    const network = getNetworkById(request.publicDeriver.networkId);
    const config = getCardanoHaskellBaseConfig(network).reduce((acc, next) => Object.assign(acc, next), {});

    const addressedUtxo = asAddressedUtxo(request.publicDeriver.utxos);
    const totalBalance = addressedUtxo
      .map(utxo => new BigNumber(utxo.amount))
      .reduce((acc, amount) => acc.plus(amount), new BigNumber(0));
    if (totalBalance.isZero()) {
      throw new NotEnoughMoneyToSendError();
    }

    if (request.receiver == null) {
      throw new Error(`${nameof(maxSendableADA)} requires wallet address.`);
    }
    const cmlResult = RustModule.WasmScope(Module => {
      const cml = Module.CML;
      let cmlReceiver;
      try {
        cmlReceiver = cml.Address.from_hex(request.receiver);
      } catch (_error) {
        throw new Error(`${nameof(maxSendableADA)} receiver not a valid Shelley address`);
      }
      const configBuilder = cml.TransactionBuilderConfigBuilder.new()
        .fee_algo(
          cml.LinearFee.new(
            // eslint-disable-next-line no-undef
            BigInt(config.LinearFee.coefficient),
            // eslint-disable-next-line no-undef
            BigInt(config.LinearFee.constant),
            0n
          )
        )
        // eslint-disable-next-line no-undef
        .coins_per_utxo_byte(BigInt(config.CoinsPerUtxoByte))
        // eslint-disable-next-line no-undef
        .pool_deposit(BigInt(config.PoolDeposit))
        // eslint-disable-next-line no-undef
        .key_deposit(BigInt(config.KeyDeposit))
        .max_value_size(MAX_VALUE_SIZE)
        .max_tx_size(MAX_TRANSACTION_SIZE)
        .ex_unit_prices(
          cml.ExUnitPrices.new(
            cml.Rational.new(577n, 10000n),
            cml.Rational.new(721n, 10000000n)
          )
        )
        .collateral_percentage(150)
        .max_collateral_inputs(3)
        .prefer_pure_change(false);
      const txBuilder = cml.TransactionBuilder.new(configBuilder.build());
      // eslint-disable-next-line no-undef
      txBuilder.set_ttl(BigInt(request.absSlotNumber.plus(defaultTtlOffset).toFixed(0)));

      const isAssetsSelected = request.tokens.length >= 2; // [ada, ...tokens]
      if (isAssetsSelected) {
        const defaultToken = {
          defaultNetworkId: request.publicDeriver.networkId,
          defaultIdentifier: request.publicDeriver.defaultTokenId,
        };
        const output = cmlValueFromMultiToken(
          cml,
          builtSendTokenList(
            defaultToken,
            request.tokens,
            addressedUtxo.map(utxo => multiTokenFromRemote(utxo, request.publicDeriver.networkId))
          )
        );
        txBuilder.add_output(
          cml.SingleOutputBuilderResult.new(
            cml.TransactionOutput.new(
              cmlReceiver,
              output
            )
          )
        );
      }

      for (const input of addressedUtxo) {
        const cmlValue = cmlValueFromRemoteFormat(cml, input);
        try {
          txBuilder
            .get_explicit_input()
            .checked_add(txBuilder.get_implicit_input())
            .checked_add(cmlValue);
        } catch (_error) {
          throw new AssetOverflowError();
        }
        const txInput = cml.TransactionInput.new(
          cml.TransactionHash.from_hex(input.tx_hash),
          // eslint-disable-next-line no-undef
          BigInt(input.tx_index)
        );
        const txOutput = cml.TransactionOutput.new(
          cml.Address.from_hex(input.receiver),
          cmlValue
        );
        txBuilder.add_input(cml.SingleInputBuilder.new(txInput, txOutput).payment_key());
      }

      const signedBuilder = txBuilder.build(cml.ChangeSelectionAlgo.Default, cmlReceiver);
      const outputs = signedBuilder.body().outputs();
      const outputValues = [];
      for (let index = 0; index < outputs.len(); index++) {
        const output = outputs.get(index).amount();
        outputValues.push({ amount: output.coin().toString(), hasAssets: output.has_multiassets() });
      }
      return outputValues;
    });
    const outputs = cmlResult;
    let adaLockedForAssets = 0;
    if (request.tokens.length >= 2) {
      adaLockedForAssets = new BigNumber(outputs[0].amount);
    }

    for (const output of outputs) {
      if (!output.hasAssets) {
        return new BigNumber(output.amount).plus(adaLockedForAssets);
      }
    }
    // No pure sendable ADA left
    if (request.tokens.length >= 2) return new BigNumber(adaLockedForAssets);
    // Reaching this point means user has not enough pure ADA to send.
    throw new NotEnoughMoneyToSendError();
  } catch (e) {
    if (String(e).includes('Not enough ADA')) {
      throw new NotEnoughMoneyToSendError();
    }

    throw e;
  }
}

async function newAdaUnsignedTxFromUtxoForConnector(
  outputs: Array<TxOutput>,
  mint: Array<TxMint>,
  auxiliaryData: TxAuxiliaryData,
  changeAdaAddr: void | {| ...Address, ...Addressing |},
  mustIncludeUtxos: Array<[RemoteUnspentOutput, ?CardanoUtxoScriptWitness]>,
  coinSelectUtxos: Array<RemoteUnspentOutput>,
  absSlotNumber: BigNumber,
  validityStart: ?number,
  ttl: ?number,
  requiredSigners: ?Array<string>,
  protocolParams: {|
    linearFeeCoefficient: string,
    linearFeeConstant: string,
    coinsPerUtxoByte: string,
    poolDeposit: string,
    keyDeposit: string,
    networkId: number,
  |},
  networkId: number
): Promise<V4UnsignedTxUtxoResponse> {
  await RustModule.load();
  const result = RustModule.WasmScope(Module => {
    const cml = Module.CML;
    const redeemersByUtxo = new Map();
    for (const [utxo, witness] of mustIncludeUtxos) {
      if (witness?.plutusScript == null) continue;
      const redeemer = cml.LegacyRedeemer.from_cbor_hex(witness.redeemer);
      redeemersByUtxo.set(`${utxo.tx_hash}${utxo.tx_index}`, redeemer);
    }
    const config = cml.TransactionBuilderConfigBuilder.new()
      // eslint-disable-next-line no-undef
      .fee_algo(cml.LinearFee.new(BigInt(protocolParams.linearFeeCoefficient), BigInt(protocolParams.linearFeeConstant), 0n))
      // eslint-disable-next-line no-undef
      .coins_per_utxo_byte(BigInt(protocolParams.coinsPerUtxoByte))
      // eslint-disable-next-line no-undef
      .pool_deposit(BigInt(protocolParams.poolDeposit))
      // eslint-disable-next-line no-undef
      .key_deposit(BigInt(protocolParams.keyDeposit))
      .max_value_size(MAX_VALUE_SIZE)
      .max_tx_size(MAX_TRANSACTION_SIZE)
      .ex_unit_prices(cml.ExUnitPrices.new(cml.Rational.new(577n, 10000n), cml.Rational.new(721n, 10000000n)))
      .collateral_percentage(150)
      .max_collateral_inputs(3)
      .cost_models(cml.CostModels.from_cbor_hex(COSTMODELS))
      .prefer_pure_change(false)
      .build();
    const txBuilder = cml.TransactionBuilder.new(config);
    // eslint-disable-next-line no-undef
    txBuilder.set_ttl(BigInt((ttl ?? absSlotNumber.plus(defaultTtlOffset).toNumber()).toString()));
    if (validityStart != null) {
      // eslint-disable-next-line no-undef
      txBuilder.set_validity_start_interval(BigInt(validityStart));
    }

    for (const signer of requiredSigners ?? []) {
      const normalizedSigner = signer.trim();
      if (/^[0-9a-fA-F]{56}$/.test(normalizedSigner)) {
        txBuilder.add_required_signer(cml.Ed25519KeyHash.from_hex(normalizedSigner));
      } else {
        let address;
        try {
          address = /^[0-9a-fA-F]+$/.test(normalizedSigner)
            ? cml.Address.from_hex(normalizedSigner)
            : cml.Address.from_bech32(normalizedSigner);
        } catch (_error) {
          throw new Error(`Cannot process an invalid required signer, expecting an Ed25519KeyHash or a valid address with a payment key-hash, got: ${signer}`);
        }
        const credential = address.payment_cred();
        const keyHash = credential?.as_pub_key();
        if (keyHash == null) {
          throw new Error(`Cannot process an invalid required signer, expecting an Ed25519KeyHash or a valid address with a payment key-hash, got: ${signer}`);
        }
        txBuilder.add_required_signer(keyHash);
      }
    }

    if (Object.keys(auxiliaryData.metadata ?? {}).length > 0 || (auxiliaryData.nativeScripts ?? []).length > 0) {
      const auxData = cml.AuxiliaryData.new();
      const metadata = cml.Metadata.new();
      for (const [tag, json] of Object.entries(auxiliaryData.metadata ?? {})) {
        // eslint-disable-next-line no-undef
        metadata.set(BigInt(tag), cml.encode_json_str_to_metadatum(json, cml.MetadataJsonSchema.BasicConversions));
      }
      if (metadata.len() > 0) auxData.add_metadata(metadata);
      const scripts = cml.NativeScriptList.new();
      for (const script of auxiliaryData.nativeScripts ?? []) scripts.add(cml.NativeScript.from_cbor_hex(script));
      if (scripts.len() > 0) auxData.add_native_scripts(scripts);
      txBuilder.set_auxiliary_data(auxData);
    }

    const mintGroups = new Map();
    for (const entry of mint) {
      const script = cml.NativeScript.from_cbor_hex(entry.policyScript);
      const policyId = script.hash().to_hex();
      const group = mintGroups.get(policyId) ?? { script, assets: new Map() };
      const previous = group.assets.get(entry.assetName) ?? 0n;
      // eslint-disable-next-line no-undef
      group.assets.set(entry.assetName, previous + BigInt(entry.amount));
      mintGroups.set(policyId, group);
    }
    for (const { script, assets } of mintGroups.values()) {
      const cmlAssets = cml.MapAssetNameToNonZeroInt64.new();
      for (const [assetName, amount] of assets) {
        if (amount !== 0n) cmlAssets.insert(cml.AssetName.from_hex(assetName), amount);
      }
      if (cmlAssets.len() > 0) txBuilder.add_mint(cml.SingleMintBuilder.new(cmlAssets).native_script(script, cml.NativeScriptWitnessInfo.assume_signature_count()));
    }

    for (const [utxo, witness] of mustIncludeUtxos) {
      // eslint-disable-next-line no-undef
      const input = cml.TransactionInput.new(cml.TransactionHash.from_hex(utxo.tx_hash), BigInt(utxo.tx_index));
      const value = cmlValueFromRemoteFormat(cml, utxo);
      const output = cml.TransactionOutput.new(cml.Address.from_hex(utxo.receiver), value);
      const inputBuilder = cml.SingleInputBuilder.new(input, output);
      if (witness?.nativeScript != null) {
        txBuilder.add_input(inputBuilder.native_script(
          cml.NativeScript.from_cbor_hex(witness.nativeScript),
          cml.NativeScriptWitnessInfo.assume_signature_count()
        ));
      } else if (witness?.plutusScript != null) {
        const redeemer = redeemersByUtxo.get(`${utxo.tx_hash}${utxo.tx_index}`);
        if (redeemer == null) throw new Error('Missing parsed Plutus redeemer');
        const script = cml.PlutusScript.from_v1(cml.PlutusV1Script.from_cbor_hex(witness.plutusScript));
        const partialWitness = cml.PartialPlutusWitness.new(cml.PlutusScriptWitness.new_script(script), redeemer.data());
        txBuilder.add_input(inputBuilder.plutus_script(
          partialWitness,
          cml.Ed25519KeyHashList.new(),
          cml.PlutusData.from_cbor_hex(witness.datum)
        ));
        txBuilder.set_exunits(cml.RedeemerWitnessKey.from_redeemer(redeemer), redeemer.ex_units());
      } else if (witness == null) {
        txBuilder.add_input(inputBuilder.payment_key());
      } else {
        throw new Error('Unexpected script witness value');
      }
    }

    for (const output of outputs) {
      const datumOption = output.dataHash == null ? undefined : cml.DatumOption.new_hash(cml.DatumHash.from_hex(output.dataHash));
      txBuilder.add_output(cml.SingleOutputBuilderResult.new(cml.TransactionOutput.new(
        cml.Address.from_hex(output.address),
        cmlValueFromMultiToken(cml, output.amount),
        datumOption
      )));
    }

    const utxosByRef = new Map();
    const addCandidate = utxo => {
      // eslint-disable-next-line no-undef
      const input = cml.TransactionInput.new(cml.TransactionHash.from_hex(utxo.tx_hash), BigInt(utxo.tx_index));
      const value = cmlValueFromRemoteFormat(cml, utxo);
      const output = cml.TransactionOutput.new(cml.Address.from_hex(utxo.receiver), value);
      txBuilder.add_utxo(cml.SingleInputBuilder.new(input, output).payment_key());
      utxosByRef.set(`${utxo.tx_hash}${utxo.tx_index}`, utxo);
    };
    for (const [utxo] of mustIncludeUtxos) utxosByRef.set(`${utxo.tx_hash}${utxo.tx_index}`, utxo);
    for (const utxo of coinSelectUtxos) addCandidate(utxo);

    if (coinSelectUtxos.length > 0) {
      try {
        const hasMultiAssetOutput = outputs.some(output => output.amount.nonDefaultEntries().length > 0);
        txBuilder.select_utxos(hasMultiAssetOutput ? cml.CoinSelectionStrategyCIP2.RandomImproveMultiAsset : cml.CoinSelectionStrategyCIP2.RandomImprove);
      } catch (error) {
        if (/Not enough ADA|Insufficient/.test(String(error))) throw new NotEnoughMoneyToSendError();
        if (/overflow/i.test(String(error))) throw new AssetOverflowError();
        throw error;
      }
    }

    const changeAddress = changeAdaAddr == null ? null : cml.Address.from_hex(changeAdaAddr.address);
    if (changeAddress != null) {
      try {
        txBuilder.add_change_if_needed(changeAddress, true);
      } catch (error) {
        if (/less than the minimum UTXO value/i.test(String(error))) throw new CannotSendBelowMinimumValueError();
        if (/Not enough ADA|Insufficient|Not enough inputs/i.test(String(error))) throw new NotEnoughMoneyToSendError();
        throw error;
      }
    } else {
      const remainder = txBuilder.get_total_input().checked_sub(txBuilder.get_total_output());
      txBuilder.set_fee(remainder.coin());
    }

    const changeForBuild = changeAddress ?? (outputs.length > 0 ? cml.Address.from_hex(outputs[0].address) : null);
    if (changeForBuild == null) throw new NoOutputsError();
    let signedBuilder;
    try {
      signedBuilder = txBuilder.build(cml.ChangeSelectionAlgo.Default, changeForBuild);
    } catch (error) {
      if (/No outputs/.test(String(error))) throw new NoOutputsError();
      if (/Not enough ADA/.test(String(error))) throw new NotEnoughMoneyToSendError();
      throw error;
    }

    const body = signedBuilder.body();
    const selectedUtxos = [];
    const inputs = body.inputs();
    for (let index = 0; index < inputs.len(); index++) {
      const input = inputs.get(index);
      const utxo = utxosByRef.get(`${input.transaction_id().to_hex()}${input.index()}`);
      if (utxo == null) throw new Error('CML selected an unknown input');
      selectedUtxos.push(utxo);
    }
    const changeAddresses = [];
    if (changeAdaAddr != null) {
      const transactionOutputs = body.outputs();
      for (let index = outputs.length; index < transactionOutputs.len(); index++) {
        const output = transactionOutputs.get(index);
        if (output.address().to_hex() !== changeAdaAddr.address) continue;
        changeAddresses.push({
          address: changeAdaAddr.address,
          addressing: changeAdaAddr.addressing,
          values: multiTokenFromCmlValue(output.amount(), {
            defaultIdentifier: PRIMARY_ASSET_CONSTANTS.Cardano,
            defaultNetworkId: networkId,
          }),
        });
      }
    }
    return { bodyBytes: body.to_cbor_bytes(), selectedUtxos, changeAddresses };
  });

  return {
    senderUtxos: result.selectedUtxos,
    txBuilder: result.bodyBytes,
    changeAddr: result.changeAddresses,
  };
}

type UtxoOrAddressing = CardanoAddressedUtxo | {| ...Address, ...Addressing |};

export async function signTransactionFromWallet(
  senderUtxos: Array<CardanoAddressedUtxo>,
  unsignedTx:
    | RustModule.WalletV4.Transaction
    | RustModule.WalletV4.TransactionBuilder
    | RustModule.WalletV4.TransactionBody
    | Buffer
    | Uint8Array,
  wallet: PublicDeriver<>,
  password: string,
  metadata: ?(RustModule.WalletV4.AuxiliaryData | Uint8Array),
  otherRequiredSigners: Array<{| ...Address, ...Addressing |}> = []
): Promise<RustModule.WalletV4.Transaction | Uint8Array> {
  const withSigning = asGetSigningKey(wallet);
  if (withSigning == null) {
    throw new Error('unexpected missing asGetSigningKey result');
  }
  const signingKey = await withSigning.getSigningKey();
  const normalizedKey = await withSigning.normalizeKey({
    ...signingKey,
    password,
  });
  const withStakingKey = asGetAllAccounting(withSigning);
  if (withStakingKey == null) {
    throw new Error('unexpected missing asGetAllAcccounting result');
  }
  const stakingKey = await genOwnStakingKey({
    publicDeriver: withStakingKey,
    password,
  });

  const allAddresses = await getAllAddressesForWallet(wallet);
  const addressPathByHash: Map<string, {| address: string, path: Array<number> |}> = new Map();
  for (const { address, path } of [...allAddresses.utxoAddresses, ...allAddresses.accountingAddresses]) {
    addressPathByHash.set(address.Hash.slice(2), { address: address.Hash, path });
  }

  let requiredSignerHashes: Array<string>;
  if (unsignedTx instanceof RustModule.WalletV4.Transaction) {
    requiredSignerHashes = iterateLenGet(unsignedTx.body().required_signers()).map(hash => hash.to_hex()).toArray();
  } else if (unsignedTx instanceof RustModule.WalletV4.TransactionBuilder) {
    const tx = unsignedTx.build_tx();
    requiredSignerHashes = iterateLenGet(tx.body().required_signers()).map(hash => hash.to_hex()).toArray();
  } else if (unsignedTx instanceof RustModule.WalletV4.TransactionBody) {
    requiredSignerHashes = iterateLenGet(unsignedTx.required_signers()).map(hash => hash.to_hex()).toArray();
  } else if (unsignedTx instanceof Buffer || unsignedTx instanceof Uint8Array) {
    requiredSignerHashes = RustModule.WasmScope(Module => {
      const required = Module.CML.TransactionBody.from_cbor_bytes(unsignedTx).required_signers();
      return required == null ? [] : Array.from({ length: required.len() }, (_, index) => required.get(index).to_hex());
    });
  } else {
    throw new Error('unexpected tx body type');
  }

  requiredSignerHashes.forEach(requiredSignerKeyHash => {
      if (addressPathByHash.has(requiredSignerKeyHash)) {
        const addressAndPath = forceNonNull(addressPathByHash.get(requiredSignerKeyHash));
        otherRequiredSigners.push({
          address: addressAndPath.address,
          addressing: {
            path: addressAndPath.path,
            startLevel: 1,
          },
        });
      }
    });

  return signTransaction(
    senderUtxos,
    unsignedTx,
    wallet.getParent().getPublicDeriverLevel(),
    RustModule.WalletV4.Bip32PrivateKey.from_hex(normalizedKey.prvKeyHex),
    stakingKey,
    metadata,
    otherRequiredSigners
  );
}

export function signTransaction(
  senderUtxos: Array<CardanoAddressedUtxo>,
  unsignedTx:
    | RustModule.WalletV4.Transaction
    | RustModule.WalletV4.TransactionBuilder
    | RustModule.WalletV4.TransactionBody
    | Buffer
    | Uint8Array,
  keyLevel: number,
  signingKey: RustModule.WalletV4.Bip32PrivateKey | RustModule.CML.Bip32PrivateKey,
  stakingKey: ?RustModule.WalletV4.PrivateKey,
  metadata: ?(RustModule.WalletV4.AuxiliaryData | Uint8Array),
  otherRequiredSigners: Array<{| ...Address, ...Addressing |}> = []
): RustModule.WalletV4.Transaction | Uint8Array {
  if (unsignedTx instanceof Buffer || unsignedTx instanceof Uint8Array) {
    return signCmlTransaction(
      senderUtxos,
      unsignedTx,
      keyLevel,
      signingKey,
      stakingKey,
      metadata,
      otherRequiredSigners
    );
  }
  const seenByronKeys: Set<string> = new Set();
  const seenKeyHashes: Set<string> = new Set();
  const deduped: Array<UtxoOrAddressing> = [];
  function addIfUnique(address: string, item: UtxoOrAddressing): void {
    const addressHex = normalizeToAddress(address);
    if (addressHex == null) {
      throw new Error(`${nameof(signTransaction)} utxo not a valid Shelley address`);
    }
    const keyHash = getCardanoSpendingKeyHash(addressHex);
    const addrHex = addressHex;
    if (keyHash === null) {
      if (!seenByronKeys.has(addrHex)) {
        seenByronKeys.add(addrHex);
        deduped.push(item);
      }
      return;
    }
    if (keyHash === undefined) {
      throw new Error(`${nameof(signTransaction)} cannot sign script inputs`);
    }
    {
      if (!seenKeyHashes.has(keyHash)) {
        seenKeyHashes.add(keyHash);
        deduped.push(item);
      }
    }
  }
  for (const senderUtxo of senderUtxos) {
    addIfUnique(senderUtxo.receiver, senderUtxo);
  }
  for (const otherSigner of otherRequiredSigners) {
    addIfUnique(otherSigner.address, otherSigner);
  }

  let txBody;
  let txHash;
  let txWitSet;
  if (unsignedTx instanceof RustModule.WalletV4.Transaction) {
    txBody = unsignedTx.body();
    txWitSet = unsignedTx.witness_set();
    txHash = RustModule.WalletV4.FixedTransaction.from_hex(unsignedTx.to_hex()).transaction_hash();
  } else if (unsignedTx instanceof RustModule.WalletV4.TransactionBuilder) {
    const tx = unsignedTx.build_tx();
    txBody = tx.body();
    txWitSet = tx.witness_set();
    txHash = RustModule.WalletV4.FixedTransaction.from_hex(tx.to_hex()).transaction_hash();
  } else if (unsignedTx instanceof RustModule.WalletV4.TransactionBody) {
    txBody = unsignedTx;
    txHash = RustModule.WalletV4.FixedTransaction.new_from_body_bytes(txBody.to_bytes()).transaction_hash();
  } else if (unsignedTx instanceof Buffer || unsignedTx instanceof Uint8Array) {
    // note: we are calculating the tx hash from the raw tx body bytes, which
    // probably won't match the serialized `txBody`. But this happens only for
    // connector signing and only the witness will be returned so this is more
    // likely to match what the client expects.
    txBody = RustModule.WalletV4.TransactionBody.from_bytes(unsignedTx);
    txHash = RustModule.WalletV4.TransactionHash.from_bytes(
      blake2b(256 / 8)
        .update(unsignedTx)
        .digest('binary')
    );
  } else {
    throw new Error('unexpected tx body type');
  }

  const witnessSet = txWitSet ?? RustModule.WalletV4.TransactionWitnessSet.new();
  const vkeyWits = witnessSet.vkeys() ?? RustModule.WalletV4.Vkeywitnesses.new();
  const bootstrapWits = witnessSet.bootstraps() ?? RustModule.WalletV4.BootstrapWitnesses.new();

  addWitnesses(txHash, deduped, keyLevel, (signingKey: any), vkeyWits, bootstrapWits);

  const stakingKeyHashesInTx = getStakingKeyHashesInTransactionBody(txBody.to_hex());
  if (stakingKeyHashesInTx.size > 0) {
    if (stakingKey == null) {
      console.warn('Transaction in signing contains staking credentials but no staking key is provided. Cannot fully sign.');
    } else {
      const ownStakingKeyHash = stakingKey.to_public().hash().to_hex();
      if (stakingKeyHashesInTx.has(ownStakingKeyHash)) {
        vkeyWits.add(RustModule.WalletV4.make_vkey_witness(txHash, stakingKey));
      }
      if (stakingKeyHashesInTx.size > 1) {
        const foreignStakingKeyHashes = [...stakingKeyHashesInTx].filter(x => x !== ownStakingKeyHash);
        console.warn(
          `Transaction in signing contains foreign staking credentials hashes '${JSON.stringify(foreignStakingKeyHashes)}' which do not match own staking key '${String(ownStakingKeyHash)}'. Cannot fully sign.`
        );
      }
    }
  }

  if (bootstrapWits.len() > 0) witnessSet.set_bootstraps(bootstrapWits);
  if (vkeyWits.len() > 0) witnessSet.set_vkeys(vkeyWits);

  // Have to do this, because `Transaction.new` receives by value instead of reference
  // <TODO:SERLIB_REFERENCE_CALL_FIX>
  const metadataClone = metadata == null
    ? null
    : RustModule.WalletV4.AuxiliaryData.from_bytes(Buffer.from(metadata instanceof Uint8Array ? metadata : metadata.to_bytes()));

  return RustModule.WalletV4.Transaction.new(
    txBody,
    witnessSet,
    // $FlowFixMe[incompatible-call]
    metadataClone
  );
}

function signCmlTransaction(
  senderUtxos: Array<CardanoAddressedUtxo>,
  bodyBytes: Uint8Array,
  keyLevel: number,
  signingKey: RustModule.WalletV4.Bip32PrivateKey | RustModule.CML.Bip32PrivateKey,
  stakingKey: ?RustModule.WalletV4.PrivateKey,
  metadata: ?(RustModule.WalletV4.AuxiliaryData | Uint8Array),
  otherRequiredSigners: Array<{| ...Address, ...Addressing |}>
): Uint8Array {
  const uniqueAddressings: Array<UtxoOrAddressing> = [];
  const seen = new Set();
  for (const item of [...senderUtxos, ...otherRequiredSigners]) {
    const address = item.receiver ?? item.address;
    if (address == null) throw new Error('Missing address for signing');
    const addressHex = normalizeAddressToHex(address);
    const keyHash = getCardanoSpendingKeyHash(addressHex);
    if (keyHash === undefined) throw new Error(`${nameof(signTransaction)} cannot sign script inputs`);
    const uniqueKey = keyHash == null ? addressHex : keyHash;
    if (!seen.has(uniqueKey)) {
      seen.add(uniqueKey);
      uniqueAddressings.push(item);
    }
  }

  return RustModule.WasmScope(Module => {
    const cml = Module.CML;
    const body = cml.TransactionBody.from_cbor_bytes(bodyBytes);
    const txHash = cml.hash_transaction(body);
    const witnessBuilder = cml.TransactionWitnessSetBuilder.new();
    const signingKeyBytes =
      typeof ((signingKey: any).to_raw_bytes) === 'function' ? (signingKey: any).to_raw_bytes() : (signingKey: any).as_bytes();
    const cmlSigningKey = cml.Bip32PrivateKey.from_raw_bytes(signingKeyBytes);
    for (const item of uniqueAddressings) {
      const lastLevelSpecified = item.addressing.startLevel + item.addressing.path.length - 1;
      if (lastLevelSpecified !== Bip44DerivationLevels.ADDRESS.level) {
        throw new Error(`${nameof(addWitnesses)} incorrect addressing size`);
      }
      const firstPathIndex = keyLevel - item.addressing.startLevel + 1;
      if (firstPathIndex < 0) throw new Error(`${nameof(addWitnesses)} key level is before the addressing start level`);
      let derived = cmlSigningKey;
      for (let i = firstPathIndex; i < item.addressing.path.length; i++) {
        const index = item.addressing.path[i];
        if (index == null) throw new Error(`${nameof(addWitnesses)} invalid key derivation path`);
        derived = derived.derive(index);
      }
      const address = item.receiver ?? item.address;
      const cmlAddress = cml.Address.from_hex(address);
      const byronAddress = cml.ByronAddress.from_address(cmlAddress);
      if (byronAddress == null) witnessBuilder.add_vkey(cml.make_vkey_witness(txHash, derived.to_raw_key()));
      else witnessBuilder.add_bootstrap(cml.make_icarus_bootstrap_witness(txHash, byronAddress, derived));
    }

    const stakingHashes = getStakingKeyHashesInTransactionBody(body.to_cbor_hex());
    if (stakingHashes.size > 0 && stakingKey != null) {
      const cmlStakingKey = cml.PrivateKey.from_extended_bytes(stakingKey.as_bytes());
      const stakingKeyHash = cmlStakingKey.to_public().hash().to_hex();
      if (stakingHashes.has(stakingKeyHash)) {
        witnessBuilder.add_vkey(cml.make_vkey_witness(txHash, cmlStakingKey));
      }
    }
    const witnesses = witnessBuilder.build();
    const cmlMetadata = metadata == null
      ? undefined
      : cml.AuxiliaryData.from_cbor_bytes(metadata instanceof Uint8Array ? metadata : metadata.to_bytes());
    return cml.Transaction.new(body, witnesses, true, cmlMetadata).to_cbor_bytes();
  });
}

function utxoToTxInput(utxo: RemoteUnspentOutput): RustModule.WalletV4.TransactionInput {
  return RustModule.WalletV4.TransactionInput.new(RustModule.WalletV4.TransactionHash.from_hex(utxo.tx_hash), utxo.tx_index);
}

function addWitnesses(
  txHash: RustModule.WalletV4.TransactionHash,
  uniqueAddressings: Array<UtxoOrAddressing>, // pre-req: does not contain duplicate keys
  keyLevel: number,
  signingKey: RustModule.WalletV4.Bip32PrivateKey,
  vkeyWits: RustModule.WalletV4.Vkeywitnesses,
  bootstrapWits: RustModule.WalletV4.BootstrapWitnesses
): void {
  // get private keys
  const privateKeys = uniqueAddressings.map(utxo => {
    const lastLevelSpecified = utxo.addressing.startLevel + utxo.addressing.path.length - 1;
    if (lastLevelSpecified !== Bip44DerivationLevels.ADDRESS.level) {
      throw new Error(`${nameof(addWitnesses)} incorrect addressing size`);
    }
    return derivePrivateByAddressing({
      addressing: utxo.addressing,
      startingFrom: {
        level: keyLevel,
        key: signingKey,
      },
    });
  });

  // sign the transactions
  for (let i = 0; i < uniqueAddressings.length; i++) {
    const uniqueAddressing = uniqueAddressings[i];
    const resolveAddress = (): string => {
      if (uniqueAddressing.receiver != null) return uniqueAddressing.receiver;
      if (uniqueAddressing.address != null) return uniqueAddressing.address;
      throw new Error(`[addWitnesses] Unexpected addressing for signing: ${JSON.stringify(uniqueAddressing)}`);
    };
    const addressHex = normalizeToAddress(resolveAddress());
    if (addressHex == null) {
      throw new Error(`${nameof(addWitnesses)} utxo not a valid Shelley address`);
    }
    const byronAddr = RustModule.WalletV4.ByronAddress.from_address(RustModule.WalletV4.Address.from_hex(addressHex));
    if (byronAddr == null) {
      const vkeyWit = RustModule.WalletV4.make_vkey_witness(txHash, privateKeys[i].to_raw_key());
      vkeyWits.add(vkeyWit);
    } else {
      const bootstrapWit = RustModule.WalletV4.make_icarus_bootstrap_witness(txHash, byronAddr, privateKeys[i]);
      bootstrapWits.add(bootstrapWit);
    }
  }
}

export function genFilterSmallUtxo(request: {|
  protocolParams: {|
    linearFee: RustModule.WalletV4.LinearFee,
  |},
|}): RemoteUnspentOutput => boolean {
  const txBuilder = RustModule.WalletV4TxBuilder({
    linearFee: request.protocolParams.linearFee,
    // no need for the following parameters just to calculate the fee of adding a UTXO
    coinsPerUtxoByte: RustModule.WalletV4.BigNum.zero(),
    poolDeposit: RustModule.WalletV4.BigNum.zero(),
    keyDeposit: RustModule.WalletV4.BigNum.zero(),
  });

  return utxo => {
    const addressHex = normalizeToAddress(utxo.receiver);
    if (addressHex == null) {
      throw new Error(`${nameof(genFilterSmallUtxo)} input not a valid Shelley address`);
    }
    const wasmAmount = cardanoValueFromRemoteFormat(utxo);
    const feeForInput = new BigNumber(
      txBuilder.fee_for_input(RustModule.WalletV4.Address.from_hex(addressHex), utxoToTxInput(utxo), wasmAmount).to_str()
    );
    return feeForInput.lte(utxo.amount);
  };
}
