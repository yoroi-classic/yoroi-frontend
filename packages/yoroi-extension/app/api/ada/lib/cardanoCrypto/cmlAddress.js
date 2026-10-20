// @flow
import { RustModule } from './rustLoader';

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

export const addressBech32ToHex = (addressBech32: string): string =>
  RustModule.WasmScope(Module => Module.CML.Address.from_bech32(addressBech32).to_hex());

export const enterpriseAddressHexFromBaseOrPointerAddress = (addressHex: string): string =>
  RustModule.WasmScope(Module => {
    const address = Module.CML.Address.from_hex(addressHex);
    const baseAddress = Module.CML.BaseAddress.from_address(address);
    if (baseAddress != null) {
      return Module.CML.EnterpriseAddress.new(address.network_id(), baseAddress.payment())
        .to_address()
        .to_hex();
    }

    const pointerAddress = Module.CML.PointerAddress.from_address(address);
    if (pointerAddress != null) {
      return Module.CML.EnterpriseAddress.new(address.network_id(), pointerAddress.payment())
        .to_address()
        .to_hex();
    }

    throw new Error('Address is not a base or pointer address');
  });

export const credentialCborHexFromKeyHash = (keyHash: string): string =>
  RustModule.WasmScope(Module => Module.CML.Credential.new_pub_key(Module.CML.Ed25519KeyHash.from_hex(keyHash)).to_cbor_hex());

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
    return (
      rewardAddress
        .payment()
        .as_pub_key()
        ?.to_hex() ?? null
    );
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
      return Module.CML.BaseAddress.new(networkId, paymentCredential, stakeCredential)
        .to_address()
        .to_bech32();
    })
  );

export const rewardAddressFromKeyHash = (networkId: number, stakeKeyHash: string): string =>
  RustModule.WasmScope(Module => {
    const stakeCredential = Module.CML.Credential.new_pub_key(Module.CML.Ed25519KeyHash.from_hex(stakeKeyHash));
    return Module.CML.RewardAddress.new(networkId, stakeCredential)
      .to_address()
      .to_hex();
  });

export const baseAddressHexFromKeyHashes = (networkId: number, paymentKeyHash: string, stakeKeyHash: string): string =>
  RustModule.WasmScope(Module => {
    const paymentCredential = Module.CML.Credential.new_pub_key(Module.CML.Ed25519KeyHash.from_hex(paymentKeyHash));
    const stakeCredential = Module.CML.Credential.new_pub_key(Module.CML.Ed25519KeyHash.from_hex(stakeKeyHash));
    return Module.CML.BaseAddress.new(networkId, paymentCredential, stakeCredential)
      .to_address()
      .to_hex();
  });

export const enterpriseAndBaseAddressHexFromKeyHashes = (
  networkId: number,
  paymentKeyHash: string,
  stakeKeyHash: string
): {| enterpriseAddressHex: string, baseAddressHex: string |} =>
  RustModule.WasmScope(Module => {
    const paymentCredential = Module.CML.Credential.new_pub_key(Module.CML.Ed25519KeyHash.from_hex(paymentKeyHash));
    const stakeCredential = Module.CML.Credential.new_pub_key(Module.CML.Ed25519KeyHash.from_hex(stakeKeyHash));
    const enterpriseAddressHex = Module.CML.EnterpriseAddress.new(networkId, paymentCredential)
      .to_address()
      .to_hex();
    const baseAddressHex = Module.CML.BaseAddress.new(networkId, paymentCredential, stakeCredential)
      .to_address()
      .to_hex();
    return { enterpriseAddressHex, baseAddressHex };
  });

export const deriveRewardAddressFromAddress = (address: string, networkId: number): string =>
  RustModule.WasmScope(Module => {
    const baseAddress = Module.CML.BaseAddress.from_address(Module.CML.Address.from_bech32(address));
    const stakeCredential = baseAddress?.stake();
    if (stakeCredential == null) throw new Error('Address has no stake credential');
    return Module.CML.RewardAddress.new(networkId, stakeCredential)
      .to_address()
      .to_bech32();
  });
