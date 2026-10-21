// @flow
import { RustModule } from './rustLoader';
import { bytesToHex, hexToBytes } from '../../../../coreUtils';

const derivePublicKeyHashHex = (accountPublicKey: any, path: Array<number>, startIndex: number): string => {
  if (startIndex < 0) throw new Error('keyLevel < startLevel');
  let publicKey = accountPublicKey;
  for (let i = startIndex; i < path.length; i++) {
    const index = path[i];
    if (index == null) throw new Error('Invalid public key derivation path');
    publicKey = publicKey.derive(index);
  }
  return publicKey.to_raw_key().hash().to_hex();
};

export const deriveBip32PublicKeyHashHex = (accountPublicKeyHex: string, path: Array<number>, startIndex: number = 0): string =>
  RustModule.WasmScope(Module => {
    const accountPublicKey = Module.CML.Bip32PublicKey.from_raw_bytes(hexToBytes(accountPublicKeyHex));
    return derivePublicKeyHashHex(accountPublicKey, path, startIndex);
  });

export const deriveBip32PublicKeyRawHex = (accountPublicKeyHex: string, path: Array<number>, startIndex: number = 0): string =>
  RustModule.WasmScope(Module => {
    let publicKey = Module.CML.Bip32PublicKey.from_raw_bytes(hexToBytes(accountPublicKeyHex));
    for (let i = startIndex; i < path.length; i++) {
      const index = path[i];
      if (index == null) throw new Error('Invalid public key derivation path');
      publicKey = publicKey.derive(index);
    }
    return bytesToHex(publicKey.to_raw_key().to_raw_bytes());
  });

export const deriveBip32PublicKeyHashesHex = (accountPublicKeyHex: string, paths: Array<Array<number>>): Array<string> =>
  RustModule.WasmScope(Module => {
    const accountPublicKey = Module.CML.Bip32PublicKey.from_raw_bytes(hexToBytes(accountPublicKeyHex));
    return paths.map(path => derivePublicKeyHashHex(accountPublicKey, path, 0));
  });

const parseAddress = (Module: any, address: string): any => {
  try {
    return Module.CML.Address.from_hex(address);
  } catch (_hexError) {
    try {
      return Module.CML.Address.from_bech32(address);
    } catch (_bech32Error) {
      try {
        return Module.CML.ByronAddress.from_base58(address).to_address();
      } catch (_base58Error) {
        return Module.CML.ByronAddress.from_cbor_hex(address).to_address();
      }
    }
  }
};

export const addressHexToBech32 = (addressHex: string): string =>
  RustModule.WasmScope(Module => Module.CML.Address.from_hex(addressHex).to_bech32());

export const normalizeAddressToHex = (address: string): string =>
  RustModule.WasmScope(Module => parseAddress(Module, address).to_hex());

export const addressBech32ToHex = (addressBech32: string): string =>
  RustModule.WasmScope(Module => Module.CML.Address.from_bech32(addressBech32).to_hex());

export const enterpriseAddressHexFromBaseOrPointerAddress = (addressHex: string): string =>
  RustModule.WasmScope(Module => {
    const address = Module.CML.Address.from_hex(addressHex);
    const baseAddress = Module.CML.BaseAddress.from_address(address);
    if (baseAddress != null) {
      return Module.CML.EnterpriseAddress.new(address.network_id(), baseAddress.payment()).to_address().to_hex();
    }

    const pointerAddress = Module.CML.PointerAddress.from_address(address);
    if (pointerAddress != null) {
      return Module.CML.EnterpriseAddress.new(address.network_id(), pointerAddress.payment()).to_address().to_hex();
    }

    throw new Error('Address is not a base or pointer address');
  });

export const credentialCborHexFromKeyHash = (keyHash: string): string =>
  RustModule.WasmScope(Module => Module.CML.Credential.new_pub_key(Module.CML.Ed25519KeyHash.from_hex(keyHash)).to_cbor_hex());

export const paymentKeyHashHex = (keyHash: string): string =>
  RustModule.WasmScope(Module => {
    try {
      return Module.CML.Ed25519KeyHash.from_hex(keyHash).to_hex();
    } catch (_hexError) {
      return Module.CML.Ed25519KeyHash.from_bech32(keyHash).to_hex();
    }
  });

export const stakingCredentialCborHexFromRewardAddress = (stakingAddressHex: string): string =>
  RustModule.WasmScope(Module => {
    const rewardAddress = Module.CML.RewardAddress.from_address(Module.CML.Address.from_hex(stakingAddressHex));
    if (rewardAddress == null) throw new Error('Staking address is not a reward address');
    return rewardAddress.payment().to_cbor_hex();
  });

export const stakingKeyHashFromRewardAddress = (stakingAddressHex: string): string | null =>
  RustModule.WasmScope(Module => {
    const rewardAddress = Module.CML.RewardAddress.from_address(Module.CML.Address.from_hex(stakingAddressHex));
    if (rewardAddress == null) throw new Error('Staking address is not a reward address');
    return rewardAddress.payment().as_pub_key()?.to_hex() ?? null;
  });

export const paymentKeyHashBech32FromEnterpriseAddress = (addressHex: string, prefix: string): string | null =>
  RustModule.WasmScope(Module => {
    const address = Module.CML.Address.from_hex(addressHex);
    const enterpriseAddress = Module.CML.EnterpriseAddress.from_address(address);
    if (enterpriseAddress == null) return null;
    return enterpriseAddress.payment().as_pub_key()?.to_bech32(prefix) ?? null;
  });

export const addressHasStakeCredential = (address: string, credentialCborHex: string): boolean =>
  RustModule.WasmScope(Module => {
    const cmlAddress = parseAddress(Module, address);
    const baseAddress = Module.CML.BaseAddress.from_address(cmlAddress);
    return baseAddress != null && baseAddress.stake().to_cbor_hex() === credentialCborHex;
  });

export const stakeCredentialHashFromAddress = (address: string): string | null =>
  RustModule.WasmScope(Module => {
    const baseAddress = Module.CML.BaseAddress.from_address(Module.CML.Address.from_bech32(address));
    const stakeCredential = baseAddress?.stake();
    if (stakeCredential == null) return null;
    return stakeCredential.as_pub_key()?.to_hex() ?? stakeCredential.as_script()?.to_hex() ?? null;
  });

export const poolKeyHashHexToBech32 = (poolKeyHashHex: string): string =>
  RustModule.WasmScope(Module => Module.CML.Ed25519KeyHash.from_hex(poolKeyHashHex).to_bech32('pool'));

export const baseAddressesFromKeyHashes = (
  networkId: number,
  keyHashes: Array<{ payment: string, stake: string }>
): Array<string> =>
  RustModule.WasmScope(Module =>
    keyHashes.map(({ payment, stake }) => {
      const paymentCredential = Module.CML.Credential.new_pub_key(Module.CML.Ed25519KeyHash.from_hex(payment));
      const stakeCredential = Module.CML.Credential.new_pub_key(Module.CML.Ed25519KeyHash.from_hex(stake));
      return Module.CML.BaseAddress.new(networkId, paymentCredential, stakeCredential).to_address().to_bech32();
    })
  );

export const rewardAddressFromKeyHash = (networkId: number, stakeKeyHash: string): string =>
  RustModule.WasmScope(Module => {
    const stakeCredential = Module.CML.Credential.new_pub_key(Module.CML.Ed25519KeyHash.from_hex(stakeKeyHash));
    return Module.CML.RewardAddress.new(networkId, stakeCredential).to_address().to_hex();
  });

export const baseAddressHexFromKeyHashes = (networkId: number, paymentKeyHash: string, stakeKeyHash: string): string =>
  RustModule.WasmScope(Module => {
    const paymentCredential = Module.CML.Credential.new_pub_key(Module.CML.Ed25519KeyHash.from_hex(paymentKeyHash));
    const stakeCredential = Module.CML.Credential.new_pub_key(Module.CML.Ed25519KeyHash.from_hex(stakeKeyHash));
    return Module.CML.BaseAddress.new(networkId, paymentCredential, stakeCredential).to_address().to_hex();
  });

export const enterpriseAndBaseAddressHexFromKeyHashes = (
  networkId: number,
  paymentKeyHash: string,
  stakeKeyHash: string
): {| enterpriseAddressHex: string, baseAddressHex: string |} =>
  RustModule.WasmScope(Module => {
    const paymentCredential = Module.CML.Credential.new_pub_key(Module.CML.Ed25519KeyHash.from_hex(paymentKeyHash));
    const stakeCredential = Module.CML.Credential.new_pub_key(Module.CML.Ed25519KeyHash.from_hex(stakeKeyHash));
    const enterpriseAddressHex = Module.CML.EnterpriseAddress.new(networkId, paymentCredential).to_address().to_hex();
    const baseAddressHex = Module.CML.BaseAddress.new(networkId, paymentCredential, stakeCredential).to_address().to_hex();
    return { enterpriseAddressHex, baseAddressHex };
  });

export const deriveRewardAddressFromAddress = (address: string, networkId: number): string =>
  RustModule.WasmScope(Module => {
    const baseAddress = Module.CML.BaseAddress.from_address(Module.CML.Address.from_bech32(address));
    const stakeCredential = baseAddress?.stake();
    if (stakeCredential == null) throw new Error('Address has no stake credential');
    return Module.CML.RewardAddress.new(networkId, stakeCredential).to_address().to_bech32();
  });

const readPointerComponent = (bytes: Uint8Array, start: number): {| value: BigIntValue, next: number |} => {
  let value = BigInt('0');
  let index = start;
  while (index < bytes.length) {
    const byte = bytes[index];
    if (byte === undefined) throw new Error('Invalid pointer address');
    // eslint-disable-next-line no-undef
    value = (value << BigInt('7')) | BigInt(byte & 0x7f);
    index += 1;
    if ((byte & 0x80) === 0) return { value, next: index };
  }
  throw new Error('Invalid pointer address');
};

export const stakePointerFromAddressBech32 = (addressBech32: string): [string, string, string] =>
  RustModule.WasmScope(Module => {
    const address = Module.CML.Address.from_bech32(addressBech32);
    const pointerAddress = Module.CML.PointerAddress.from_address(address);
    if (pointerAddress == null) throw new Error('Address is not a pointer address');

    // Pointer addresses encode the three chain coordinates as base-128 varints
    // after the header and 28-byte payment credential.
    return stakePointerFromRawBytes(address.to_raw_bytes());
  });

export const stakePointerFromRawBytes = (bytes: Uint8Array): [string, string, string] => {
  let offset = 29;
  const slot = readPointerComponent(bytes, offset);
  offset = slot.next;
  const transactionIndex = readPointerComponent(bytes, offset);
  offset = transactionIndex.next;
  const certificateIndex = readPointerComponent(bytes, offset);
  if (certificateIndex.next !== bytes.length) throw new Error('Invalid pointer address');
  return [slot.value.toString(), transactionIndex.value.toString(), certificateIndex.value.toString()];
};
