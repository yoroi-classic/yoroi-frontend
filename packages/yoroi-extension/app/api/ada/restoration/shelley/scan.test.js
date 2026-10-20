// @flow
import '../../lib/test-config.forTests';
import { RustModule } from '../../lib/cardanoCrypto/rustLoader';
import { genKeyhashBatchFunc } from './scan';
import { discoverAllAddressesFrom } from '../../../common/lib/restoration/bip44AddressScan';
import { getAccountDefaultDerivations } from '../../lib/storage/bridge/walletBuilder/shelley';
import { deriveBip32PublicKeyHashHex, enterpriseAndBaseAddressHexFromKeyHashes, rewardAddressFromKeyHash } from '../../lib/cardanoCrypto/cmlAddress';
import { BIP44_SCAN_SIZE, ChainDerivations, STAKING_KEY_INDEX } from '../../../../config/numbersConfig';
import { bytesToHex, hexToBytes } from '../../../../coreUtils';

beforeAll(async () => {
  await RustModule.load();
});

function getAccountPublicKey(): string {
  return RustModule.WasmScope(Module => {
    const CML = Module.CML;
    let root = CML.Bip32PrivateKey.from_bip39_entropy(new Uint8Array(16), new Uint8Array(0));
    for (const index of [1852 + 0x80000000, 1815 + 0x80000000, 0x80000000]) root = root.derive(index);
    return bytesToHex(root.to_public().to_raw_bytes());
  });
}

test('CML restoration batch derivation matches Shelley payment hashes for gap and recovery indices', () => {
  const accountPublicKey = getAccountPublicKey();
  for (const chain of [0, 1]) {
    const expected = RustModule.WasmScope(Module => {
      const CML = Module.CML;
      const account = CML.Bip32PublicKey.from_raw_bytes(hexToBytes(accountPublicKey));
      const addressChain = account.derive(chain);
      return [0, 19, 20, 239].map(index => addressChain.derive(index).to_raw_key().hash().to_bech32('addr_vkh'));
    });
    expect(genKeyhashBatchFunc(accountPublicKey, chain)([0, 19, 20, 239])).toEqual(expected);
  }
});

test('CML standard and imported hardware account keys preserve the public derivation contract', () => {
  const keys = RustModule.WasmScope(Module => {
    const CML = Module.CML;
    const cmlRoot = CML.Bip32PrivateKey.from_bip39_entropy(new Uint8Array(16), new Uint8Array(0));
    let cmlAccount = cmlRoot;
    for (const index of [1852 + 0x80000000, 1815 + 0x80000000, 0x80000000]) cmlAccount = cmlAccount.derive(index);
    return {
      expected: bytesToHex(cmlAccount.to_public().to_raw_bytes()),
      cmlAccountHex: bytesToHex(cmlAccount.to_public().to_raw_bytes()),
    };
  });
  expect(keys.cmlAccountHex).toEqual(keys.expected);

  const importedHardwareAccountKey = RustModule.WasmScope(Module =>
    bytesToHex(Module.CML.Bip32PublicKey.from_raw_bytes(hexToBytes(keys.expected)).to_raw_bytes())
  );
  expect(importedHardwareAccountKey).toEqual(keys.expected);
  const accountKeyHashes = [keys.expected, importedHardwareAccountKey].map(accountKey =>
    deriveBip32PublicKeyHashHex(accountKey, [ChainDerivations.EXTERNAL, 0])
  );
  expect(accountKeyHashes[0]).toEqual(accountKeyHashes[1]);
});

test('CML restoration scanning preserves batched gap-limit expansion and default address reserve', async () => {
  const accountPublicKey = getAccountPublicKey();
  const generateAddresses = genKeyhashBatchFunc(accountPublicKey, 0);
  const usedAddresses = new Set(generateAddresses([2, 5]));
  const batches = [];
  const restored = await discoverAllAddressesFrom(
    indices => {
      batches.push(indices);
      return generateAddresses(indices);
    },
    0,
    3,
    3,
    async ({ addresses }) => addresses.filter(address => usedAddresses.has(address)),
    {}
  );

  expect(batches).toEqual([[1, 2, 3], [4, 5, 6], [7, 8, 9]]);
  expect(restored.map(({ index }) => index)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  expect(restored.filter(({ isUsed }) => isUsed).map(({ index }) => index)).toEqual([2, 5]);
});

test('CML derives restore addresses with the frozen bytes and network IDs', () => {
  const accountPublicKey = getAccountPublicKey();
  for (const networkId of [0, 1, 42]) {
    const [payment, stake] = RustModule.WasmScope(Module => {
      const account = Module.CML.Bip32PublicKey.from_raw_bytes(hexToBytes(accountPublicKey));
      return [
        account.derive(0).derive(7).to_raw_key().hash().to_hex(),
        account.derive(2).derive(0).to_raw_key().hash().to_hex(),
      ];
    });
    const paymentHash = deriveBip32PublicKeyHashHex(accountPublicKey, [0, 7]);
    const stakingHash = deriveBip32PublicKeyHashHex(accountPublicKey, [2, 0]);
    expect(paymentHash).toEqual(payment);
    expect(stakingHash).toEqual(stake);

    const actual = enterpriseAndBaseAddressHexFromKeyHashes(networkId, paymentHash, stakingHash);
    const rewardAddress = rewardAddressFromKeyHash(networkId, stakingHash);
    const expected = RustModule.WasmScope(Module => {
      const CML = Module.CML;
      const paymentCredential = CML.Credential.new_pub_key(CML.Ed25519KeyHash.from_hex(payment));
      const stakeCredential = CML.Credential.new_pub_key(CML.Ed25519KeyHash.from_hex(stake));
      return {
        enterpriseAddressHex: CML.EnterpriseAddress.new(networkId, paymentCredential).to_address().to_hex(),
        baseAddressHex: CML.BaseAddress.new(networkId, paymentCredential, stakeCredential).to_address().to_hex(),
        rewardAddressHex: CML.RewardAddress.new(networkId, stakeCredential).to_address().to_hex(),
      };
    });
    expect(actual).toEqual({ enterpriseAddressHex: expected.enterpriseAddressHex, baseAddressHex: expected.baseAddressHex });
    expect(rewardAddress).toEqual(expected.rewardAddressHex);
  }
});

test('default Shelley derivations retain the BIP44 gap reserve and exact initial addresses', async () => {
  const accountPublicKeyHex = RustModule.WasmScope(Module => {
    const CML = Module.CML;
    let root = CML.Bip32PrivateKey.from_bip39_entropy(new Uint8Array(16), new Uint8Array(0));
    for (const index of [1852 + 0x80000000, 1815 + 0x80000000, 0x80000000]) root = root.derive(index);
    return bytesToHex(root.to_public().to_raw_bytes());
  });
  const inserted = [];
  const accountPublicKey = RustModule.CML.Bip32PublicKey.from_raw_bytes(hexToBytes(accountPublicKeyHex));
  const tree = await getAccountDefaultDerivations(1, accountPublicKey, async address => {
    inserted.push(address);
  });
  const external = tree.find(({ index }) => index === ChainDerivations.EXTERNAL);
  const internal = tree.find(({ index }) => index === ChainDerivations.INTERNAL);
  const chimeric = tree.find(({ index }) => index === ChainDerivations.CHIMERIC_ACCOUNT);
  expect(external?.children).toHaveLength(BIP44_SCAN_SIZE);
  expect(internal?.children).toHaveLength(BIP44_SCAN_SIZE);
  expect(chimeric?.children).toHaveLength(1);

  await external?.children?.[0].insert({ keyDerivationId: 10 });
  await chimeric?.children?.[0].insert({ keyDerivationId: 11 });
  const expected = RustModule.WasmScope(Module => {
    const CML = Module.CML;
    const account = CML.Bip32PublicKey.from_raw_bytes(hexToBytes(accountPublicKeyHex));
    const stakeKeyHash = account.derive(ChainDerivations.CHIMERIC_ACCOUNT).derive(STAKING_KEY_INDEX).to_raw_key().hash();
    const paymentKeyHash = account.derive(ChainDerivations.EXTERNAL).derive(0).to_raw_key().hash();
    const paymentCredential = CML.Credential.new_pub_key(paymentKeyHash);
    const stakeCredential = CML.Credential.new_pub_key(stakeKeyHash);
    return [
      CML.EnterpriseAddress.new(1, paymentCredential).to_address().to_hex(),
      CML.BaseAddress.new(1, paymentCredential, stakeCredential).to_address().to_hex(),
      CML.RewardAddress.new(1, stakeCredential).to_address().to_hex(),
    ];
  });
  expect(inserted.map(({ address }) => address.data)).toEqual([expected[0], expected[1], expected[2]]);
});
