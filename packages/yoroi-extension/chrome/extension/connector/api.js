// @flow

import type { AccountBalance, Address, Asset, CardanoTx, Paginate, TokenId, Value } from './types';
import { ConnectorError, TxSendErrorCodes } from './types';
import { RustModule } from '../../../app/api/ada/lib/cardanoCrypto/rustLoader';
import type { Addressing, IPublicDeriver } from '../../../app/api/ada/lib/storage/models/PublicDeriver/interfaces';
import { PublicDeriver } from '../../../app/api/ada/lib/storage/models/PublicDeriver/index';
import {
  asGetAllUtxos,
  asGetBalance,
  asGetPublicKey,
  asHasUtxoChains,
} from '../../../app/api/ada/lib/storage/models/PublicDeriver/traits';
import BigNumber from 'bignumber.js';

import { NotEnoughMoneyToSendError } from '../../../app/api/common/errors';

import { CoreAddressTypes, TxStatusCodes } from '../../../app/api/ada/lib/storage/database/primitives/enums';
import type { FullAddressPayload } from '../../../app/api/ada/lib/storage/bridge/traitUtils';
import { getAllAddresses, getAllAddressesForDisplay } from '../../../app/api/ada/lib/storage/bridge/traitUtils';
import { getReceiveAddress } from '../../../app/stores/stateless/addressStores';

import type { PersistedSubmittedTransaction } from '../../../app/api/localStorage';
import LocalStorageApi, { loadSubmittedTransactions, persistSubmittedTransactions } from '../../../app/api/localStorage';

import {
  asAddressedUtxo as asAddressedUtxoCardano,
  cardanoValueFromRemoteFormat,
  parseTokenList,
} from '../../../app/api/ada/transactions/utils';
import type { AccountStateRequest, AccountStateResponse, RemoteUnspentOutput } from '../../../app/api/ada/lib/state-fetch/types';
import { signTransactionFromWallet as shelleySignTransactionFromWallet } from '../../../app/api/ada/transactions/shelley/transactions';
import { getCardanoHaskellBaseConfig, getNetworkById } from '../../../app/api/ada/lib/storage/database/prepackaged/networks';
import TimeUtils from '../../../app/api/ada/lib/storage/bridge/timeUtils';
import type { CardanoTxRequest, ForeignUtxoFetcher } from '../../../app/api/ada';
import AdaApi, { getDRepKeyAndAddressing, pubKeyAndAddressingByChainAndIndex } from '../../../app/api/ada';
import { bytesToHex, ensureArray, hexToBytes, iterateLenGet, iterateLenGetMap, maybe } from '../../../app/coreUtils';
import { MultiToken } from '../../../app/api/common/lib/MultiToken';
import type { CardanoShelleyTransactionCtorData } from '../../../app/domain/CardanoShelleyTransaction';
import type { CardanoAddressedUtxo } from '../../../app/api/ada/transactions/types';
import { GetToken } from '../../../app/api/ada/lib/storage/database/primitives/api/read';
import { getAllSchemaTables, raii } from '../../../app/api/ada/lib/storage/database/utils';
import type { TokenRow } from '../../../app/api/ada/lib/storage/database/primitives/tables';
import { ChainDerivations, DREP_KEY_INDEX, STAKING_KEY_INDEX } from '../../../app/config/numbersConfig';
import { pubKeyHashToRewardAddress, transactionHexToHash } from '../../../app/api/ada/lib/cardanoCrypto/utils';
import { sendTx } from '../../../app/api/ada/lib/state-fetch/remoteFetcher';
import type { WalletState } from '../background/types';
import type { ProtocolParameters } from '../../../app/api/ada/lib/state-fetch/protocolParameters';
import { isCertificateKindDrepDelegation } from '../../../app/api/ada/lib/storage/bridge/utils';
import { signCip103Batch } from './cip103';

export { ConnectorBatchSignError } from './cip103';

function paginateResults<T>(results: T[], paginate: ?Paginate): T[] {
  if (paginate != null) {
    const startIndex = paginate.page * paginate.limit;
    if (startIndex >= results.length) {
      throw new ConnectorError({
        maxSize: results.length,
      });
    }
    return results.slice(startIndex, Math.min(startIndex + paginate.limit, results.length));
  }
  return results;
}

function bigNumberToValue(x: BigNumber): Value {
  // we could test and return as numbers potentially
  // but we'll keep it as this to make sure the rest of the code is compliant
  return x.toString();
}

export async function connectorGetBalance(wallet: PublicDeriver<>, tokenId: TokenId): Promise<AccountBalance | Value> {
  if (tokenId === 'ADA' || tokenId === 'TADA') {
    // can directly query for balance
    const canGetBalance = asGetBalance(wallet);
    if (canGetBalance != null) {
      const balance = await canGetBalance.getBalance();
      return Promise.resolve(bigNumberToValue(balance.getDefault()));
    }
    throw Error('asGetBalance failed in connectorGetBalance');
  } else {
    // can directly query for balance
    const canGetBalance = asGetBalance(wallet);
    if (canGetBalance != null) {
      const balance = await canGetBalance.getBalance();
      const nonDefaultEntries = balance.nonDefaultEntries();
      if (tokenId === '*') {
        return Promise.resolve({
          default: bigNumberToValue(balance.getDefault()),
          networkId: balance.getDefaultEntry().networkId,
          assets: nonDefaultEntries.map(e => ({
            identifier: e.identifier,
            networkId: e.networkId,
            amount: bigNumberToValue(e.amount),
          })),
        });
      }
      const entry = nonDefaultEntries.find(e => e.identifier === tokenId);
      return Promise.resolve(bigNumberToValue(entry?.amount || new BigNumber(0)));
    }
    throw Error('asGetBalance failed in connectorGetBalance');
  }
}

export async function connectorGetAssets(wallet: PublicDeriver<>): Promise<Array<Asset>> {
  const canGetBalance = asGetBalance(wallet);
  if (canGetBalance != null) {
    const balance = await canGetBalance.getBalance();
    const nonDefaultEntries = balance.nonDefaultEntries();
    return Promise.resolve(
      nonDefaultEntries.map(e => ({
        identifier: e.identifier,
        networkId: e.networkId,
        amount: bigNumberToValue(e.amount),
      }))
    );
  }
  throw Error('asGetBalance failed in connectorGetAssets');
}

export async function selectCmlUtxosForValue(
  formattedUtxos: Array<RemoteUnspentOutput>,
  valueString: string,
  coinsPerUtxoByte: string
): Promise<Array<RemoteUnspentOutput>> {
  if (formattedUtxos.length === 0) throw new NotEnoughMoneyToSendError();
  await RustModule.load();
  return RustModule.WasmScope(Module => {
    const cml = Module.CML;
    let requestedValue;
    try {
      requestedValue = /^\d+$/.test(valueString)
        // eslint-disable-next-line no-undef
        ? cml.Value.from_coin(BigInt(valueString))
        : cml.Value.from_cbor_hex(valueString);
    } catch (error) {
      throw ConnectorError.invalidRequest(
        `Invalid required value string "${valueString}". Expected an int number or a hex of serialized Value instance. Cause: ${String(error)}`
      );
    }
    const targetAddress = cml.Address.from_hex(formattedUtxos[0].receiver);
    let targetOutput = cml.TransactionOutput.new(targetAddress, requestedValue);
    // eslint-disable-next-line no-undef
    const minAda = cml.min_ada_required(targetOutput, BigInt(coinsPerUtxoByte));
    if (requestedValue.coin() < minAda) {
      targetOutput = cml.TransactionOutput.new(targetAddress, cml.Value.new(minAda, requestedValue.multi_asset()));
    }

    const required = cml.Value.from_cbor_bytes(targetOutput.amount().to_cbor_bytes());
    const requestedAssets = [];
    const requestedMultiAsset = required.multi_asset();
    const policies = requestedMultiAsset.keys();
    for (let policyIndex = 0; policyIndex < policies.len(); policyIndex++) {
      const policy = policies.get(policyIndex);
      const assets = requestedMultiAsset.get_assets(policy);
      if (assets == null) continue;
      const names = assets.keys();
      for (let assetIndex = 0; assetIndex < names.len(); assetIndex++) {
        const asset = names.get(assetIndex);
        requestedAssets.push({ policy: policy.to_hex(), asset: asset.to_hex() });
      }
    }
    const candidates = formattedUtxos.map(utxo => {
      const value = cardanoValueFromRemoteFormat(utxo);
      const multiAsset = value.multi_asset();
      const matchingAssets = requestedAssets.reduce((count, requested) => {
        const assets = multiAsset.get_assets(cml.ScriptHash.from_hex(requested.policy));
        return count + (assets?.get(cml.AssetName.from_hex(requested.asset)) != null ? 1 : 0);
      }, 0);
      return { utxo, value, matchingAssets };
    });
    const collateralReserve = [];
    const spendable = [];
    for (const candidate of candidates) {
      if (candidate.utxo.assets.length === 0 && candidate.value.coin() <= 2000000n && collateralReserve.length < 3) {
        collateralReserve.push(candidate);
      } else {
        spendable.push(candidate);
      }
    }
    const config = cml.TransactionBuilderConfigBuilder.new()
      .fee_algo(cml.LinearFee.new(44n, 155381n, 0n))
      // eslint-disable-next-line no-undef
      .coins_per_utxo_byte(BigInt(coinsPerUtxoByte))
      .pool_deposit(0n)
      .key_deposit(0n)
      .max_value_size(5000)
      .max_tx_size(16384)
      .ex_unit_prices(cml.ExUnitPrices.new(cml.Rational.new(577n, 10000n), cml.Rational.new(721n, 10000000n)))
      .collateral_percentage(150)
      .max_collateral_inputs(3)
      .build();
    const builder = cml.TransactionBuilder.new(config);
    builder.add_output(cml.SingleOutputBuilderResult.new(targetOutput));
    const candidatesByRef = new Map();
    for (const candidate of spendable) {
      const input = cml.TransactionInput.new(
        cml.TransactionHash.from_hex(candidate.utxo.tx_hash),
        // eslint-disable-next-line no-undef
        BigInt(candidate.utxo.tx_index)
      );
      const output = cml.TransactionOutput.new(
        cml.Address.from_hex(candidate.utxo.receiver),
        candidate.value
      );
      builder.add_utxo(cml.SingleInputBuilder.new(input, output).payment_key());
      candidatesByRef.set(`${candidate.utxo.tx_hash}${candidate.utxo.tx_index}`, candidate);
    }
    const hasRequestedAssets = requestedAssets.length > 0;
    try {
      builder.select_utxos(
        hasRequestedAssets
          ? cml.CoinSelectionStrategyCIP2.LargestFirstMultiAsset
          : cml.CoinSelectionStrategyCIP2.LargestFirst
      );
      builder.add_change_if_needed(targetAddress, false);
    } catch (error) {
      if (/Insufficient|Not enough ADA/i.test(String(error))) throw new NotEnoughMoneyToSendError();
      throw error;
    }
    const body = builder.build(cml.ChangeSelectionAlgo.Default, targetAddress).body();
    const selected = [];
    const selectedRefs = new Set();
    let selectedTotal = cml.Value.zero();
    for (let index = 0; index < body.inputs().len(); index++) {
      const input = body.inputs().get(index);
      const ref = `${input.transaction_id().to_hex()}${input.index()}`;
      const candidate = candidatesByRef.get(ref);
      if (candidate == null) throw new Error('CML selected an unknown connector UTxO');
      selected.push(candidate.utxo);
      selectedRefs.add(ref);
      selectedTotal = selectedTotal.checked_add(candidate.value);
    }
    // eslint-disable-next-line no-undef
    const desiredAda = required.coin() * 2n + 2000000n + BigInt(Math.max(3 - collateralReserve.length, 0)) * 1000000n;
    if (selectedTotal.coin() < desiredAda && selected.length < 50) {
      const improvements = spendable
        .filter(candidate => !selectedRefs.has(`${candidate.utxo.tx_hash}${candidate.utxo.tx_index}`))
        .sort((left, right) => {
          const assetDiff = right.matchingAssets - left.matchingAssets;
          return assetDiff !== 0 ? assetDiff : left.value.coin() > right.value.coin() ? -1 : 1;
        });
      for (const candidate of improvements) {
        selected.push(candidate.utxo);
        selectedTotal = selectedTotal.checked_add(candidate.value);
        if (selectedTotal.coin() >= desiredAda || selected.length >= 50) break;
      }
    }
    return selected;
  });
}

export async function connectorGetUtxosCardano(
  wallet: PublicDeriver<>,
  valueExpected: ?Value,
  paginate: ?Paginate,
  coinsPerUtxoByte: string
): Promise<Array<RemoteUnspentOutput>> {
  const withUtxos = asGetAllUtxos(wallet);
  if (withUtxos == null) {
    throw new Error("wallet doesn't support IGetAllUtxos");
  }
  const utxos = await withUtxos.getAllUtxos();
  const toRemoteUnspentOutput = (utxo: CardanoAddressedUtxo): RemoteUnspentOutput => ({
    amount: utxo.amount,
    receiver: utxo.receiver,
    tx_hash: utxo.tx_hash,
    tx_index: utxo.tx_index,
    utxo_id: utxo.utxo_id,
    assets: utxo.assets,
  });
  const submittedTxs = (await loadSubmittedTransactions()) || [];
  const adaApi = new AdaApi();
  const formattedUtxos: Array<RemoteUnspentOutput> = adaApi.utxosWithSubmittedTxs(
    asAddressedUtxoCardano(utxos).map(toRemoteUnspentOutput),
    wallet.publicDeriverId,
    submittedTxs
  );
  const valueStr = valueExpected?.trim() ?? '';
  if (valueStr.length === 0) {
    return Promise.resolve(paginateResults(formattedUtxos, paginate));
  }

  return selectCmlUtxosForValue(formattedUtxos, valueStr, coinsPerUtxoByte);
}

export const MAX_COLLATERAL: BigNumber = new BigNumber('5000000');
// only consider UTXO value <= (${requiredAmount} + 1 ADA)
const MAX_PER_UTXO_SURPLUS = new BigNumber('2000000');
// Max allowed collateral inputs in a tx by protocol
const MAX_COLLATERAL_COUNT: number = 3;

type GetCollateralUtxosRespose = {|
  utxosToUse: Array<RemoteUnspentOutput>,
  reorgTargetAmount: ?string,
|};

export async function connectorGetCollateralUtxos(
  wallet: PublicDeriver<>,
  requiredAmount: Value,
  utxos: Array<RemoteUnspentOutput>,
  submittedTxs: Array<PersistedSubmittedTransaction>
): Promise<GetCollateralUtxosRespose> {
  const required = new BigNumber(requiredAmount);
  if (required.gt(MAX_COLLATERAL)) {
    throw new Error('requested collateral amount is beyond the allowed limits');
  }
  const adaApi = new AdaApi();
  const maxViableUtxoAmount = required.plus(MAX_PER_UTXO_SURPLUS);
  const utxosToConsider = adaApi
    .utxosWithSubmittedTxs(utxos, wallet.publicDeriverId, submittedTxs)
    .filter(utxo => utxo.assets.length === 0 && new BigNumber(utxo.amount).lt(maxViableUtxoAmount));
  utxosToConsider.sort((utxo1, utxo2) => new BigNumber(utxo1.amount).comparedTo(utxo2.amount));
  const utxosToUse = [];
  let sum = new BigNumber('0');
  let enough = false;
  for (const utxo of utxosToConsider) {
    utxosToUse.push(utxo);
    sum = sum.plus(utxo.amount);
    while (utxosToUse.length > MAX_COLLATERAL_COUNT || sum.minus(utxosToUse[0].amount).gte(required)) {
      // Removing the first (hence the smallest) utxo from the list
      const removedUtxo = utxosToUse.shift();
      sum = sum.minus(removedUtxo.amount);
    }
    if (sum.gte(required)) {
      enough = true;
      break;
    }
  }
  if (enough) {
    for (;;) {
      const smallestUtxo = utxosToUse[0];
      const potentialSum = sum.minus(smallestUtxo.amount);
      if (potentialSum.gte(required)) {
        // First utxo can be removed and still will be enough.
        utxosToUse.shift();
        sum = potentialSum;
      } else {
        break;
      }
    }
    return { utxosToUse, reorgTargetAmount: null };
  }

  return {
    utxosToUse,
    reorgTargetAmount: required.minus(sum).toString(),
  };
}

type FullAddressPayloadWithBase58 = {|
  fullAddress: FullAddressPayload,
  base58: Address,
|};

async function getCardanoRewardAddresses(wallet: IPublicDeriver<>): Promise<FullAddressPayloadWithBase58[]> {
  const isCardano = wallet.getParent().defaultToken.Metadata.type === 'Cardano';
  if (!isCardano) {
    throw new Error('Invalid wallet for a cardano request');
  }
  const type = CoreAddressTypes.CARDANO_REWARD;
  const promise = getAllAddressesForDisplay({ publicDeriver: wallet, type });
  await RustModule.load();
  const addresses: FullAddressPayload[] = await promise;
  return addresses.map(a => {
    return {
      fullAddress: a,
      base58: a.address,
    };
  });
}

async function getOutputAddressesInSubmittedTxs(publicDeriverId: number) {
  const submittedTxs = (await loadSubmittedTransactions()) || [];
  const walletSubmittedTxs = submittedTxs.filter(submittedTxRecord => submittedTxRecord.publicDeriverId === publicDeriverId);
  return _getOutputAddressesInSubmittedTxs(walletSubmittedTxs);
}

export function _getOutputAddressesInSubmittedTxs(walletSubmittedTxs: Array<PersistedSubmittedTransaction>): Array<string> {
  return walletSubmittedTxs.flatMap(({ transaction }) => {
    return transaction.addresses.to.map(({ address }) => address);
  });
}

export async function connectorGetUsedAddressesWithPaginate(wallet: PublicDeriver<>, paginate: ?Paginate): Promise<Address[]> {
  const usedAddresses = await getAllAddresses(wallet, true);
  const unusedAddresses = await getAllAddresses(wallet, false);
  const outputAddressesInSubmittedTxs = new Set(await getOutputAddressesInSubmittedTxs(wallet.publicDeriverId));
  return _connectorGetUsedAddressesWithPaginate(usedAddresses, unusedAddresses, outputAddressesInSubmittedTxs, paginate);
}
export async function _connectorGetUsedAddressesWithPaginate(
  usedAddresses: Array<string>,
  unusedAddresses: Array<string>,
  outputAddressesInSubmittedTxs: Set<string>,
  paginate: ?Paginate
): Promise<Address[]> {
  const usedInSubmittedTxs = unusedAddresses.filter(address => outputAddressesInSubmittedTxs.has(address));

  return paginateResults([...usedAddresses, ...usedInSubmittedTxs], paginate);
}

export async function connectorGetUnusedAddresses(wallet: PublicDeriver<>): Promise<Address[]> {
  const submittedTxs = (await loadSubmittedTransactions()) || [];

  return _connectorGetUnusedAddresses(
    await getAllAddresses(wallet, false),
    submittedTxs.filter(submittedTxRecord => submittedTxRecord.publicDeriverId === wallet.publicDeriverId)
  );
}
export async function _connectorGetUnusedAddresses(
  unusedAddresses: Array<Address>,
  walletSubmittedTxs: Array<PersistedSubmittedTransaction>
): Promise<Address[]> {
  const outputAddressesInSubmittedTxs = new Set(_getOutputAddressesInSubmittedTxs(walletSubmittedTxs));
  return unusedAddresses.filter(address => !outputAddressesInSubmittedTxs.has(address));
}

export async function connectorGetDRepKey(wallet: PublicDeriver<>): Promise<string> {
  return (await getDRepKeyAndAddressing(wallet))[0].to_hex();
}

export function getDrepRewardAddressHexAndAddressing(wallet: WalletState): [string, Addressing] {
  const [pubKey, addressing] = pubKeyAndAddressingByChainAndIndex(wallet, ChainDerivations.GOVERNANCE_DREP_KEYS, DREP_KEY_INDEX);
  // <TODO:WALLET_API>
  const config = getCardanoHaskellBaseConfig(getNetworkById(wallet.networkId)).reduce(
    (acc, next) => Object.assign(acc, next),
    {}
  );
  const network = parseInt(config.ChainNetworkId, 10);
  return [pubKeyHashToRewardAddress(pubKey.hash().to_hex(), network), addressing];
}

export async function connectorGetStakeKey(
  wallet: PublicDeriver<>,
  getAccountState: AccountStateRequest => Promise<AccountStateResponse>
): Promise<{| key: string, isRegistered: boolean |}> {
  const withPubKey = asGetPublicKey(wallet);
  if (withPubKey == null) {
    throw new Error('Unable to get public key from the wallet');
  }
  const publicKey = (await withPubKey.getPublicKey()).Hash;
  const publicDeriverLevel = wallet.getParent().getPublicDeriverLevel();
  const stakeKey = pubKeyAndAddressingByChainAndIndex(
    { publicKey, publicDeriverLevel },
    ChainDerivations.CHIMERIC_ACCOUNT,
    STAKING_KEY_INDEX
  )[0];
  const network = wallet.getParent().getNetworkInfo();
  const stakeAddrHex = RustModule.WasmScope(Module => {
    return Module.CML.RewardAddress.new(
      Number.parseInt(network.BaseConfig[0].ChainNetworkId, 10),
      Module.CML.Credential.new_pub_key(stakeKey.hash())
    )
      .to_address()
      .to_hex();
  });
  const accountState = await getAccountState({
    addresses: [stakeAddrHex],
    network,
  });
  return {
    // $FlowFixMe
    key: stakeKey.to_hex(),
    isRegistered: accountState[stakeAddrHex]?.stakeRegistered ?? false,
  };
}

export async function connectorGetCardanoRewardAddresses(wallet: PublicDeriver<>): Promise<Address[]> {
  return getCardanoRewardAddresses(wallet).then(arr => arr.map(a => a.base58));
}

export async function connectorGetChangeAddress(wallet: PublicDeriver<>): Promise<Address> {
  const change = await getReceiveAddress(wallet);
  if (change == null) {
    throw new Error('could not get change address - this should never happen');
  }
  return change.addr.Hash;
}

export function getScriptRequiredSigningKeys(
  witnessSet: any,
  // eslint-disable-next-line no-shadow
  RustModule: typeof RustModule
): Set<string> {
  const nativeScripts = witnessSet?.native_scripts();
  return iterateLenGet(nativeScripts)
    .flatMap(ns => iterateLenGet(ns.get_required_signers()))
    .map(requiredKeyHash => requiredKeyHash.to_hex())
    .toSet();
}

function getTxRequiredSigningKeys(txBody: any): Set<string> {
  return iterateLenGet(txBody.required_signers())
    .map(requiredKeyHash => requiredKeyHash.to_hex())
    .toSet();
}

const CERT_TO_KEYHASH_FUNCS: Array<[any, any]> = [
  [cert => cert.as_stake_deregistration(), cert => cert.stake_credential().as_pub_key()],
  [cert => cert.as_stake_delegation(), cert => cert.stake_credential().as_pub_key()],
  [cert => cert.as_vote_deleg_cert(), cert => cert.stake_credential().as_pub_key()],
  [cert => cert.as_stake_vote_deleg_cert(), cert => cert.stake_credential().as_pub_key()],
  [cert => cert.as_stake_reg_deleg_cert(), cert => cert.stake_credential().as_pub_key()],
  [cert => cert.as_stake_vote_reg_deleg_cert(), cert => cert.stake_credential().as_pub_key()],
  [cert => cert.as_reg_drep_cert(), cert => cert.drep_credential().as_pub_key()],
  [cert => cert.as_unreg_drep_cert(), cert => cert.drep_credential().as_pub_key()],
  [cert => cert.as_update_drep_cert(), cert => cert.drep_credential().as_pub_key()],
  [cert => cert.as_pool_registration(), cert => iterateLenGet(cert.pool_params().pool_owners()).toArray()],
];

export function getCertificatesRequiredSignKeys(txBody: any): Set<string> {
  const certSigners = iterateLenGet(txBody.certs())
    .nonNull()
    .flatMap(cert => {
      for (const [convertFunc, getKeyhashFunc] of CERT_TO_KEYHASH_FUNCS) {
        const result = maybe(convertFunc(cert), getKeyhashFunc);
        if (result != null) return ensureArray(result);
      }
      return [];
    });

  const votingSigners = iterateLenGet(txBody.voting_procedures()?.get_voters())
    .nonNull()
    .map(voter => voter.as_d_rep_key_hash())
    .nonNull();

  return certSigners
    .join(votingSigners)
    .map(hash => hash.to_hex())
    .toSet();
}

/**
 * Returns HEX of a serialised witness set
 */
export async function connectorSignCardanoTx(publicDeriver: PublicDeriver<>, password: string, tx: CardanoTx): Promise<string> {
  return RustModule.WasmScope(Module => __connectorSignCardanoTx(publicDeriver, password, tx, [], Module));
}

export async function connectorSignCardanoTxs(
  publicDeriver: PublicDeriver<>,
  password: string,
  txs: Array<CardanoTx>
): Promise<Array<string>> {
  const ownAddresses = await getAllAddressesForDisplay({
    publicDeriver,
    type: CoreAddressTypes.CARDANO_BASE,
    ignoreCutoff: true,
  });
  const ownAddressMap = new Map(ownAddresses.map(({ address, addressing }) => [address, addressing]));
  return signCip103Batch(
    txs,
    (tx, chainedUtxos) =>
      RustModule.WasmScope(Module => __connectorSignCardanoTx(publicDeriver, password, tx, chainedUtxos, Module)),
    tx =>
      RustModule.WasmScope(Module => {
        const { txBody } = resolveTxOrTxBody(tx, Module);
        const txHash = Module.CML.hash_transaction(txBody).to_hex();
        const outputs = [];
        for (let outputIndex = 0; outputIndex < txBody.outputs().len(); outputIndex++) {
          const output = txBody.outputs().get(outputIndex);
          const receiver = output.address().to_hex();
          const addressing = ownAddressMap.get(receiver);
          if (addressing != null) {
            outputs.push({
              amount: output.amount().coin().to_str(),
              assets: parseTokenList(output.amount().multiasset()),
              receiver,
              tx_hash: txHash,
              tx_index: outputIndex,
              utxo_id: txHash + String(outputIndex),
              addressing,
            });
          }
        }
        return outputs;
      })
  );
}

export function resolveTxOrTxBody(
  tx: CardanoTx,
  // eslint-disable-next-line no-shadow
  RustModule: typeof RustModule
): {|
  txBody: any,
  rawTxBody: Buffer,
  witnessSet: ?any,
  auxiliaryData: ?any,
|} {
  const { tx: txHex } = tx;
  let txBody: any;
  let witnessSet: ?any;
  let auxiliaryData: ?any;
  let rawTxBody: Buffer;
  const bytes = hexToBytes(txHex);
  try {
    const fullTx = RustModule.CML.Transaction.from_cbor_bytes(bytes);
    txBody = fullTx.body();
    witnessSet = fullTx.witness_set();
    auxiliaryData = fullTx.auxiliary_data();
    rawTxBody = Buffer.from(txBody.to_cbor_bytes());
  } catch (originalErr) {
    try {
      // Try parsing as body for backward compatibility
      txBody = RustModule.CML.TransactionBody.from_cbor_bytes(bytes);
      rawTxBody = Buffer.from(txBody.to_cbor_bytes());
    } catch (_e) {
      throw originalErr;
    }
  }
  return { txBody, witnessSet, auxiliaryData, rawTxBody };
}

async function __connectorSignCardanoTx(
  publicDeriver: PublicDeriver<>,
  password: string,
  tx: CardanoTx,
  chainedUtxos: Array<CardanoAddressedUtxo>,
  // eslint-disable-next-line no-shadow
  RustModule: typeof RustModule
): Promise<string> {
  const { txBody, witnessSet, auxiliaryData, rawTxBody } = resolveTxOrTxBody(tx, RustModule);

  const withUtxos = asGetAllUtxos(publicDeriver);
  if (withUtxos == null) {
    throw new Error(`missing utxo functionality`);
  }

  const withHasUtxoChains = asHasUtxoChains(withUtxos);
  if (withHasUtxoChains == null) {
    throw new Error(`missing chains functionality`);
  }

  const totalAdditionalRequiredSignKeys = new Set<string>([
    ...getTxRequiredSigningKeys(txBody),
    ...getScriptRequiredSigningKeys(witnessSet, RustModule),
    ...getCertificatesRequiredSignKeys(txBody),
  ]);

  const additionalSignaturesRequired = totalAdditionalRequiredSignKeys.size > 0;

  const queryAllBaseAddresses = (): Promise<Array<FullAddressPayload>> => {
    if (additionalSignaturesRequired) {
      return getAllAddressesForDisplay({
        publicDeriver,
        type: CoreAddressTypes.CARDANO_BASE,
        ignoreCutoff: true,
      });
    }
    return Promise.resolve([]);
  };

  const queryAllRewardAddresses = (): Promise<Array<FullAddressPayload>> => {
    if (additionalSignaturesRequired) {
      return getAllAddressesForDisplay({
        publicDeriver,
        type: CoreAddressTypes.CARDANO_REWARD,
        ignoreCutoff: true,
      });
    }
    return Promise.resolve([]);
  };

  const [utxos, allBaseAddresses, allRewardAddresses] = await Promise.all([
    withHasUtxoChains.getAllUtxos(),
    queryAllBaseAddresses(),
    queryAllRewardAddresses(),
  ]);

  const requiredTxSignAddresses = new Set<string>();
  const otherRequiredSigners = [];

  if (additionalSignaturesRequired) {
    if (allBaseAddresses.length === 0) {
      throw new Error('Cannot sign transaction script - no base addresses are available in the wallet!');
    }
    const parsedBaseAddr = RustModule.CML.Address.from_raw_bytes(hexToBytes(allBaseAddresses[0].address));
    const parsedNetworkId = parsedBaseAddr.network_id();
    const parsedStakingCred = RustModule.CML.BaseAddress.from_address(parsedBaseAddr)?.stake();
    if (parsedStakingCred == null) {
      throw new Error('Cannot sign transaction script - failed to parse the base address staking cred!');
    }
    for (const signingKeyHash of totalAdditionalRequiredSignKeys) {
      const requiredKeyHash = RustModule.CML.Ed25519KeyHash.from_raw_bytes(hexToBytes(signingKeyHash));
      const requiredPaymentCred = RustModule.CML.Credential.new_pub_key(requiredKeyHash);
      const requiredAddress = RustModule.CML.BaseAddress.new(
        parsedNetworkId,
        requiredPaymentCred,
        parsedStakingCred
      ).to_address();
      requiredTxSignAddresses.add(bytesToHex(requiredAddress.to_address().to_raw_bytes()));
    }
    for (const baseAddress of allBaseAddresses) {
      const { address, addressing } = baseAddress;
      if (requiredTxSignAddresses.delete(address)) {
        otherRequiredSigners.push({ address, addressing });
      }
      if (requiredTxSignAddresses.size === 0) {
        break;
      }
    }
    for (const rewardAddress of allRewardAddresses) {
      const { address, addressing } = rewardAddress;
      if (totalAdditionalRequiredSignKeys.has(address.slice(2))) {
        otherRequiredSigners.push({ address, addressing });
      }
    }
    const [drepKey, addressing] = await getDRepKeyAndAddressing(publicDeriver);
    const drepCred = drepKey.hash().to_hex();
    if (totalAdditionalRequiredSignKeys.has(drepCred)) {
      const address = RustModule.CML.RewardAddress.new(
        0, // strictly speaking should use `ChainNetworkId` but doesn't matter
        RustModule.CML.Credential.new_pub_key(drepKey.hash())
      )
        .to_address()
        .to_hex();
      otherRequiredSigners.push({ address, ...addressing });
    }
  }

  const submittedTxs = (await loadSubmittedTransactions()) || [];
  const adaApi = new AdaApi();
  const addressedUtxos = await adaApi.addressedUtxosWithSubmittedTxs(asAddressedUtxoCardano(utxos), publicDeriver, submittedTxs);

  const utxoIdSet: Set<string> = iterateLenGet(txBody.inputs())
    .join(iterateLenGet(txBody.collateral()))
    .map(input => `${input.transaction_id().to_hex()}${String(input.index())}`)
    .toSet();

  const usedUtxos = [...addressedUtxos, ...chainedUtxos].filter(utxo => utxoIdSet.has(utxo.utxo_id));

  const signedTx = await shelleySignTransactionFromWallet(
    usedUtxos,
    rawTxBody,
    publicDeriver,
    password,
    auxiliaryData, // metadata
    otherRequiredSigners
  );

  return signedTx.witness_set().to_hex();
}

// <TODO:PENDING_REMOVAL> only used for experimental
export async function connectorCreateCardanoTx(
  publicDeriver: PublicDeriver<>,
  password: ?string,
  cardanoTxRequest: CardanoTxRequest,
  foreignUtxoFetcher: ForeignUtxoFetcher,
  protocolParameters: ProtocolParameters
): Promise<string> {
  const withUtxos = asGetAllUtxos(publicDeriver);
  if (withUtxos == null) {
    throw new Error(`missing utxo functionality`);
  }

  const withHasUtxoChains = asHasUtxoChains(withUtxos);
  if (withHasUtxoChains == null) {
    throw new Error(`missing chains functionality`);
  }

  const network = publicDeriver.getParent().getNetworkInfo();
  const fullConfig = getCardanoHaskellBaseConfig(network);
  const absSlotNumber = new BigNumber(TimeUtils.timeToAbsoluteSlot(fullConfig, new Date()));

  const submittedTxs = (await loadSubmittedTransactions()) || [];

  const utxos = asAddressedUtxoCardano(await withUtxos.getAllUtxos());

  const adaApi = new AdaApi();
  const signRequest = await adaApi.createUnsignedTxForConnector(
    {
      publicDeriver,
      absSlotNumber,
      // $FlowFixMe[incompatible-exact]
      cardanoTxRequest,
      submittedTxs,
      utxos,
      protocolParameters,
    },
    foreignUtxoFetcher
  );
  if (password == null) {
    return signRequest.unsignedTx.build_tx().to_hex();
  }
  const signedTx = await shelleySignTransactionFromWallet(
    signRequest.senderUtxos,
    signRequest.unsignedTx,
    publicDeriver,
    password,
    signRequest.metadata
  );
  return signedTx.to_hex();
}

export async function connectorSendTxCardano(
  wallet: IPublicDeriver</* ConceptualWallet */>,
  signedTxHex: string,
  localStorage: LocalStorageApi
): Promise<void> {
  await sendTx({
    body: {
      network: wallet.getParent().getNetworkInfo(),
      id: transactionHexToHash(signedTxHex),
      encodedTx: hexToBytes(signedTxHex),
    },
    lastLaunchVersion: (await localStorage.getLastLaunchVersion()) ?? '',
    currentLocale: (await localStorage.getUserLocale()) ?? '',
    errorHandler: error => {
      const code = error.response?.status === 400 ? TxSendErrorCodes.REFUSED : TxSendErrorCodes.FAILURE;
      const info = error.response?.data ?? `Failed to submit transaction: ${String(error)}`;
      throw new ConnectorError({ code, info });
    },
  });
}

export async function connectorRecordSubmittedCardanoTransaction(
  publicDeriver: PublicDeriver<>,
  sourceTxHex: string,
  addressedUtxos?: ?Array<CardanoAddressedUtxo>
) {
  const withUtxos = asGetAllUtxos(publicDeriver);
  if (!withUtxos) {
    throw new Error('expect to be able to get all UTXOs');
  }
  const allAddresses = new Set(
    (await withUtxos.getAllUtxoAddresses()).flatMap(utxoAddr => utxoAddr.addrs.map(addr => addr.Hash))
  );

  let utxos;
  if (addressedUtxos) {
    utxos = addressedUtxos;
  } else {
    utxos = asAddressedUtxoCardano(await withUtxos.getAllUtxos());
  }
  const submittedTxs = (await loadSubmittedTransactions()) || [];
  const adaApi = new AdaApi();
  utxos = await adaApi.addressedUtxosWithSubmittedTxs(utxos, publicDeriver, submittedTxs);

  const txId = transactionHexToHash(sourceTxHex);
  const txData = RustModule.WasmScope(Module => {
    const cml = Module.CML;
    const tx = cml.Transaction.from_cbor_hex(sourceTxHex);
    const body = tx.body();
    return {
      fee: body.fee().toString(),
      ttl: String(body.ttl()),
      inputs: iterateLenGet(body.inputs()).map(input => ({
        txHash: input.transaction_id().to_hex(),
        index: Number(input.index()),
      })).toArray(),
      outputs: iterateLenGet(body.outputs()).map(output => ({
        address: output.address().to_hex(),
        amount: output.amount().coin().toString(),
        assets: parseTokenList(output.amount().multi_asset()),
      })).toArray(),
      withdrawals: iterateLenGetMap(body.withdrawals())
        .nonNullValue()
        .map(([key, amount]) => ({ address: key.to_address().to_hex(), amount: amount.toString() }))
        .toArray(),
      isDrepDelegation: iterateLenGet(body.certs()).some(cert => isCertificateKindDrepDelegation(cert.kind())),
      metadata: tx.auxiliary_data()?.to_cbor_hex(),
    };
  });
  const defaultToken = publicDeriver.getParent().defaultToken;
  const defaults = {
    defaultNetworkId: defaultToken.NetworkId,
    defaultIdentifier: defaultToken.Identifier,
  };

  const amount = new MultiToken([], defaults);
  const addresses = { from: [], to: [] };
  let isIntraWallet = true;
  const mt = new MultiToken([], defaults);
  const fee = mt.add(mt.createDefaultEntry(new BigNumber(txData.fee)));

  const usedUtxos = [];
  for (const { txHash, index } of txData.inputs) {
    const utxo = utxos.find(u => u.tx_hash === txHash && u.tx_index === index);

    if (!utxo) {
      throw new Error('missing UTXO');
    }
    usedUtxos.push({ txHash, index });

    const value = new MultiToken([], defaults);

    value.add({
      amount: new BigNumber(utxo.amount),
      identifier: defaultToken.Identifier,
      networkId: defaultToken.NetworkId,
    });
    for (const asset of utxo.assets) {
      value.add({
        amount: new BigNumber(asset.amount),
        identifier: asset.assetId,
        networkId: defaultToken.NetworkId,
      });
    }
    addresses.from.push({
      address: utxo.receiver,
      value,
    });
    if (allAddresses.has(utxo.receiver)) {
      amount.joinSubtractMutable(value);
    }
  }
  for (const output of txData.outputs) {
    const value = new MultiToken([], defaults);
    value.add({ amount: new BigNumber(output.amount), identifier: defaultToken.Identifier, networkId: defaultToken.NetworkId });
    for (const asset of output.assets) {
      value.add({ amount: new BigNumber(asset.amount), identifier: asset.assetId, networkId: defaultToken.NetworkId });
    }
    const address = output.address;
    addresses.to.push({
      address,
      value,
      isForeign: false,
    });
    if (allAddresses.has(address)) {
      amount.joinAddMutable(value);
    } else {
      isIntraWallet = false;
    }
  }

  const withdrawalsData = txData.withdrawals.map(withdrawal => ({
      address: withdrawal.address,
      value: new MultiToken(
        [
          {
            amount: new BigNumber(withdrawal.amount),
            identifier: defaultToken.Identifier,
            networkId: defaultToken.NetworkId,
          },
        ],
        defaults
      ),
    }));

  const submittedTx: CardanoShelleyTransactionCtorData = {
    txid: txId,
    type: isIntraWallet ? 'self' : 'expend',
    amount,
    fee,
    date: new Date(),
    addresses,
    state: TxStatusCodes.SUBMITTED,
    errorMsg: null,
    block: null,
    certificates: [],
    ttl: new BigNumber(txData.ttl),
    metadata: txData.metadata,
    withdrawals: withdrawalsData,
    isValid: true,
  };

  submittedTxs.push({
    publicDeriverId: publicDeriver.publicDeriverId,
    transaction: submittedTx,
    networkId: publicDeriver.getParent().getNetworkInfo().NetworkId,
    usedUtxos,
    isDrepDelegation: txData.isDrepDelegation,
  });
  await persistSubmittedTransactions(submittedTxs);
}

export function getTokenMetadataFromIds(
  tokenIds: Array<string>,
  publicDeriver: PublicDeriver<>
): Promise<$ReadOnlyArray<$ReadOnly<TokenRow>>> {
  const networkId = publicDeriver.getParent().getNetworkInfo().NetworkId;
  const db = publicDeriver.getDb();
  return raii(db, getAllSchemaTables(db, GetToken), async dbTx => {
    return (await GetToken.fromIdentifier(db, dbTx, tokenIds)).filter(row => row.NetworkId === networkId);
  });
}

export async function transformCardanoUtxos(utxos: Array<RemoteUnspentOutput>, isCBOR: boolean): any {
  const cardanoUtxos: $ReadOnlyArray<$ReadOnly<RemoteUnspentOutput>> = utxos;
  await RustModule.load();
  return RustModule.WasmScope(Module => {
    const cml = Module.CML;
    if (isCBOR) {
      return cardanoUtxos.map(u => {
        // eslint-disable-next-line no-undef
        const input = cml.TransactionInput.new(cml.TransactionHash.from_hex(u.tx_hash), BigInt(u.tx_index));
        const output = cml.TransactionOutput.new(cml.Address.from_hex(u.receiver), cardanoValueFromRemoteFormat(u));
        return cml.TransactionUnspentOutput.new(input, output).to_cbor_hex();
      });
    }
    return cardanoUtxos.map(u => ({
      ...u,
      receiver: cml.Address.from_hex(u.receiver).to_bech32(),
    }));
  });
}
