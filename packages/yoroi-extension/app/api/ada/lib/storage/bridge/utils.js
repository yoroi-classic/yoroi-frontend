// @flow

import type { CoreAddressT } from '../database/primitives/enums';
import { CoreAddressTypes } from '../database/primitives/enums';
import { RustModule } from '../../cardanoCrypto/rustLoader';
import { normalizeAddressToHex, stakingKeyHashFromRewardAddress } from '../../cardanoCrypto/cmlAddress';
import type { NetworkRow } from '../database/primitives/tables';
import { isCardanoHaskell } from '../database/prepackaged/networks';
import type { $npm$ReactIntl$MessageDescriptor } from 'react-intl';
import { defineMessages } from 'react-intl';
import { bech32 as bech32Module } from 'bech32';
import { bytesToHex, fail, hexToBytes, maybe } from '../../../../../coreUtils';

export function tryAddressToKind(
  address: string,
  parseAs: 'bech32' | 'bytes',
  network: $ReadOnly<NetworkRow>
): void | CoreAddressT {
  try {
    return addressToKind(address, parseAs, network);
  } catch (_e) {
    return undefined;
  }
}

export function addressToKind(address: string, parseAs: 'bech32' | 'bytes', network: $ReadOnly<NetworkRow>): CoreAddressT {
  try {
    return RustModule.WasmScope(Scope => {
      if (isCardanoHaskell(network)) {
        // Need to try parsing as a legacy address first
        // Since parsing as bech32 directly may give a wrong result if the address contains a 1
        if (Scope.CML.ByronAddress.is_valid(address)) {
          return CoreAddressTypes.CARDANO_LEGACY;
        }
        const wasmAddr = parseAs === 'bytes' ? Scope.CML.Address.from_hex(address) : Scope.CML.Address.from_bech32(address);
        {
          const byronAddr = Scope.CML.ByronAddress.from_address(wasmAddr);
          if (byronAddr) return CoreAddressTypes.CARDANO_LEGACY;
        }
        {
          const baseAddr = Scope.CML.BaseAddress.from_address(wasmAddr);
          if (baseAddr) return CoreAddressTypes.CARDANO_BASE;
        }
        {
          const ptrAddr = Scope.CML.PointerAddress.from_address(wasmAddr);
          if (ptrAddr) return CoreAddressTypes.CARDANO_PTR;
        }
        {
          const enterpriseAddr = Scope.CML.EnterpriseAddress.from_address(wasmAddr);
          if (enterpriseAddr) return CoreAddressTypes.CARDANO_ENTERPRISE;
        }
        {
          const rewardAddr = Scope.CML.RewardAddress.from_address(wasmAddr);
          if (rewardAddr) return CoreAddressTypes.CARDANO_REWARD;
        }
        throw new Error(`${nameof(addressToKind)} unknown address type`);
      }
      throw new Error(`${nameof(addressToKind)} not implemented for network ${network.NetworkId}`);
    });
  } catch (e1) {
    throw new Error(`${nameof(addressToKind)} failed to parse address type ${e1} ${address}`);
  }
}

// <TODO:FIX> THIS IS TERRIBLE, messages in api and the return type is awful
export function isValidReceiveAddress(
  bech32: string,
  network: $ReadOnly<NetworkRow>
): true | [false, $Exact<$npm$ReactIntl$MessageDescriptor>, number] {
  const messages = defineMessages({
    invalidAddress: {
      id: 'wallet.send.form.errors.invalidAddress',
      defaultMessage: '!!!Incorrect address format',
    },
    cannotSendToLegacy: {
      id: 'wallet.send.form.cannotSendToLegacy',
      defaultMessage: '!!!Unable to send funds to legacy addresses (any address created before July 29th, 2020).',
    },
    cannotSendToReward: {
      id: 'wallet.send.form.cannotSendToReward',
      defaultMessage: '!!!Unable to send funds to a reward account.',
    },
    cannotSendToP2SH: {
      id: 'wallet.send.form.cannotSendToP2SH',
      defaultMessage: '!!!Unable to send funds to pay-to-script-hash addresses.',
    },
    wrongNetwork: {
      id: 'global.wrongNetwork.address',
      defaultMessage: '!!!This address is on a different network. Please retype.',
    },
  });

  const kind = tryAddressToKind(bech32, 'bech32', network);
  if (kind == null) {
    return [false, messages.invalidAddress, 1];
  }
  if (isCardanoHaskell(network)) {
    if (kind === CoreAddressTypes.CARDANO_REWARD) {
      return [false, messages.cannotSendToReward, 2];
    }
    if (isCardanoHaskellAddress(kind)) {
      const addrHex = normalizeToAddress(bech32);
      if (addrHex == null) throw new Error('Should never happen');
      const expectedNetworkId = Number.parseInt(network.BaseConfig[0].ChainNetworkId, 10);
      const networkId = RustModule.WasmScope(Module => Module.CML.Address.from_hex(addrHex).network_id());
      if (networkId !== expectedNetworkId) {
        return [false, messages.wrongNetwork, 3];
      }
      return true;
    }
    return [false, messages.invalidAddress, 1];
  }

  throw new Error(`${nameof(isValidReceiveAddress)} Unsupported network ${JSON.stringify(network)}`);
}

export function byronAddrToHex(base58Addr: string): string {
  return RustModule.WasmScope(Module => Module.CML.ByronAddress.from_base58(base58Addr).to_cbor_hex());
}

export function normalizeToBase58(addr: string): void | string {
  // in Shelley, addresses can be base16, bech32 or base58
  // this function normalizes everything to base58

  // 1) If already base58, simply return
  return RustModule.WasmScope(Module => {
    if (Module.CML.ByronAddress.is_valid(addr)) return addr;

    try {
      const parsedAddress = Module.CML.Address.from_hex(addr);
      const byronAddress = Module.CML.ByronAddress.from_address(parsedAddress);
      if (byronAddress != null) return byronAddress.to_base58();
      return undefined; // wrong address kind
    } catch (_error) {} // eslint-disable-line no-empty

    try {
      const parsedAddress = Module.CML.Address.from_bech32(addr);
      const byronAddress = Module.CML.ByronAddress.from_address(parsedAddress);
      if (byronAddress != null) return byronAddress.to_base58();
      return undefined; // wrong address kind
    } catch (_error) {} // eslint-disable-line no-empty

    return undefined;
  });
}

/**
 * this implementation was copied from the convert function of the bech32 package.
 */
const convertBase32ToHex = (data: any[]): string => {
  return bytesToHex(bech32Module.fromWords(data));
};

export const base32ToHex = (base32: string): ?string => {
  const base32Words = bech32Module.decodeUnsafe(base32, base32.length);
  return maybe(base32Words?.words, convertBase32ToHex);
};

export const hexToBase32 = (hex: string, prefix: string): string => {
  return bech32Module.encode(prefix, bech32Module.toWords(hexToBytes(hex)));
};

export function normalizeToAddress(addr: string): void | string {
  try {
    return normalizeAddressToHex(addr);
  } catch (_error) {
    return undefined;
  }
}

export function toEnterprise(address: string): void | string {
  return RustModule.WasmScope(Module => {
    if (Module.CML.ByronAddress.is_valid(address)) return undefined;
    const wasmAddr = Module.CML.Address.from_hex(address);
    const byronAddress = Module.CML.ByronAddress.from_address(wasmAddr);
    if (byronAddress != null) return undefined;
    const baseAddress = Module.CML.BaseAddress.from_address(wasmAddr);
    const pointerAddress = Module.CML.PointerAddress.from_address(wasmAddr);
    const enterpriseAddress = Module.CML.EnterpriseAddress.from_address(wasmAddr);
    const rewardAddress = Module.CML.RewardAddress.from_address(wasmAddr);
    const paymentCredential =
      baseAddress?.payment() ?? pointerAddress?.payment() ?? enterpriseAddress?.payment() ?? rewardAddress?.payment();
    const paymentKeyHash = paymentCredential?.as_pub_key();
    if (paymentKeyHash == null) return undefined;
    const networkId = wasmAddr.network_id();
    return Module.CML.EnterpriseAddress.new(networkId, Module.CML.Credential.new_pub_key(paymentKeyHash)).to_address().to_hex();
  });
}

export function isCardanoHaskellAddress(kind: CoreAddressT): boolean {
  if (kind === CoreAddressTypes.CARDANO_LEGACY) return true;
  if (kind === CoreAddressTypes.CARDANO_BASE) return true;
  if (kind === CoreAddressTypes.CARDANO_PTR) return true;
  if (kind === CoreAddressTypes.CARDANO_ENTERPRISE) return true;
  if (kind === CoreAddressTypes.CARDANO_REWARD) return true;
  return false;
}

export function getCardanoSpendingKeyHash(addr: string | any): string | null | void {
  return RustModule.WasmScope(Module => {
    let address;
    if (typeof addr === 'string') {
      if (Module.CML.ByronAddress.is_valid(addr)) return null;
      try {
        address = Module.CML.Address.from_hex(addr);
      } catch (_hexError) {
        address = Module.CML.Address.from_bech32(addr);
      }
    } else {
      address = Module.CML.Address.from_hex(addr.to_hex());
    }
    if (Module.CML.ByronAddress.from_address(address) != null) return null;
    const baseAddress = Module.CML.BaseAddress.from_address(address);
    const pointerAddress = Module.CML.PointerAddress.from_address(address);
    const enterpriseAddress = Module.CML.EnterpriseAddress.from_address(address);
    const rewardAddress = Module.CML.RewardAddress.from_address(address);
    const credential =
      baseAddress?.payment() ?? pointerAddress?.payment() ?? enterpriseAddress?.payment() ?? rewardAddress?.payment();
    if (credential == null) throw new Error(`${nameof(getCardanoSpendingKeyHash)} unknown address type`);
    return credential.as_pub_key()?.to_hex();
  });
}

export function addressToDisplayString(address: string, network: $ReadOnly<NetworkRow>): string {
  try {
    if (isCardanoHaskell(network)) {
      // Need to try parsing as a legacy address first
      // Since parsing as bech32 directly may give a wrong result if the address contains a 1
      return RustModule.WasmScope(Module => {
        if (Module.CML.ByronAddress.is_valid(address)) return address;
        const parsedAddress = Module.CML.Address.from_hex(address);
        const byronAddress = Module.CML.ByronAddress.from_address(parsedAddress);
        return byronAddress == null ? parsedAddress.to_bech32() : byronAddress.to_base58();
      });
    }
    throw new Error(`${nameof(addressToDisplayString)} not implemented for network ${network.NetworkId}`);
  } catch (_e2) {
    throw new Error(`${nameof(addressToDisplayString)} failed to parse address type ` + address);
  }
}

// need to format shelley addresses as base16 but only legacy addresses as base58
export function toHexOrBase58(addressHex: string): string {
  return RustModule.WasmScope(Module => {
    const address = Module.CML.Address.from_hex(addressHex);
    return Module.CML.ByronAddress.from_address(address)?.to_base58() ?? address.to_hex();
  });
}

export function getAddressPayload(address: string, network: $ReadOnly<NetworkRow>): string {
  try {
    if (isCardanoHaskell(network)) {
      // Need to try parsing as a legacy address first
      // Since parsing as bech32 directly may give a wrong result if the address contains a 1
      return RustModule.WasmScope(Module => {
        if (Module.CML.ByronAddress.is_valid(address)) return address;
        const parsedAddress = Module.CML.Address.from_bech32(address);
        return Module.CML.ByronAddress.from_address(parsedAddress)?.to_base58() ?? parsedAddress.to_hex();
      });
    }
    throw new Error(`${nameof(getAddressPayload)} not implemented for network ${network.NetworkId}`);
  } catch (_e2) {
    throw new Error(`${nameof(getAddressPayload)} failed to parse address type ` + address);
  }
}

export function unwrapStakingKey(stakingAddress: string): string {
  try {
    const keyHash = stakingKeyHashFromRewardAddress(stakingAddress);
    if (keyHash == null) throw new Error('Staking credential is not a key');
    return keyHash;
  } catch (_error) {
    return fail(`${nameof(unwrapStakingKey)} staking key invalid`);
  }
}

export function isCertificateKindDrepDelegation(kind: number): boolean {
  const certificateKind = RustModule.CML.CertificateKind;
  return (
    kind === certificateKind.VoteDelegCert ||
    kind === certificateKind.StakeVoteDelegCert ||
    kind === certificateKind.VoteRegDelegCert ||
    kind === certificateKind.StakeVoteRegDelegCert
  );
}
