// @flow
import '../test-config.forTests';
import { RustModule } from './rustLoader';
import {
  addressBech32ToHex,
  addressHasStakeCredential,
  addressHexToBech32,
  baseAddressHexFromKeyHashes,
  baseAddressesFromKeyHashes,
  credentialCborHexFromKeyHash,
  deriveRewardAddressFromAddress,
  enterpriseAndBaseAddressHexFromKeyHashes,
  rewardAddressFromKeyHash,
  stakingCredentialCborHexFromRewardAddress,
  stakingKeyHashFromRewardAddress,
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

test('extracts staking credential and key hashes from reward addresses with CML', () => {
  const rewardAddressHex = 'e89ec1b053b44c4ec71efbd200e80eb2ef4cef788f984ee5846f6f11bf';
  const expected = RustModule.WasmScope(Module => {
    const rewardAddress = Module.WalletV4.RewardAddress.from_address(Module.WalletV4.Address.from_hex(rewardAddressHex));
    const credential = rewardAddress?.payment_cred();
    return {
      credentialCborHex: credential?.to_hex(),
      keyHashHex: credential?.to_keyhash()?.to_hex(),
    };
  });

  expect(stakingCredentialCborHexFromRewardAddress(rewardAddressHex)).toEqual(expected.credentialCborHex);
  expect(stakingKeyHashFromRewardAddress(rewardAddressHex)).toEqual(expected.keyHashHex);
  expect(credentialCborHexFromKeyHash(expected.keyHashHex)).toEqual(expected.credentialCborHex);
});

test('matches base-address stake credentials for hex, bech32, and non-base address forms', () => {
  const baseAddress = 'addr1qf2w3pe8jsyvr9kutpv6e0rzuaym7dvq0rrz9699a7y3wwvz6g3gz764vxla692p4ttcekdw0smpedxuqq7a8t8sv3usrcv98z';
  const stakeCredential = RustModule.WasmScope(Module =>
    Module.WalletV4.BaseAddress.from_address(Module.WalletV4.Address.from_bech32(baseAddress))
      ?.stake_cred()
      .to_hex()
  );
  const baseAddressHex = RustModule.WasmScope(Module => Module.WalletV4.Address.from_bech32(baseAddress).to_hex());

  expect(addressHasStakeCredential(baseAddress, stakeCredential)).toBe(true);
  expect(addressHasStakeCredential(baseAddressHex, stakeCredential)).toBe(true);
  expect(addressHasStakeCredential('addr1vahzs6qr0cmmrh64p7jd2qtq2wlgggl5e0enr2my20f44ssv2wfee', stakeCredential)).toBe(false);
  expect(addressHasStakeCredential('Ae2tdPwUPEZ6ipzynAWN6atmb9LNqEogput2NrMD3Z8UL7phtQLDhrKt1bf', stakeCredential)).toBe(false);
  expect(
    addressHasStakeCredential(
      '82d818582183581c99394e1ca570f79e250651062545898c022145444079d9019b612a51a0001a2ebac743',
      stakeCredential
    )
  ).toBe(false);
});
