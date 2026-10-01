// @flow
import '../test-config.forTests';
import { RustModule } from './rustLoader';
import {
  addressBech32ToHex,
  addressHexToBech32,
  baseAddressHexFromKeyHashes,
  baseAddressesFromKeyHashes,
  deriveRewardAddressFromAddress,
  enterpriseAndBaseAddressHexFromKeyHashes,
  rewardAddressFromKeyHash,
} from './cmlAddress';

beforeAll(async () => {
  await RustModule.load();
});

test('converts Shelley addresses between bech32 and hex with CML', () => {
  const address = 'addr1qf2w3pe8jsyvr9kutpv6e0rzuaym7dvq0rrz9699a7y3wwvz6g3gz764vxla692p4ttcekdw0smpedxuqq7a8t8sv3usrcv98z';
  const addressHex = addressBech32ToHex(address);

  expect(addressHexToBech32(addressHex)).toEqual(address);
});

test('derives a reward address from a base address stake credential', () => {
  const address = 'addr1qf2w3pe8jsyvr9kutpv6e0rzuaym7dvq0rrz9699a7y3wwvz6g3gz764vxla692p4ttcekdw0smpedxuqq7a8t8sv3usrcv98z';
  const networkId = 1;
  const rewardAddress = deriveRewardAddressFromAddress(address, networkId);

  expect(rewardAddress).toMatch(/^stake1/);
  const result = RustModule.WasmScope(Module => {
    const baseAddress = Module.CML.BaseAddress.from_address(Module.CML.Address.from_bech32(address));
    const parsedRewardAddress = Module.CML.RewardAddress.from_address(Module.CML.Address.from_bech32(rewardAddress));
    return {
      networkId: Module.CML.Address.from_bech32(rewardAddress).network_id(),
      stakeCredential: parsedRewardAddress?.payment().to_cbor_hex(),
      expectedStakeCredential: baseAddress?.stake().to_cbor_hex(),
    };
  });

  expect(result.networkId).toEqual(networkId);
  expect(result.stakeCredential).toEqual(result.expectedStakeCredential);
});

test('reconstructs base addresses from payment and stake key hashes', () => {
  const keyHashes = [{ payment: '01'.repeat(28), stake: '02'.repeat(28) }];
  const expectedAddresses = RustModule.WasmScope(Module =>
    keyHashes.map(({ payment, stake }) => {
      const paymentCredential = Module.WalletV4.Credential.from_keyhash(Module.WalletV4.Ed25519KeyHash.from_hex(payment));
      const stakeCredential = Module.WalletV4.Credential.from_keyhash(Module.WalletV4.Ed25519KeyHash.from_hex(stake));
      return Module.WalletV4.BaseAddress.new(1, paymentCredential, stakeCredential)
        .to_address()
        .to_bech32();
    })
  );

  expect(baseAddressesFromKeyHashes(1, keyHashes)).toEqual(expectedAddresses);
});

test('constructs enterprise, base, and reward addresses with CML', () => {
  const payment = '01'.repeat(28);
  const stake = '02'.repeat(28);
  const expected = RustModule.WasmScope(Module => {
    const CSL = Module.WalletV4;
    const paymentCredential = CSL.Credential.from_keyhash(CSL.Ed25519KeyHash.from_hex(payment));
    const stakeCredential = CSL.Credential.from_keyhash(CSL.Ed25519KeyHash.from_hex(stake));
    return {
      enterpriseAddressHex: CSL.EnterpriseAddress.new(1, paymentCredential)
        .to_address()
        .to_hex(),
      baseAddressHex: CSL.BaseAddress.new(1, paymentCredential, stakeCredential)
        .to_address()
        .to_hex(),
      rewardAddressHex: CSL.RewardAddress.new(1, stakeCredential)
        .to_address()
        .to_hex(),
    };
  });

  expect(enterpriseAndBaseAddressHexFromKeyHashes(1, payment, stake)).toEqual({
    enterpriseAddressHex: expected.enterpriseAddressHex,
    baseAddressHex: expected.baseAddressHex,
  });
  expect(rewardAddressFromKeyHash(1, stake)).toEqual(expected.rewardAddressHex);
  expect(baseAddressHexFromKeyHashes(1, payment, stake)).toEqual(expected.baseAddressHex);
});
