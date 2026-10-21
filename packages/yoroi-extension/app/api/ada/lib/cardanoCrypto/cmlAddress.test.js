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
  deriveBip32PublicKeyHashHex,
  deriveBip32PublicKeyRawHex,
  enterpriseAddressHexFromBaseOrPointerAddress,
  enterpriseAndBaseAddressHexFromKeyHashes,
  normalizeAddressToHex,
  paymentKeyHashBech32FromEnterpriseAddress,
  poolKeyHashHexToBech32,
  rewardAddressFromKeyHash,
  stakeCredentialHashFromAddress,
  stakingCredentialCborHexFromRewardAddress,
  stakingKeyHashFromRewardAddress,
  stakePointerFromAddressBech32,
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
import { bytesToHex } from '../../../../coreUtils';
import { hexToBase32 } from '../storage/bridge/utils';
import {
  genesisKeyDelegationCertificateHex,
  mirCertificatePayloadHex,
  mirRewardForRewardAddress,
  poolRegistrationPayloads,
} from './cmlCertificates';

beforeAll(async () => {
  await RustModule.load();
});

test('converts Shelley addresses between bech32 and hex with CML', () => {
  const address = 'addr1qf2w3pe8jsyvr9kutpv6e0rzuaym7dvq0rrz9699a7y3wwvz6g3gz764vxla692p4ttcekdw0smpedxuqq7a8t8sv3usrcv98z';
  const addressHex = addressBech32ToHex(address);

  expect(addressHexToBech32(addressHex)).toEqual(address);
});

test('extracts enterprise payment key hashes for wallet transaction requests', () => {
  const vectors = RustModule.WasmScope(Module => {
    const cml = Module.CML;
    return ['key', 'script'].map(kind => {
      const payment =
        kind === 'key'
          ? cml.Credential.new_pub_key(cml.Ed25519KeyHash.from_hex('11'.repeat(28)))
          : cml.Credential.new_script(cml.ScriptHash.from_hex('22'.repeat(28)));
      const address = cml.EnterpriseAddress.new(1, payment).to_address().to_hex();
      const keyHash = payment.as_pub_key();
      return { address, expected: keyHash?.to_bech32('addr_vkh') ?? null };
    });
  });

  for (const { address, expected } of vectors) {
    expect(paymentKeyHashBech32FromEnterpriseAddress(address, 'addr_vkh')).toEqual(expected);
  }
  expect(() => paymentKeyHashBech32FromEnterpriseAddress('not-an-address', 'addr_vkh')).toThrow();
});

test('creates DB certificate payload bytes matching historical fixtures', () => {
  const credentialHex = `8200581c${'11'.repeat(28)}`;
  const poolHash = '22'.repeat(28);
  const stakeHex = `8200${credentialHex}`;
  const delegationHex = `8302${credentialHex}581c${poolHash}`;
  const retirementHex = `8304581c${poolHash}182a`;
  const result = RustModule.WasmScope(Module => {
    const cml = Module.CML;
    const credential = cml.Credential.from_cbor_hex(credentialHex);
    const pool = cml.Ed25519KeyHash.from_hex(poolHash);
    return {
      stake: cml.Certificate.new_stake_registration(credential).to_cbor_hex(),
      delegation: cml.Certificate.new_stake_delegation(credential, pool).to_cbor_hex(),
      retirement: cml.Certificate.new_pool_retirement(pool, BigInt('42')).to_cbor_hex(),
    };
  });
  expect(result).toEqual({ stake: stakeHex, delegation: delegationHex, retirement: retirementHex });
});

test('creates pool registration and genesis delegation payloads with historical fixtures', () => {
  const rewardAddressHex = RustModule.WasmScope(Module => {
    const cml = Module.CML;
    return cml.RewardAddress.new(1, cml.Credential.new_pub_key(cml.Ed25519KeyHash.from_hex('11'.repeat(28))))
      .to_address()
      .to_hex();
  });
  const pool = poolRegistrationPayloads({
    operator: '22'.repeat(28),
    vrfKeyHash: '55'.repeat(32),
    pledge: '123456',
    cost: '789',
    rewardAccount: rewardAddressHex,
    poolOwners: ['33'.repeat(28)],
    poolMetadata: { url: 'https://pool.example', metadataHash: '44'.repeat(32) },
  });
  expect(pool.certificateHex).toEqual(
    '8a03581c22222222222222222222222222222222222222222222222222222222582055555555555555555555555555555555555555555555555555555555555555551a0001e240190315d81e820101581de111111111111111111111111111111111111111111111111111111111d9010281581c3333333333333333333333333333333333333333333333333333333380827468747470733a2f2f706f6f6c2e6578616d706c6558204444444444444444444444444444444444444444444444444444444444444444'
  );
  expect(genesisKeyDelegationCertificateHex('66'.repeat(28), '77'.repeat(28), '88'.repeat(32))).toEqual(
    '8405581c66666666666666666666666666666666666666666666666666666666581c7777777777777777777777777777777777777777777777777777777758208888888888888888888888888888888888888888888888888888888888888888'
  );
});

test('creates and reads MIR payloads with exact historical bytes and signed reward values', () => {
  const fixture = {
    certificateHex: `82068200a28200581c${'11'.repeat(28)}1b00200000000000018201581c${'22'.repeat(28)}3829`,
    firstAddress: `e1${'11'.repeat(28)}`,
    secondAddress: `f1${'22'.repeat(28)}`,
  };
  const rewards = {
    [fixture.firstAddress]: '9007199254740993',
    [fixture.secondAddress]: '-42',
  };
  expect(mirCertificatePayloadHex(0, rewards)).toEqual(fixture.certificateHex);
  expect(mirRewardForRewardAddress(fixture.certificateHex, fixture.firstAddress)).toEqual('9007199254740993');
  expect(mirRewardForRewardAddress(fixture.certificateHex, fixture.secondAddress)).toEqual('-42');
});

test('normalizes Shelley and Byron hardware address inputs to their serialized address bytes', () => {
  const cases = [
    {
      address: 'addr1qf2w3pe8jsyvr9kutpv6e0rzuaym7dvq0rrz9699a7y3wwvz6g3gz764vxla692p4ttcekdw0smpedxuqq7a8t8sv3usrcv98z',
      expectedHex:
        '0254e887279408c196dc5859acbc62e749bf358078c622e8a5ef89173982d222817b5561bfdd1541aad78cd9ae7c361cb4dc003dd3acf06479',
    },
    {
      address: 'Ae2tdPwUPEZC6WJfVQxTNN2tWw4skGrN6zRVukvxJmTFy1nYkVGQBuURU3L',
      expectedHex: '82d818582183581c99394e1ca570f79e250651062545898c022145444079d9019b612a51a0001a2ebac743',
    },
  ];
  for (const { address, expectedHex } of cases) {
    expect(normalizeAddressToHex(address)).toEqual(expectedHex);
    expect(normalizeAddressToHex(expectedHex)).toEqual(expectedHex);
  }
  expect(() => normalizeAddressToHex('not-an-address')).toThrow();
});

test('derives canonical enterprise addresses from base and pointer addresses with CML', () => {
  const cases = RustModule.WasmScope(Module => {
    const cml = Module.CML;
    const addressCases = [];
    for (const networkId of [0, 1]) {
      for (const credentialKind of ['key', 'script']) {
        const paymentCredential =
          credentialKind === 'key'
            ? cml.Credential.new_pub_key(cml.Ed25519KeyHash.from_hex('11'.repeat(28)))
            : cml.Credential.new_script(cml.ScriptHash.from_hex('22'.repeat(28)));
        const stakeCredential = cml.Credential.new_pub_key(cml.Ed25519KeyHash.from_hex('33'.repeat(28)));
        const expectedEnterpriseHex = cml.EnterpriseAddress.new(networkId, paymentCredential).to_address().to_hex();
        const baseAddressHex = cml.BaseAddress.new(networkId, paymentCredential, stakeCredential).to_address().to_hex();
        const paymentBytes = credentialKind === 'key' ? new Array(28).fill(0x11) : new Array(28).fill(0x22);
        const pointerType = (credentialKind === 'key' ? 0x40 : 0x50) | networkId;
        const pointerAddressHex = cml.Address.from_raw_bytes(Uint8Array.from([pointerType, ...paymentBytes, 1, 2, 3])).to_hex();

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

test('reads pointer-address coordinates from base-128 varints with CML', () => {
  const vectors = RustModule.WasmScope(Module =>
    [
      { values: ['1', '2', '3'], expected: ['1', '2', '3'] },
      { values: ['128', '16384', '4294967295'], expected: ['128', '16384', '4294967295'] },
    ].map(({ values, expected }) => {
      const bytes = [
        0x41,
        ...new Array(28).fill(0x11),
        ...values.flatMap(value => {
          // eslint-disable-next-line no-undef
          let remaining = BigInt(value);
          const encoded = [Number(remaining & BigInt('0x7f'))];
          remaining >>= BigInt('7');
          while (remaining > BigInt('0')) {
            encoded.unshift(Number(remaining & BigInt('0x7f')) | 0x80);
            remaining >>= BigInt('7');
          }
          return encoded;
        }),
      ];
      const address = Module.CML.Address.from_raw_bytes(Uint8Array.from(bytes)).to_bech32();
      return { address, expected };
    })
  );

  for (const { address, expected } of vectors) {
    expect(stakePointerFromAddressBech32(address)).toEqual(expected);
  }
});

test('decodes pointer address coordinates for both payment credential types', () => {
  const vectors = RustModule.WasmScope(Module => {
    const cml = Module.CML;
    return ['key', 'script'].map(kind => {
      const encoded = ['128', '16384', '4294967295'].flatMap(value => {
        // eslint-disable-next-line no-undef
        let remaining = BigInt(value);
        const result = [Number(remaining & BigInt('0x7f'))];
        remaining >>= BigInt('7');
        while (remaining > BigInt('0')) {
          result.unshift(Number(remaining & BigInt('0x7f')) | 0x80);
          remaining >>= BigInt('7');
        }
        return result;
      });
      const kindByte = kind === 'key' ? 0x40 : 0x50;
      const keyBytes = kind === 'key' ? new Array(28).fill(0x11) : new Array(28).fill(0x22);
      const address = cml.Address.from_raw_bytes(Uint8Array.from([kindByte, ...keyBytes, ...encoded]));
      return {
        addressBech32: address.to_bech32(),
        expected: ['128', '16384', '4294967295'],
      };
    });
  });
  for (const { addressBech32, expected } of vectors) {
    expect(stakePointerFromAddressBech32(addressBech32)).toEqual(expected);
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

test('derives staking public-key bytes with CML', () => {
  const accountPublicKeyHex = RustModule.WasmScope(Module => {
    const cml = Module.CML;
    let root = cml.Bip32PrivateKey.from_bip39_entropy(new Uint8Array(16), new Uint8Array(0));
    for (const index of [1852 + 0x80000000, 1815 + 0x80000000, 0x80000000]) root = root.derive(index);
    return bytesToHex(root.to_public().to_raw_bytes());
  });
  const path = [2, 0];
  const expected = RustModule.WasmScope(Module => {
    const account = Module.CML.Bip32PublicKey.from_raw_bytes(Buffer.from(accountPublicKeyHex, 'hex'));
    const publicKey = account.derive(path[0]).derive(path[1]).to_raw_key();
    return {
      bytes: bytesToHex(publicKey.to_raw_bytes()),
      hash: publicKey.hash().to_hex(),
    };
  });
  expect(deriveBip32PublicKeyRawHex(accountPublicKeyHex, path)).toEqual(expected.bytes);
  expect(deriveBip32PublicKeyHashHex(accountPublicKeyHex, path)).toEqual(expected.hash);
});

test('reconstructs base addresses from payment and stake key hashes', () => {
  const keyHashes = [{ payment: '01'.repeat(28), stake: '02'.repeat(28) }];
  const expectedAddresses = RustModule.WasmScope(Module =>
    keyHashes.map(({ payment, stake }) => {
      const paymentCredential = Module.CML.Credential.new_pub_key(Module.CML.Ed25519KeyHash.from_hex(payment));
      const stakeCredential = Module.CML.Credential.new_pub_key(Module.CML.Ed25519KeyHash.from_hex(stake));
      return Module.CML.BaseAddress.new(1, paymentCredential, stakeCredential).to_address().to_bech32();
    })
  );

  expect(baseAddressesFromKeyHashes(1, keyHashes)).toEqual(expectedAddresses);
});

test('constructs enterprise, base, and reward addresses with CML', () => {
  const payment = '01'.repeat(28);
  const stake = '02'.repeat(28);
  const expected = RustModule.WasmScope(Module => {
    const cml = Module.CML;
    const paymentCredential = cml.Credential.new_pub_key(cml.Ed25519KeyHash.from_hex(payment));
    const stakeCredential = cml.Credential.new_pub_key(cml.Ed25519KeyHash.from_hex(stake));
    return {
      enterpriseAddressHex: cml.EnterpriseAddress.new(1, paymentCredential).to_address().to_hex(),
      baseAddressHex: cml.BaseAddress.new(1, paymentCredential, stakeCredential).to_address().to_hex(),
      rewardAddressHex: cml.RewardAddress.new(1, stakeCredential).to_address().to_hex(),
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
    const rewardAddress = Module.CML.RewardAddress.from_address(Module.CML.Address.from_hex(rewardAddressHex));
    const credential = rewardAddress?.payment();
    return {
      credentialCborHex: credential?.to_cbor_hex(),
      keyHashHex: credential?.as_pub_key()?.to_hex(),
    };
  });

  expect(stakingCredentialCborHexFromRewardAddress(rewardAddressHex)).toEqual(expected.credentialCborHex);
  expect(stakingKeyHashFromRewardAddress(rewardAddressHex)).toEqual(expected.keyHashHex);
  expect(credentialCborHexFromKeyHash(expected.keyHashHex)).toEqual(expected.credentialCborHex);
});

test('matches base-address stake credentials for hex, bech32, and non-base address forms', () => {
  const baseAddress = 'addr1qf2w3pe8jsyvr9kutpv6e0rzuaym7dvq0rrz9699a7y3wwvz6g3gz764vxla692p4ttcekdw0smpedxuqq7a8t8sv3usrcv98z';
  const stakeCredential = RustModule.WasmScope(Module =>
    Module.CML.BaseAddress.from_address(Module.CML.Address.from_bech32(baseAddress))?.stake().to_cbor_hex()
  );
  const baseAddressHex = RustModule.WasmScope(Module => Module.CML.Address.from_bech32(baseAddress).to_hex());

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
    stakeHash: Module.CML.BaseAddress.from_address(Module.CML.Address.from_bech32(baseAddress))?.stake().as_pub_key()?.to_hex(),
    poolId: Module.CML.Ed25519KeyHash.from_hex(poolKeyHash).to_bech32('pool'),
  }));

  expect(stakeCredentialHashFromAddress(baseAddress)).toEqual(expected.stakeHash);
  expect(stakeCredentialHashFromAddress('addr1vahzs6qr0cmmrh64p7jd2qtq2wlgggl5e0enr2my20f44ssv2wfee')).toBeNull();
  expect(poolKeyHashHexToBech32(poolKeyHash)).toEqual(expected.poolId);
});

test('extracts script stake credential hashes from base addresses', () => {
  const scriptHash = 'cd'.repeat(28);
  const scriptAddress = RustModule.WasmScope(Module => {
    const credential = Module.CML.Credential.new_script(Module.CML.ScriptHash.from_hex(scriptHash));
    return Module.CML.BaseAddress.new(1, credential, credential).to_address().to_bech32();
  });
  const expectedScriptHash = RustModule.WasmScope(Module =>
    Module.CML.BaseAddress.from_address(Module.CML.Address.from_bech32(scriptAddress))?.stake().as_script()?.to_hex()
  );

  expect(stakeCredentialHashFromAddress(scriptAddress)).toEqual(expectedScriptHash);
});

test('keeps shared address and reward-address utility output compatible', () => {
  const address = 'addr1qf2w3pe8jsyvr9kutpv6e0rzuaym7dvq0rrz9699a7y3wwvz6g3gz764vxla692p4ttcekdw0smpedxuqq7a8t8sv3usrcv98z';
  const addressHex = RustModule.WasmScope(Module => Module.CML.Address.from_bech32(address).to_hex());
  const stakeKeyHash = '12'.repeat(28);
  const rewardAddressHex = RustModule.WasmScope(Module =>
    Module.CML.RewardAddress.new(1, Module.CML.Credential.new_pub_key(Module.CML.Ed25519KeyHash.from_hex(stakeKeyHash)))
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
    keyCredential: Module.CML.Credential.new_pub_key(Module.CML.Ed25519KeyHash.from_hex(keyHash)).to_cbor_hex(),
    scriptCredential: Module.CML.Credential.new_script(Module.CML.ScriptHash.from_hex(scriptHash)).to_cbor_hex(),
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
    certificates.add(CML.Certificate.new_reg_cert(registrationKey, BigInt('2000000')));
    certificates.add(CML.Certificate.new_stake_delegation(delegationKey, CML.Ed25519KeyHash.from_hex('ef'.repeat(28))));
    certificates.add(CML.Certificate.new_stake_registration(scriptCredential));

    const withdrawals = CML.MapRewardAccountToCoin.new();
    withdrawals.insert(CML.RewardAddress.new(1, withdrawalKey), BigInt('5'));

    const transactionBody = CML.TransactionBody.new(CML.TransactionInputList.new(), CML.TransactionOutputList.new(), BigInt('1'));
    transactionBody.set_certs(certificates);
    transactionBody.set_withdrawals(withdrawals);
    return transactionBody.to_cbor_hex();
  });

  expect(getStakingKeyHashesInTransactionBody(transactionBodyHex)).toEqual(new Set(expectedKeyHashes));
});
