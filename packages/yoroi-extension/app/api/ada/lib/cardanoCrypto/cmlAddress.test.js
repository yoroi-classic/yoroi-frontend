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
  enterpriseAddressHexFromBaseOrPointerAddress,
  enterpriseAndBaseAddressHexFromKeyHashes,
  poolKeyHashHexToBech32,
  rewardAddressFromKeyHash,
  stakeCredentialHashFromAddress,
  stakingCredentialCborHexFromRewardAddress,
  stakingKeyHashFromRewardAddress,
} from './cmlAddress';
import {
  addressBech32ToHex as legacyAddressBech32ToHex,
  addressHexToBech32 as legacyAddressHexToBech32,
  dRepNormalize,
  dRepToMaybeCredentialHex,
  dRepToPreCip129,
  getStakingKeyHashesInTransactionBody,
  pubKeyHashToRewardAddress,
} from './utils';
import { hexToBase32 } from '../storage/bridge/utils';

beforeAll(async () => {
  await RustModule.load();
});

test('converts Shelley addresses between bech32 and hex with CML', () => {
  const address = 'addr1qf2w3pe8jsyvr9kutpv6e0rzuaym7dvq0rrz9699a7y3wwvz6g3gz764vxla692p4ttcekdw0smpedxuqq7a8t8sv3usrcv98z';
  const addressHex = addressBech32ToHex(address);

  expect(addressHexToBech32(addressHex)).toEqual(address);
});

test('derives canonical enterprise addresses from base and pointer addresses with CML', () => {
  const cases = RustModule.WasmScope(Module => {
    const CSL = Module.WalletV4;
    const addressCases = [];
    for (const networkId of [0, 1]) {
      for (const credentialKind of ['key', 'script']) {
        const paymentCredential =
          credentialKind === 'key'
            ? CSL.Credential.from_keyhash(CSL.Ed25519KeyHash.from_hex('11'.repeat(28)))
            : CSL.Credential.from_scripthash(CSL.ScriptHash.from_hex('22'.repeat(28)));
        const stakeCredential = CSL.Credential.from_keyhash(CSL.Ed25519KeyHash.from_hex('33'.repeat(28)));
        const expectedEnterpriseHex = CSL.EnterpriseAddress.new(networkId, paymentCredential)
          .to_address()
          .to_hex();
        const baseAddressHex = CSL.BaseAddress.new(networkId, paymentCredential, stakeCredential)
          .to_address()
          .to_hex();
        const pointer = CSL.Pointer.new(CSL.BigNum.from_str('1'), CSL.BigNum.from_str('2'), CSL.BigNum.from_str('3'));
        const pointerAddressHex = CSL.PointerAddress.new(networkId, paymentCredential, pointer)
          .to_address()
          .to_hex();

        addressCases.push({ addressHex: baseAddressHex, expectedEnterpriseHex });
        addressCases.push({ addressHex: pointerAddressHex, expectedEnterpriseHex });
      }
    }
    return addressCases;
  });

  for (const testCase of cases) {
    expect(enterpriseAddressHexFromBaseOrPointerAddress(testCase.addressHex)).toEqual(testCase.expectedEnterpriseHex);
  }
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

test('extracts the stake credential hash and encodes pool IDs with CML', () => {
  const baseAddress = 'addr1qf2w3pe8jsyvr9kutpv6e0rzuaym7dvq0rrz9699a7y3wwvz6g3gz764vxla692p4ttcekdw0smpedxuqq7a8t8sv3usrcv98z';
  const poolKeyHash = 'ab'.repeat(28);
  const expected = RustModule.WasmScope(Module => ({
    stakeHash: Module.WalletV4.BaseAddress.from_address(Module.WalletV4.Address.from_bech32(baseAddress))
      ?.stake_cred()
      .to_keyhash()
      ?.to_hex(),
    poolId: Module.WalletV4.Ed25519KeyHash.from_hex(poolKeyHash).to_bech32('pool'),
  }));

  expect(stakeCredentialHashFromAddress(baseAddress)).toEqual(expected.stakeHash);
  expect(stakeCredentialHashFromAddress('addr1vahzs6qr0cmmrh64p7jd2qtq2wlgggl5e0enr2my20f44ssv2wfee')).toBeNull();
  expect(poolKeyHashHexToBech32(poolKeyHash)).toEqual(expected.poolId);
});

test('extracts script stake credential hashes from base addresses', () => {
  const scriptHash = 'cd'.repeat(28);
  const scriptAddress = RustModule.WasmScope(Module => {
    const credential = Module.CML.Credential.new_script(Module.CML.ScriptHash.from_hex(scriptHash));
    return Module.CML.BaseAddress.new(1, credential, credential)
      .to_address()
      .to_bech32();
  });
  const expectedScriptHash = RustModule.WasmScope(Module =>
    Module.WalletV4.BaseAddress.from_address(Module.WalletV4.Address.from_bech32(scriptAddress))
      ?.stake_cred()
      .to_scripthash()
      ?.to_hex()
  );

  expect(stakeCredentialHashFromAddress(scriptAddress)).toEqual(expectedScriptHash);
});

test('keeps shared address and reward-address utility output compatible with CSL', () => {
  const address = 'addr1qf2w3pe8jsyvr9kutpv6e0rzuaym7dvq0rrz9699a7y3wwvz6g3gz764vxla692p4ttcekdw0smpedxuqq7a8t8sv3usrcv98z';
  const addressHex = RustModule.WasmScope(Module => Module.WalletV4.Address.from_bech32(address).to_hex());
  const stakeKeyHash = '12'.repeat(28);
  const rewardAddressHex = RustModule.WasmScope(Module =>
    Module.WalletV4.RewardAddress.new(
      1,
      Module.WalletV4.Credential.from_keyhash(Module.WalletV4.Ed25519KeyHash.from_hex(stakeKeyHash))
    )
      .to_address()
      .to_hex()
  );

  expect(legacyAddressBech32ToHex(address)).toEqual(addressHex);
  expect(legacyAddressHexToBech32(addressHex)).toEqual(address);
  expect(pubKeyHashToRewardAddress(stakeKeyHash, 1)).toEqual(rewardAddressHex);
});

test('normalizes legacy and CIP-129 DRep IDs with CML credential parsing', () => {
  const keyHash = '34'.repeat(28);
  const scriptHash = '56'.repeat(28);
  const legacyKeyDrep = hexToBase32(keyHash, 'drep');
  const keyHashDrep = hexToBase32(keyHash, 'drep_vkh');
  const scriptHashDrep = hexToBase32(scriptHash, 'drep_script');
  const cip129KeyDrep = hexToBase32(`22${keyHash}`, 'drep');
  const cip129ScriptDrep = hexToBase32(`23${scriptHash}`, 'drep');
  const expected = RustModule.WasmScope(Module => ({
    keyCredential: Module.WalletV4.Credential.from_keyhash(Module.WalletV4.Ed25519KeyHash.from_hex(keyHash)).to_hex(),
    scriptCredential: Module.WalletV4.Credential.from_scripthash(Module.WalletV4.ScriptHash.from_hex(scriptHash)).to_hex(),
  }));

  expect(dRepToMaybeCredentialHex(legacyKeyDrep)).toEqual(expected.keyCredential);
  expect(dRepToMaybeCredentialHex(keyHashDrep)).toEqual(expected.keyCredential);
  expect(dRepToMaybeCredentialHex(scriptHashDrep)).toEqual(expected.scriptCredential);
  expect(dRepToMaybeCredentialHex(cip129KeyDrep)).toEqual(expected.keyCredential);
  expect(dRepToMaybeCredentialHex(cip129ScriptDrep)).toEqual(expected.scriptCredential);
  expect(dRepNormalize(legacyKeyDrep)).toEqual(cip129KeyDrep);
  expect(dRepNormalize(scriptHashDrep)).toEqual(cip129ScriptDrep);
  expect(dRepNormalize(cip129KeyDrep)).toEqual(cip129KeyDrep);
  expect(dRepToPreCip129(cip129KeyDrep)).toEqual(legacyKeyDrep);
  expect(dRepToPreCip129(cip129ScriptDrep)).toEqual(scriptHashDrep);
  expect(dRepToMaybeCredentialHex('drep1invalid')).toBeNull();
});

test('extracts key-controlled staking credentials from CML transaction certificates and withdrawals', () => {
  const expectedKeyHashes = ['78'.repeat(28), '9a'.repeat(28), 'bc'.repeat(28)];
  const transactionBodyHex = RustModule.WasmScope(Module => {
    const CML = Module.CML;
    const certificates = CML.CertificateList.new();
    const registrationKey = CML.Credential.new_pub_key(CML.Ed25519KeyHash.from_hex(expectedKeyHashes[0]));
    const delegationKey = CML.Credential.new_pub_key(CML.Ed25519KeyHash.from_hex(expectedKeyHashes[1]));
    const scriptCredential = CML.Credential.new_script(CML.ScriptHash.from_hex('de'.repeat(28)));
    const withdrawalKey = CML.Credential.new_pub_key(CML.Ed25519KeyHash.from_hex(expectedKeyHashes[2]));
    certificates.add(CML.Certificate.new_reg_cert(registrationKey, 2_000_000n));
    certificates.add(CML.Certificate.new_stake_delegation(delegationKey, CML.Ed25519KeyHash.from_hex('ef'.repeat(28))));
    certificates.add(CML.Certificate.new_stake_registration(scriptCredential));

    const withdrawals = CML.MapRewardAccountToCoin.new();
    withdrawals.insert(CML.RewardAddress.new(1, withdrawalKey), 5n);

    const transactionBody = CML.TransactionBody.new(CML.TransactionInputList.new(), CML.TransactionOutputList.new(), 1n);
    transactionBody.set_certs(certificates);
    transactionBody.set_withdrawals(withdrawals);
    return transactionBody.to_cbor_hex();
  });

  expect(getStakingKeyHashesInTransactionBody(transactionBodyHex)).toEqual(new Set(expectedKeyHashes));
});
