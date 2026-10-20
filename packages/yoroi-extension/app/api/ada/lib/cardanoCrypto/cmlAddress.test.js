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
    const CSL = Module.WalletV4;
    return ['key', 'script'].map(kind => {
      const payment = kind === 'key'
        ? CSL.Credential.from_keyhash(CSL.Ed25519KeyHash.from_hex('11'.repeat(28)))
        : CSL.Credential.from_scripthash(CSL.ScriptHash.from_hex('22'.repeat(28)));
      const address = CSL.EnterpriseAddress.new(1, payment).to_address().to_hex();
      const keyHash = payment.to_keyhash();
      return { address, expected: keyHash?.to_bech32('addr_vkh') ?? null };
    });
  });

  for (const { address, expected } of vectors) {
    expect(paymentKeyHashBech32FromEnterpriseAddress(address, 'addr_vkh')).toEqual(expected);
  }
  expect(() => paymentKeyHashBech32FromEnterpriseAddress('not-an-address', 'addr_vkh')).toThrow();
});

test('creates DB certificate payload bytes matching the historical CSL encodings', () => {
  const vectors = RustModule.WasmScope(Module => {
    const CSL = Module.WalletV4;
    const CML = Module.CML;
    const credential = CSL.Credential.from_keyhash(CSL.Ed25519KeyHash.from_hex('11'.repeat(28)));
    const poolHash = '22'.repeat(28);
    const stake = CSL.StakeRegistration.new(credential).to_hex();
    const delegation = CSL.StakeDelegation.new(credential, CSL.Ed25519KeyHash.from_hex(poolHash)).to_hex();
    const retirement = CSL.PoolRetirement.new(CSL.Ed25519KeyHash.from_hex(poolHash), 42).to_hex();
    const cmlCredential = CML.Credential.from_cbor_hex(credential.to_hex());
    const cmlPoolHash = CML.Ed25519KeyHash.from_hex(poolHash);
    // eslint-disable-next-line no-undef
    const cmlEpoch = BigInt(42);
    return {
      stake,
      cmlStake: CML.Certificate.new_stake_registration(cmlCredential).to_cbor_hex(),
      delegation,
      cmlDelegation: CML.Certificate.new_stake_delegation(cmlCredential, cmlPoolHash).to_cbor_hex(),
      retirement,
      cmlRetirement: CML.Certificate.new_pool_retirement(cmlPoolHash, cmlEpoch).to_cbor_hex(),
    };
  });
  expect(vectors.cmlStake).toEqual(vectors.stake);
  expect(vectors.cmlDelegation).toEqual(vectors.delegation);
  expect(vectors.cmlRetirement).toEqual(vectors.retirement);
});

test('creates pool registration and genesis delegation payloads with historical CSL bytes', () => {
  const expected = RustModule.WasmScope(Module => {
    const CSL = Module.WalletV4;
    const rewardCredential = CSL.Credential.from_keyhash(CSL.Ed25519KeyHash.from_hex('11'.repeat(28)));
    const rewardAccount = CSL.RewardAddress.new(1, rewardCredential);
    const operator = CSL.Ed25519KeyHash.from_hex('22'.repeat(28));
    const owners = CSL.Ed25519KeyHashes.new();
    owners.add(CSL.Ed25519KeyHash.from_hex('33'.repeat(28)));
    const metadata = CSL.PoolMetadata.new(CSL.URL.new('https://pool.example'), CSL.PoolMetadataHash.from_hex('44'.repeat(32)));
    const pool = CSL.PoolParams.new(
      operator,
      CSL.VRFKeyHash.from_hex('55'.repeat(32)),
      CSL.BigNum.from_str('123456'),
      CSL.BigNum.from_str('789'),
      CSL.UnitInterval.new(CSL.BigNum.from_str('1'), CSL.BigNum.from_str('1')),
      rewardAccount,
      owners,
      CSL.Relays.new(),
      metadata
    );
    const poolRegistration = CSL.PoolRegistration.new(pool).to_hex();
    const genesis = CSL.GenesisKeyDelegation.new(
      CSL.GenesisHash.from_hex('66'.repeat(28)),
      CSL.GenesisDelegateHash.from_hex('77'.repeat(28)),
      CSL.VRFKeyHash.from_hex('88'.repeat(32))
    ).to_hex();
    return { poolRegistration, genesis };
  });

  const rewardAddressHex = RustModule.WasmScope(Module => {
    const CSL = Module.WalletV4;
    return CSL.RewardAddress.new(1, CSL.Credential.from_keyhash(CSL.Ed25519KeyHash.from_hex('11'.repeat(28))))
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
  expect(pool.certificateHex).toEqual(expected.poolRegistration);
  expect(genesisKeyDelegationCertificateHex('66'.repeat(28), '77'.repeat(28), '88'.repeat(32))).toEqual(expected.genesis);
});

test('creates and reads MIR payloads with exact historical bytes and signed reward values', () => {
  const fixture = RustModule.WasmScope(Module => {
    const CSL = Module.WalletV4;
    const firstCredential = CSL.Credential.from_keyhash(CSL.Ed25519KeyHash.from_hex('11'.repeat(28)));
    const secondCredential = CSL.Credential.from_scripthash(CSL.ScriptHash.from_hex('22'.repeat(28)));
    const amounts = CSL.MIRToStakeCredentials.new();
    amounts.insert(firstCredential, CSL.Int.new(CSL.BigNum.from_str('9007199254740993')));
    amounts.insert(secondCredential, CSL.Int.new_negative(CSL.BigNum.from_str('42')));
    const certificateHex = CSL.MoveInstantaneousRewardsCert.new(
      CSL.MoveInstantaneousReward.new_to_stake_creds(CSL.MIRPot.Reserves, amounts)
    ).to_hex();
    return {
      certificateHex,
      firstAddress: CSL.RewardAddress.new(1, firstCredential).to_address().to_hex(),
      secondAddress: CSL.RewardAddress.new(1, secondCredential).to_address().to_hex(),
    };
  });
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
      expectedHex: '0254e887279408c196dc5859acbc62e749bf358078c622e8a5ef89173982d222817b5561bfdd1541aad78cd9ae7c361cb4dc003dd3acf06479',
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

test('reads pointer-address coordinates from base-128 varints with CML', () => {
  const vectors = RustModule.WasmScope(Module =>
    [
      { values: ['1', '2', '3'], expected: ['1', '2', '3'] },
      { values: ['128', '16384', '4294967295'], expected: ['128', '16384', '4294967295'] },
    ].map(({ values, expected }) => {
      const bytes = [0x41, ...new Array(28).fill(0x11), ...values.flatMap(value => {
        // eslint-disable-next-line no-undef
        let remaining = BigInt(value);
        const encoded = [Number(remaining & 0x7fn)];
        remaining >>= 7n;
        while (remaining > 0n) {
          encoded.unshift(Number(remaining & 0x7fn) | 0x80);
          remaining >>= 7n;
        }
        return encoded;
      })];
      const address = Module.CML.Address.from_raw_bytes(Uint8Array.from(bytes)).to_bech32();
      return { address, expected };
    })
  );

  for (const { address, expected } of vectors) {
    expect(stakePointerFromAddressBech32(address)).toEqual(expected);
  }
});

test('decodes CSL pointer address coordinates for both payment credential types', () => {
  const vectors = RustModule.WasmScope(Module => {
    const CSL = Module.WalletV4;
    return ['key', 'script'].map(kind => {
      const payment =
        kind === 'key'
          ? CSL.Credential.from_keyhash(CSL.Ed25519KeyHash.from_hex('11'.repeat(28)))
          : CSL.Credential.from_scripthash(CSL.ScriptHash.from_hex('22'.repeat(28)));
      const pointer = CSL.Pointer.new(CSL.BigNum.from_str('128'), CSL.BigNum.from_str('16384'), CSL.BigNum.from_str('4294967295'));
      const address = CSL.PointerAddress.new(0, payment, pointer).to_address();
      return {
        addressBech32: address.to_bech32(),
        expected: [String(pointer.slot()), String(pointer.tx_index()), String(pointer.cert_index())],
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

test('derives staking public-key bytes with CML matching CSL', () => {
  const accountPublicKeyHex = RustModule.WasmScope(Module => {
    const CSL = Module.WalletV4;
    let root = CSL.Bip32PrivateKey.from_bip39_entropy(new Uint8Array(16), new Uint8Array(0));
    for (const index of [1852 + 0x80000000, 1815 + 0x80000000, 0x80000000]) root = root.derive(index);
    return root.to_public().to_hex();
  });
  const path = [2, 0];
  const expected = RustModule.WasmScope(Module => {
    const account = Module.WalletV4.Bip32PublicKey.from_hex(accountPublicKeyHex);
    const publicKey = account.derive(path[0]).derive(path[1]).to_raw_key();
    return {
      bytes: Buffer.from(publicKey.as_bytes()).toString('hex'),
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
