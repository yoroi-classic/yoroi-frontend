// @flow

// Handle restoring wallets that follow cip1852

import { discoverAllAddressesFrom } from '../../../common/lib/restoration/bip44AddressScan';
import type { GenerateAddressFunc } from '../../../common/lib/restoration/bip44AddressScan';
import type { ConfigType } from '../../../../../config/config-types';

import { ChainDerivations, BIP44_SCAN_SIZE } from '../../../../config/numbersConfig';

import { RustModule } from '../../lib/cardanoCrypto/rustLoader';
import {
  enterpriseAndBaseAddressHexFromKeyHashes,
  paymentKeyHashHex,
  rewardAddressFromKeyHash,
} from '../../lib/cardanoCrypto/cmlAddress';

import type { TreeInsert, InsertRequest } from '../../lib/storage/database/walletTypes/common/utils.types';
import type { AddByHashFunc } from '../../../common/lib/storage/bridge/hashMapper';
import type { NetworkRow, CanonicalAddressInsert } from '../../lib/storage/database/primitives/tables';
import { CoreAddressTypes } from '../../lib/storage/database/primitives/enums';
import type { Bip44ChainInsert } from '../../lib/storage/database/walletTypes/common/tables';
import { getCardanoHaskellBaseConfig } from '../../lib/storage/database/prepackaged/networks';
import { Bech32Prefix } from '../../../../config/stringConfig';
import type { FilterFunc } from '../../lib/state-fetch/types';
import { hexToBytes } from '../../../../coreUtils';

// populated by ConfigWebpackPlugin
declare var CONFIG: ConfigType;
const addressRequestSize = CONFIG.app.addressRequestSize;

export function genKeyhashBatchFunc(accountPublicKeyHex: string, chainIndex: number): GenerateAddressFunc {
  return (indices: Array<number>) => {
    return RustModule.WasmScope(Module => {
      const accountPublicKey = Module.CML.Bip32PublicKey.from_raw_bytes(hexToBytes(accountPublicKeyHex));
      const addressChain = accountPublicKey.derive(chainIndex);
      return indices.map(i =>
        addressChain
          .derive(i)
          .to_raw_key()
          .hash()
          .to_bech32(Bech32Prefix.PAYMENT_KEY_HASH)
      );
    });
  };
}

export async function addShelleyChimericAccountAddress(
  addByHash: AddByHashFunc,
  insertRequest: InsertRequest,
  stakingKeyHash: string,
  chainNetworkId: number
): Promise<{|
  KeyDerivationId: number,
|}> {
  const accountAddressHex = rewardAddressFromKeyHash(chainNetworkId, stakingKeyHash);
  await addByHash({
    ...insertRequest,
    address: {
      type: CoreAddressTypes.CARDANO_REWARD,
      data: accountAddressHex,
    },
  });

  return {
    KeyDerivationId: insertRequest.keyDerivationId,
  };
}

export async function addShelleyUtxoAddress(
  addByHash: AddByHashFunc,
  insertRequest: InsertRequest,
  stakingKeyHash: string,
  keyHash: string,
  networkId: number
): Promise<{|
  KeyDerivationId: number,
|}> {
  const { enterpriseAddressHex, baseAddressHex } = enterpriseAndBaseAddressHexFromKeyHashes(
    networkId,
    paymentKeyHashHex(keyHash),
    stakingKeyHash
  );
  await addByHash({
    ...insertRequest,
    address: {
      type: CoreAddressTypes.CARDANO_ENTERPRISE,
      data: enterpriseAddressHex,
    },
  });
  await addByHash({
    ...insertRequest,
    address: {
      type: CoreAddressTypes.CARDANO_BASE,
      data: baseAddressHex,
    },
  });
  return {
    KeyDerivationId: insertRequest.keyDerivationId,
  };
}

async function scanChain(request: {|
  generateAddressFunc: GenerateAddressFunc,
  lastUsedIndex: number,
  checkAddressesInUse: FilterFunc,
  stakingKeyHash: string,
  addByHash: AddByHashFunc,
  network: $ReadOnly<NetworkRow>,
|}): Promise<TreeInsert<CanonicalAddressInsert>> {
  const addresses = await discoverAllAddressesFrom(
    request.generateAddressFunc,
    request.lastUsedIndex,
    BIP44_SCAN_SIZE,
    addressRequestSize,
    request.checkAddressesInUse,
    request.network
  );

  const config = getCardanoHaskellBaseConfig(request.network).reduce((acc, next) => Object.assign(acc, next), {});

  /**
   * TODO: we need an endpoint here that
   * gets all the certificates ever registered with the staking key
   * that way we can properly generate pointer addresses ahead of time
   */

  return addresses.map(({ address, isUsed }, i) => {
    return {
      index: i + request.lastUsedIndex + 1,
      insert: async insertRequest => {
        return await addShelleyUtxoAddress(
          request.addByHash,
          insertRequest,
          request.stakingKeyHash,
          address,
          Number.parseInt(config.ChainNetworkId, 10)
        );
      },
      isUsed,
      address,
    };
  });
}

// <TODO:PENDING_REMOVAL> legacy
export async function scanShelleyCip1852Account(request: {|
  accountPublicKey: string,
  lastUsedInternal: number,
  lastUsedExternal: number,
  network: $ReadOnly<NetworkRow>,
  checkAddressesInUse: FilterFunc,
  addByHash: AddByHashFunc,
  stakingKeyHash: string,
|}): Promise<TreeInsert<Bip44ChainInsert>> {
  const config = getCardanoHaskellBaseConfig(request.network).reduce((acc, next) => Object.assign(acc, next), {});

  const insert = await scanAccount({
    generateInternalAddresses: genKeyhashBatchFunc(request.accountPublicKey, ChainDerivations.INTERNAL),
    generateExternalAddresses: genKeyhashBatchFunc(request.accountPublicKey, ChainDerivations.EXTERNAL),
    lastUsedInternal: request.lastUsedInternal,
    lastUsedExternal: request.lastUsedExternal,
    network: request.network,
    checkAddressesInUse: request.checkAddressesInUse,
    addByHash: request.addByHash,
    stakingKeyHash: request.stakingKeyHash,
    chainNetworkId: Number.parseInt(config.ChainNetworkId, 10),
  });
  return insert;
}
async function scanAccount(request: {|
  generateInternalAddresses: GenerateAddressFunc,
  generateExternalAddresses: GenerateAddressFunc,
  lastUsedInternal: number,
  lastUsedExternal: number,
  network: $ReadOnly<NetworkRow>,
  checkAddressesInUse: FilterFunc,
  addByHash: AddByHashFunc,
  stakingKeyHash: string,
  chainNetworkId: number,
|}): Promise<TreeInsert<Bip44ChainInsert>> {
  const externalAddresses = await scanChain({
    generateAddressFunc: request.generateExternalAddresses,
    lastUsedIndex: request.lastUsedExternal,
    network: request.network,
    checkAddressesInUse: request.checkAddressesInUse,
    addByHash: request.addByHash,
    stakingKeyHash: request.stakingKeyHash,
  });
  const internalAddresses = await scanChain({
    generateAddressFunc: request.generateInternalAddresses,
    lastUsedIndex: request.lastUsedInternal,
    network: request.network,
    checkAddressesInUse: request.checkAddressesInUse,
    addByHash: request.addByHash,
    stakingKeyHash: request.stakingKeyHash,
  });

  const accountAddress = [0].map(i => ({
    index: i,
    insert: async insertRequest => {
      return await addShelleyChimericAccountAddress(
        request.addByHash,
        insertRequest,
        request.stakingKeyHash,
        request.chainNetworkId
      );
    },
  }));

  return [
    {
      index: ChainDerivations.EXTERNAL,
      // initial value. Doesn't override existing entry
      insert: insertRequest =>
        Promise.resolve({
          KeyDerivationId: insertRequest.keyDerivationId,
          DisplayCutoff: 0,
        }),
      children: externalAddresses,
    },
    {
      index: ChainDerivations.INTERNAL,
      insert: insertRequest =>
        Promise.resolve({
          KeyDerivationId: insertRequest.keyDerivationId,
          DisplayCutoff: null,
        }),
      children: internalAddresses,
    },
    {
      index: ChainDerivations.CHIMERIC_ACCOUNT,
      insert: insertRequest =>
        Promise.resolve({
          KeyDerivationId: insertRequest.keyDerivationId,
          DisplayCutoff: null,
        }),
      children: accountAddress,
    },
  ];
}
