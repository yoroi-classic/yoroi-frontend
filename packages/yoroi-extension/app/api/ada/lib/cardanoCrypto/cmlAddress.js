// @flow
import { RustModule } from './rustLoader';

export const addressHexToBech32 = (addressHex: string): string =>
  RustModule.WasmScope(Module => Module.CML.Address.from_hex(addressHex).to_bech32());

export const addressBech32ToHex = (addressBech32: string): string =>
  RustModule.WasmScope(Module => Module.CML.Address.from_bech32(addressBech32).to_hex());

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
