// @flow

import BigNumber from 'bignumber.js';
import type {
  AccountStateFunc,
  AccountStateRequest,
  AccountStateResponse,
  AddressUtxoFunc,
  AddressUtxoRequest,
  AddressUtxoResponse,
  BestBlockFunc,
  BestBlockRequest,
  BestBlockResponse,
  FilterFunc,
  FilterUsedRequest,
  FilterUsedResponse,
  GetRecentTransactionHashesFunc,
  GetRecentTransactionHashesRequest,
  GetRecentTransactionHashesResponse,
  GetTransactionsByHashesFunc,
  GetTransactionsByHashesRequest,
  GetTransactionsByHashesResponse,
  HistoryFunc,
  HistoryRequest,
  HistoryResponse,
  MultiAssetMintMetadataFunc,
  MultiAssetSupplyFunc,
  PoolInfoFunc,
  PoolInfoRequest,
  PoolInfoResponse,
  RemoteTransaction,
  RemoteTransactionInput,
  RemoteUnspentOutput,
  RewardHistoryFunc,
  SignedRequestInternal,
  TokenInfoFunc,
} from './types';
import { ShelleyCertificateTypes } from './types';
import { RollbackApiError } from '../../../common/errors';
import { addressToKind, toEnterprise, toHexOrBase58 } from '../storage/bridge/utils';
import type { CoreAddressT } from '../storage/database/primitives/enums';
import { CoreAddressTypes } from '../storage/database/primitives/enums';
import { mnemonicToEntropy } from 'bip39';
import { WalletTypePurpose } from '../../../../config/numbersConfig';
import type { NetworkRow } from '../storage/database/primitives/tables';

import { RustModule } from '../cardanoCrypto/rustLoader';

import { generateLedgerWalletRootKey } from '../cardanoCrypto/cryptoWallet';
import { getCardanoHaskellBaseConfig, networks } from '../storage/database/prepackaged/networks';
import { bech32 } from 'bech32';
import { Bech32Prefix } from '../../../../config/stringConfig';
import { parseTokenList } from '../../transactions/utils';
import type {
  TipStatusReference,
  Utxo,
  UtxoApiContract,
  UtxoApiResponse,
  UtxoAtPointRequest,
  UtxoDiff,
  UtxoDiffItem,
  UtxoDiffSincePointRequest,
} from './utxoTypes';
import { UtxoApiResult } from './utxoTypes';
import { bytesToHex, forceNonNull, hexToBytes, last } from '../../../../coreUtils';

function byronAddressToHex(byronAddrOrHex: string): string {
  return RustModule.WasmScope(Module => {
    const address = Module.CML.ByronAddress.is_valid(byronAddrOrHex)
      ? Module.CML.ByronAddress.from_base58(byronAddrOrHex).to_address()
      : Module.CML.Address.from_hex(byronAddrOrHex);
    return address.to_hex();
  });
}

/** convert bech32 address to bytes */
function fixAddresses(address: string, network: $ReadOnly<NetworkRow>): string {
  try {
    const bech32Info = bech32.decode(address, 1000);
    if (bech32Info.prefix === Bech32Prefix.PAYMENT_KEY_HASH) {
      const config = getCardanoHaskellBaseConfig(network).reduce((acc, next) => Object.assign(acc, next), {});
      return RustModule.WasmScope(Module => {
        const cml = Module.CML;
        const enterpriseAddr = cml.EnterpriseAddress.new(
          Number.parseInt(config.ChainNetworkId, 10),
          cml.Credential.new_pub_key(cml.Ed25519KeyHash.from_bech32(address))
        );
        return enterpriseAddr.to_address().to_hex();
      });
    }
    return bytesToHex(bech32.fromWords(bech32Info.words));
  } catch (_e) {
    return address;
  }
}
export function genCheckAddressesInUse(blockchain: Array<RemoteTransaction>, network: $ReadOnly<NetworkRow>): FilterFunc {
  return async (body: FilterUsedRequest): Promise<FilterUsedResponse> => {
    const mapToOriginal = {};
    const addresses = body.addresses.map(addr => {
      const fixed = fixAddresses(addr, network);
      mapToOriginal[fixed] = addr;
      return fixed;
    });
    const addressSet = new Set(addresses);
    const usedSet = new Set();

    for (const tx of blockchain) {
      if (tx.tx_state !== 'Successful') {
        continue;
      }
      const oursInTx = ourAddressesInTx(tx, addressSet);
      for (const found of oursInTx) {
        let origAddr;
        if (addressSet.has(found)) {
          origAddr = mapToOriginal[found];
        } else {
          const enterpriseWasm = toEnterprise(found);
          if (enterpriseWasm != null) {
            const enterprise = enterpriseWasm;
            if (addressSet.has(enterprise)) {
              origAddr = mapToOriginal[enterprise];
            }
          }
        }
        if (!origAddr) {
          throw new Error('unexpected: missing address in addressSet');
        }
        usedSet.add(origAddr);
      }
    }

    return Array.from(usedSet);
  };
}

function isOurAddress(address: string, ownAddresses: Set<string>): boolean {
  if (ownAddresses.has(address)) {
    return true;
  }
  const enterpriseWasm = toEnterprise(address);
  if (enterpriseWasm != null) {
    const enterprise = enterpriseWasm;
    if (ownAddresses.has(enterprise)) {
      return true;
    }
  }
  return false;
}

function ourAddressesInTx(tx: RemoteTransaction, ownAddresses: Set<string>): Set<string> {
  const addresses = [...tx.inputs.map(input => input.address), ...tx.outputs.map(output => output.address)];
  if (tx.type === 'shelley') {
    addresses.push(...tx.withdrawals.map(withdrawal => withdrawal.address));
  }
  const addressesUsed = new Set();
  for (const addr of addresses) {
    if (isOurAddress(addr, ownAddresses)) {
      addressesUsed.add(addr);
    }
  }
  return addressesUsed;
}

function filterForOwn(
  txs: Array<RemoteTransaction>,
  ownAddresses: Set<string>,
  _network: $ReadOnly<NetworkRow>
): Array<RemoteTransaction> {
  const ownTxs = [];
  for (const tx of txs) {
    const oursInTx = ourAddressesInTx(tx, ownAddresses);
    if (oursInTx.size > 0) {
      ownTxs.push(tx);
    }
  }
  return ownTxs;
}

export function genGetTransactionsHistoryForAddresses(
  blockchain: Array<RemoteTransaction>,
  network: $ReadOnly<NetworkRow>
): HistoryFunc {
  return async (body: HistoryRequest): Promise<HistoryResponse> => {
    const addresses = body.addresses.map(addr => fixAddresses(addr, network));
    const untilBlockIndex = blockchain.map(tx => tx.block_hash).lastIndexOf(body.untilBlock);
    if (untilBlockIndex === -1) {
      throw new RollbackApiError();
    }
    const subChain = blockchain.slice(0, untilBlockIndex + 1);
    // need to add back all pending/failed txs
    for (let i = untilBlockIndex + 1; i < blockchain.length; i++) {
      if (blockchain[i].block_hash == null) {
        subChain.push(blockchain[i]);
      }
    }
    const ownAddresses = new Set(addresses);
    if (body.after == null) {
      const filtered = filterForOwn(subChain, ownAddresses, network);
      return filtered;
    }
    const after = body.after;

    let cutoffTx = undefined;
    for (let i = 0; i < subChain.length; i++) {
      if (subChain[i].hash === after.tx && subChain[i].block_hash === after.block) {
        cutoffTx = subChain[i];
        break;
      }
    }
    if (cutoffTx == null) {
      throw new RollbackApiError();
    }
    if (cutoffTx.height == null || cutoffTx.tx_ordinal == null) {
      throw new Error(`${nameof(genGetTransactionsHistoryForAddresses)} cutoffTx not in block - should never happen`);
    }
    const cutoffBlockNum = cutoffTx.height;
    const cutoffOrdinal = cutoffTx.tx_ordinal;

    const txsToInclude: Array<RemoteTransaction> = [];
    for (const tx of subChain) {
      if (tx === cutoffTx) continue;
      if (tx.height == null || tx.tx_ordinal == null) {
        txsToInclude.push(tx);
        continue;
      } else {
        const blockNum = tx.height;
        const ordinal = tx.tx_ordinal;
        if (blockNum > cutoffBlockNum) {
          txsToInclude.push(tx);
        } else if (blockNum === cutoffBlockNum) {
          if (ordinal > cutoffOrdinal) {
            txsToInclude.push(tx);
          }
        }
      }
    }
    const filtered = filterForOwn(txsToInclude, ownAddresses, network);
    return filtered;
  };
}

export function genGetBestBlock(blockchain: Array<RemoteTransaction>): BestBlockFunc {
  return async (_body: BestBlockRequest): Promise<BestBlockResponse> => {
    let bestInNetwork: void | BestBlockResponse = undefined;
    for (let i = blockchain.length - 1; i >= 0; i--) {
      const block = blockchain[i];
      if (block.height != null && block.epoch != null && block.slot != null && block.block_hash != null) {
        bestInNetwork = {
          epoch: block.epoch,
          slot: block.slot,
          hash: block.block_hash,
          height: block.height,
        };
        break;
      }
    }
    if (bestInNetwork == null) {
      return {
        height: 0,
        epoch: null,
        slot: null,
        hash: null,
      };
    }
    return bestInNetwork;
  };
}

export function genUtxoForAddresses(
  getHistory: HistoryFunc,
  getBestBlock: BestBlockFunc,
  network: $ReadOnly<NetworkRow>
): AddressUtxoFunc {
  return async (body: AddressUtxoRequest): Promise<AddressUtxoResponse> => {
    const addresses = body.addresses.map(addr => fixAddresses(addr, network));
    const bestBlock = await getBestBlock({
      network,
    });
    if (bestBlock.hash == null) {
      return [];
    }
    const until = bestBlock.hash;
    const history = await getHistory({
      network,
      addresses,
      untilBlock: until,
    });
    const inBlockHistory = history.filter(tx => tx.block_hash != null);
    const ourAddressSet = new Set(addresses);

    const utxoMap = new Map<string, RemoteUnspentOutput>();
    for (const tx of inBlockHistory) {
      for (let j = 0; j < tx.outputs.length; j++) {
        const address = tx.outputs[j].address;
        if (isOurAddress(address, ourAddressSet)) {
          const kind = addressToKind(address, 'bytes', networks.CardanoMainnet);
          if (kind === CoreAddressTypes.CARDANO_REWARD) {
            throw new Error(`${nameof(genUtxoForAddresses)} non-utxo address in utxo endpoint`);
          }
          const key = JSON.stringify({
            id: tx.hash,
            index: j,
          });
          utxoMap.set(key, {
            utxo_id: tx.hash + j,
            tx_hash: tx.hash,
            tx_index: j,
            receiver: tx.outputs[j].address,
            amount: tx.outputs[j].amount.toString(),
            assets: tx.outputs[j].assets,
          });
        }
      }
    }
    for (const tx of inBlockHistory) {
      for (let j = 0; j < tx.inputs.length; j++) {
        const input = tx.inputs[j];
        const key = JSON.stringify({
          id: input.txHash,
          index: input.index,
        });
        utxoMap.delete(key);
      }
    }
    const result = Array.from(utxoMap.values());
    return result;
  };
}

export function getSingleAddressString(mnemonic: string, path: Array<number>, isLedger: boolean = false): string {
  const ledgerRootBytes = isLedger ? generateLedgerWalletRootKey(mnemonic).to_raw_bytes() : null;
  const baseConfig = getCardanoHaskellBaseConfig(networks.CardanoMainnet).reduce((acc, next) => Object.assign(acc, next), {});
  return RustModule.WasmScope(Module => {
    const cml = Module.CML;
    const rootKey =
      ledgerRootBytes == null
        ? cml.Bip32PrivateKey.from_bip39_entropy(hexToBytes(mnemonicToEntropy(mnemonic)), new Uint8Array())
        : cml.Bip32PrivateKey.from_raw_bytes(ledgerRootBytes);
    const derivedKey = derivePath(rootKey, path);
    if (path[0] === WalletTypePurpose.BIP44) {
      return cml.AddressContent.icarus_from_key(
        derivedKey.to_public(),
        cml.ProtocolMagic.new(Number.parseInt(baseConfig.ByronNetworkId, 10))
      )
        .to_address()
        .to_base58();
    }
    if (path[0] === WalletTypePurpose.CIP1852) {
      return cml.EnterpriseAddress.new(
        Number.parseInt(baseConfig.ChainNetworkId, 10),
        cml.Credential.new_pub_key(derivedKey.to_public().to_raw_key().hash())
      )
        .to_address()
        .to_hex();
    }
    throw new Error('Unexpected purpose');
  });
}

export function getMangledAddressString(
  mnemonic: string,
  path: Array<number>,
  stakingKey: Buffer,
  isLedger: boolean = false
): string {
  const ledgerRootBytes = isLedger ? generateLedgerWalletRootKey(mnemonic).to_raw_bytes() : null;
  const baseConfig = getCardanoHaskellBaseConfig(networks.CardanoMainnet).reduce((acc, next) => Object.assign(acc, next), {});
  return RustModule.WasmScope(Module => {
    const cml = Module.CML;
    const rootKey =
      ledgerRootBytes == null
        ? cml.Bip32PrivateKey.from_bip39_entropy(hexToBytes(mnemonicToEntropy(mnemonic)), new Uint8Array())
        : cml.Bip32PrivateKey.from_raw_bytes(ledgerRootBytes);
    const derivedKey = derivePath(rootKey, path);
    if (path[0] !== WalletTypePurpose.CIP1852) throw new Error('Unexpected purpose');
    return cml.BaseAddress.new(
      Number.parseInt(baseConfig.ChainNetworkId, 10),
      cml.Credential.new_pub_key(derivedKey.to_public().to_raw_key().hash()),
      cml.Credential.new_pub_key(cml.Ed25519KeyHash.from_bytes(new Uint8Array(stakingKey)))
    )
      .to_address()
      .to_hex();
  });
}

export function getAddressForType(mnemonic: string, path: Array<number>, type: CoreAddressT): string {
  const baseConfig = getCardanoHaskellBaseConfig(networks.CardanoMainnet).reduce((acc, next) => Object.assign(acc, next), {});
  return RustModule.WasmScope(Module => {
    const cml = Module.CML;
    const rootKey = cml.Bip32PrivateKey.from_bip39_entropy(hexToBytes(mnemonicToEntropy(mnemonic)), new Uint8Array());
    const derivedKey = derivePath(rootKey, path);
    switch (type) {
      case CoreAddressTypes.CARDANO_BASE: {
        const newPath = [...path];
        // -1 because newPath here starts at PURPOSE and not at ROOT
        const chainLevel = 4 - 1;
        const addressLevel = 5 - 1;
        newPath[chainLevel] = 2;
        newPath[addressLevel] = 0;
        const stakingKey = derivePath(rootKey, newPath);
        const addr = cml.BaseAddress.new(
          Number.parseInt(baseConfig.ChainNetworkId, 10),
          cml.Credential.new_pub_key(derivedKey.to_public().to_raw_key().hash()),
          cml.Credential.new_pub_key(stakingKey.to_public().to_raw_key().hash())
        );
        return addr.to_address().to_hex();
      }
      case CoreAddressTypes.CARDANO_PTR: {
        throw new Error(`${nameof(getAddressForType)} Not implemented`);
      }
      case CoreAddressTypes.CARDANO_ENTERPRISE: {
        const addr = cml.EnterpriseAddress.new(
          Number.parseInt(baseConfig.ChainNetworkId, 10),
          cml.Credential.new_pub_key(derivedKey.to_public().to_raw_key().hash())
        );
        return addr.to_address().to_hex();
      }
      case CoreAddressTypes.CARDANO_REWARD: {
        const addr = cml.RewardAddress.new(
          Number.parseInt(baseConfig.ChainNetworkId, 10),
          cml.Credential.new_pub_key(derivedKey.to_public().to_raw_key().hash())
        );
        return addr.to_address().to_hex();
      }
      default:
        throw new Error(`${nameof(getAddressForType)} unknown type ` + type);
    }
  });
}

function derivePath(startKey: any, path: Array<number>): any {
  let currKey = startKey;
  for (let i = 0; i < path.length; i++) {
    currKey = currKey.derive(path[i]);
  }
  return currKey;
}

function getByronInputs(blockchain: Array<RemoteTransaction>, inputs: Array<TxoPointerType>): Array<RemoteTransactionInput> {
  const result: Array<RemoteTransactionInput> = [];
  for (const input of inputs) {
    const pointedTx = blockchain.find(tx => tx.hash === input.id);
    if (pointedTx == null) {
      throw new Error(`${nameof(getByronInputs)} no tx found ${input.id}`);
    }
    const pointedOutput = pointedTx.outputs[input.index];
    const addressKind = addressToKind(pointedOutput.address, 'bytes', networks.CardanoMainnet);
    if (
      addressKind === CoreAddressTypes.CARDANO_LEGACY ||
      addressKind === CoreAddressTypes.CARDANO_BASE ||
      addressKind === CoreAddressTypes.CARDANO_ENTERPRISE ||
      addressKind === CoreAddressTypes.CARDANO_PTR
    ) {
      result.push({
        address: pointedOutput.address,
        amount: pointedOutput.amount,
        id: input.id + input.index,
        index: input.index,
        txHash: input.id,
        assets: pointedOutput.assets,
      });
    } else {
      throw new Error(`${nameof(getByronInputs)} unexpected type ${addressKind}`);
    }
  }
  return result;
}

export function toRemoteByronTx(blockchain: Array<RemoteTransaction>, request: SignedRequestInternal): RemoteTransaction {
  const tx = Array.isArray(request.signedTx) ? forceNonNull(last(request.signedTx)) : request.signedTx;
  const txBytes = Buffer.from(tx, 'base64');
  const { hash, outputs, inputs } = RustModule.WasmScope(Module => {
    const cml = Module.CML;
    const signedTx = cml.Transaction.from_cbor_bytes(txBytes);
    const body = signedTx.body();
    const parsedOutputs = [];
    const outputList = body.outputs();
    for (let i = 0; i < outputList.len(); i++) {
      const output = outputList.get(i);
      if (!output) throw new Error('Missing Byron transaction output');
      parsedOutputs.push({
        address: toHexOrBase58(output.address().to_hex()),
        amount: output.amount().coin().toString(),
        assets: parseTokenList(output.amount().multi_asset()),
      });
    }
    const parsedInputs = [];
    const inputList = body.inputs();
    for (let i = 0; i < inputList.len(); i++) {
      const input = inputList.get(i);
      if (!input) throw new Error('Missing Byron transaction input');
      parsedInputs.push({ id: input.transaction_id().to_hex(), index: Number(input.index()) });
    }
    return { hash: cml.hash_transaction(body).to_hex(), outputs: parsedOutputs, inputs: parsedInputs };
  });

  const base = {
    hash,
    last_update: new Date().toString(),
    tx_state: 'Pending',
    inputs: getByronInputs(blockchain, inputs),
    outputs,
  };

  return {
    ...base,
    height: null,
    block_hash: null,
    tx_ordinal: null,
    time: null,
    epoch: null,
    slot: null,
  };
}

export function genGetAccountState(blockchain: Array<RemoteTransaction>, getRewardHistory: RewardHistoryFunc): AccountStateFunc {
  return async (body: AccountStateRequest): Promise<AccountStateResponse> => {
    const rewardHistory = await getRewardHistory(body);

    // 1) calculate the reward for each address
    const resultMap = new Map<
      string,
      {|
        rewards: BigNumber,
        withdrawals: BigNumber,
      |},
    >();
    for (const key of Object.keys(rewardHistory)) {
      for (const reward of rewardHistory[key] ?? []) {
        const currVal = resultMap.get(key) ?? {
          rewards: new BigNumber(0),
          withdrawals: new BigNumber(0),
        };

        currVal.rewards = currVal.rewards.plus(reward.reward);
      }
    }

    const addressSet = new Set(body.addresses);
    // 2) calculate the withdrawal for each address
    const delegations = {};
    for (const tx of blockchain) {
      if (tx.type !== 'shelley') continue;
      for (const withdrawal of tx.withdrawals) {
        if (addressSet.has(withdrawal.address)) {
          const currVal = resultMap.get(withdrawal.address) ?? {
            rewards: new BigNumber(0),
            withdrawals: new BigNumber(0),
          };

          currVal.withdrawals = currVal.withdrawals.plus(withdrawal.amount);
        }
      }
      for (const cert of tx.certificates) {
        if (cert.kind === ShelleyCertificateTypes.StakeDelegation) {
          delegations[cert.rewardAddress] = cert.poolKeyHash;
        }
      }
    }

    // 3) gather up the result

    const result: AccountStateResponse = {};
    for (const address of body.addresses) {
      const stateForAddr = resultMap.get(address) ?? {
        rewards: new BigNumber(0),
        withdrawals: new BigNumber(0),
      };
      result[address] = {
        poolOperator: null, // TODO
        remainingAmount: stateForAddr.rewards.minus(stateForAddr.withdrawals).toString(),
        rewards: stateForAddr.rewards.toString(),
        withdrawals: stateForAddr.withdrawals.toString(),
        delegation: delegations[address] ?? null,
        stakeRegistered: true,
      };
    }
    return result;
  };
}

export function genGetPoolInfo(): PoolInfoFunc {
  return async (body: PoolInfoRequest): Promise<PoolInfoResponse> => {
    // TODO: scan the chain properly for this information
    const mockPoolId = 'df1750df9b2df285fcfb50f4740657a18ee3af42727d410c37b86207';
    const result: PoolInfoResponse = {};
    for (const poolId of body.poolIds) {
      if (poolId === mockPoolId) {
        result[mockPoolId] = {
          info: {
            name: 'Yoroi',
            description: 'Yoroi is a light wallet for Cardano. It’s simple, fast and secure.',
            ticker: 'YOROI',
            homepage: 'https://yoroi-wallet.com/',
          },
          history: [],
        };
      }
    }
    return result;
  };
}

export function genGetTokenInfo(): TokenInfoFunc {
  return async _ => ({});
}

export function genGetMultiAssetMetadata(): MultiAssetMintMetadataFunc {
  return async _ => ({});
}

export function genGetMultiAssetSupply(): MultiAssetSupplyFunc {
  return async _ => ({});
}

export class MockUtxoApi implements UtxoApiContract {
  blockchain: Array<RemoteTransaction>;
  safeConfirmations: number;

  constructor(blockchain: Array<RemoteTransaction>, safeConfirmations: number) {
    this.blockchain = blockchain;
    this.safeConfirmations = safeConfirmations;
  }

  _getLastSafeBlockTxIndex(): number {
    let lastHeight = null;
    let i;
    for (i = this.blockchain.length - 1; i >= 0; i--) {
      if (this.blockchain[i].tx_state === 'Successful') {
        lastHeight = this.blockchain[i].height;
        break;
      }
    }
    if (lastHeight == null) {
      throw new Error('no successful tx');
    }
    for (; i >= 0; i--) {
      const currentHeight = this.blockchain[i].height;
      if (currentHeight != null && lastHeight - currentHeight >= this.safeConfirmations) {
        break;
      }
    }
    if (i === -1) {
      throw new Error('not enough blocks for a safe block');
    } else {
      return i;
    }
  }

  async getBestBlock(): Promise<string> {
    for (let i = this.blockchain.length - 1; i >= 0; i--) {
      if (this.blockchain[i].tx_state === 'Successful') {
        const hash = this.blockchain[i].block_hash;
        if (!hash) {
          throw new Error('expect hash');
        }
        return hash;
      }
    }
    throw new Error('no successful tx');
  }

  async getSafeBlock(): Promise<string> {
    const hash = this.blockchain[this._getLastSafeBlockTxIndex()].block_hash;
    if (!hash) {
      throw new Error('expect hash');
    }
    return hash;
  }

  async getTipStatusWithReference(bestBlocks: string[]): Promise<UtxoApiResponse<TipStatusReference>> {
    const blocks = bestBlocks
      .map(hash => {
        const index = this.blockchain.findIndex(tx => tx.block_hash === hash);
        if (index === -1) {
          return { index, height: null, hash };
        }
        const height = this.blockchain[index].height;
        return { index, height, hash };
      })
      .filter(b => b.index !== -1)
      .sort((b1, b2) => b1.index - b2.index);
    if (blocks.length === 0) {
      return {
        result: UtxoApiResult.SAFEBLOCK_ROLLBACK,
      };
    }

    return {
      result: UtxoApiResult.SUCCESS,
      value: {
        reference: {
          lastFoundBestBlock: blocks[blocks.length - 1].hash,
          lastFoundSafeBlock: blocks[0].hash,
        },
      },
    };
  }

  async getUtxoAtPoint(req: UtxoAtPointRequest): Promise<UtxoApiResponse<Utxo[]>> {
    const { addresses, referenceBlockHash } = req;
    const hexAddresses = addresses.map(a => {
      const hex = fixAddresses(a, networks.CardanoMainnet);
      if (hex.match(/^([a-f0-9][a-f0-9])+$/)) {
        return hex;
      }
      return byronAddressToHex(a);
    });

    let lastTxIndex;
    for (lastTxIndex = this.blockchain.length - 1; lastTxIndex >= 0; lastTxIndex--) {
      const hash = this.blockchain[lastTxIndex].block_hash;
      if (hash === referenceBlockHash) {
        break;
      }
    }
    if (lastTxIndex === -1) {
      throw new Error('block not found');
    }
    let utxos = [];
    for (let i = 0; i <= lastTxIndex; i++) {
      const tx = this.blockchain[i];
      if (tx.tx_state !== 'Successful') {
        continue;
      }
      // remove spent
      utxos = utxos.filter(utxo => !tx.inputs.some(input => input.txHash === utxo.txHash && input.index === utxo.txIndex));
      // add new
      for (let outputIndex = 0; outputIndex < tx.outputs.length; outputIndex++) {
        const output = tx.outputs[outputIndex];
        if (
          !(hexAddresses.includes(byronAddressToHex(output.address)) || hexAddresses.includes(toEnterprise(output.address) ?? ''))
        ) {
          continue;
        }

        const { height } = tx;
        if (height == null) {
          throw new Error('expect height');
        }
        utxos.push({
          utxoId: `${tx.hash}${outputIndex}`,
          txHash: tx.hash,
          txIndex: outputIndex,
          receiver: output.address,
          amount: new BigNumber(output.amount),
          assets: output.assets.map(asset => ({
            assetId: asset.assetId,
            policyId: asset.policyId,
            name: asset.name,
            amount: asset.amount,
          })),
          blockNum: height,
        });
      }
    }
    return {
      result: UtxoApiResult.SUCCESS,
      value: utxos,
    };
  }

  async getUtxoDiffSincePoint(req: UtxoDiffSincePointRequest): Promise<UtxoApiResponse<UtxoDiff>> {
    const { addresses, untilBlockHash, afterBestBlocks } = req;

    const hexAddresses = addresses.map(a => {
      const hex = fixAddresses(a, networks.CardanoMainnet);
      if (hex.match(/^([a-f0-9][a-f0-9])+$/)) {
        return hex;
      }
      return byronAddressToHex(a);
    });

    let seenUntilBlock = false;
    const utxoDiffItems = [];
    let lastFoundBestBlock = null;
    let lastFoundSafeBlock = null;
    for (let i = this.blockchain.length - 1; i >= 0; i--) {
      const tx = this.blockchain[i];
      if (tx.tx_state !== 'Successful') {
        continue;
      }

      if (tx.block_hash === untilBlockHash) {
        seenUntilBlock = true;
      }

      const txInAfterBestblocks = afterBestBlocks.includes(tx.block_hash);
      if (txInAfterBestblocks && lastFoundBestBlock == null) {
        lastFoundBestBlock = tx.block_hash;
      }
      if (txInAfterBestblocks && lastFoundSafeBlock == null && i <= this._getLastSafeBlockTxIndex()) {
        lastFoundSafeBlock = tx.block_hash;
      }

      if (seenUntilBlock) {
        if (txInAfterBestblocks) {
          break;
        }

        tx.outputs.forEach((output, outputIndex) => {
          if (
            !(
              hexAddresses.includes(byronAddressToHex(output.address)) ||
              hexAddresses.includes(toEnterprise(output.address) ?? '')
            )
          ) {
            return;
          }
          const utxoId = `${tx.hash}${outputIndex}`;
          utxoDiffItems.push({
            type: 'output',
            id: utxoId,
            amount: new BigNumber(output.amount),
            utxo: {
              utxoId,
              txHash: tx.hash,
              txIndex: outputIndex,
              receiver: output.address,
              amount: new BigNumber(output.amount),
              assets: output.assets.map(asset => ({
                assetId: asset.assetId,
                policyId: asset.policyId,
                name: asset.name,
                amount: asset.amount,
              })),
              blockNum: tx.height,
            },
          });
        });
        tx.inputs
          .filter(
            input =>
              hexAddresses.includes(byronAddressToHex(input.address)) || hexAddresses.includes(toEnterprise(input.address) ?? '')
          )
          .forEach(input => {
            utxoDiffItems.push(
              ({
                type: 'input',
                id: input.id,
                amount: new BigNumber(input.amount),
              }: UtxoDiffItem)
            );
          });
      }
    }
    if (!seenUntilBlock || lastFoundBestBlock == null) {
      return {
        result: UtxoApiResult.BESTBLOCK_ROLLBACK,
      };
    }
    return {
      result: UtxoApiResult.SUCCESS,
      value: {
        diffItems: utxoDiffItems,
        reference: {
          lastFoundBestBlock,
          ...(lastFoundSafeBlock == null ? {} : { lastFoundSafeBlock }),
        },
      },
    };
  }
}

export function genGetTransactionsByHashes(transactions: Array<RemoteTransaction>): GetTransactionsByHashesFunc {
  return async (body: GetTransactionsByHashesRequest): Promise<GetTransactionsByHashesResponse> => {
    const txByHash = {};
    for (const tx of transactions) {
      txByHash[tx.hash] = tx;
    }
    return body.txHashes.map(hash => txByHash[hash]);
  };
}

export function genGetRecentTransactionHashes(transactions: Array<RemoteTransaction>): GetRecentTransactionHashesFunc {
  return async (body: GetRecentTransactionHashesRequest): Promise<GetRecentTransactionHashesResponse> => {
    const fixedAddresses = body.addresses.map(a => {
      return fixAddresses(a, networks.CardanoMainnet);
    });

    // ignore the "before" parameter because in tests we don't expect pagination
    const ownAddresses = new Set(fixedAddresses);
    const result = {};
    for (const tx of transactions) {
      for (const addr of ourAddressesInTx(tx, ownAddresses)) {
        if (!result[addr]) {
          result[addr] = [];
        }
        // note strictly we should return the mapping from input addresses to tx
        // (`addr` !== input address), but the client only cares about the tx data
        result[addr].push({
          txHash: tx.hash,
          blockHash: tx.block_hash,
          txBlockIndex: tx.tx_ordinal,
          epoch: tx.epoch,
          slot: tx.slot,
        });
      }
    }
    return result;
  };
}
