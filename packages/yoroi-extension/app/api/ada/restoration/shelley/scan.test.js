// @flow
import '../../lib/test-config.forTests';
import { RustModule } from '../../lib/cardanoCrypto/rustLoader';
import { genKeyhashBatchFunc } from './scan';
import { discoverAllAddressesFrom } from '../../../common/lib/restoration/bip44AddressScan';
import { getAccountDefaultDerivations } from '../../lib/storage/bridge/walletBuilder/shelley';
import {
  deriveBip32PublicKeyHashHex,
  enterpriseAndBaseAddressHexFromKeyHashes,
  rewardAddressFromKeyHash,
} from '../../lib/cardanoCrypto/cmlAddress';
import { BIP44_SCAN_SIZE, ChainDerivations, STAKING_KEY_INDEX } from '../../../../config/numbersConfig';
import { bytesToHex, hexToBytes } from '../../../../coreUtils';
import { networks } from '../../lib/storage/database/prepackaged/networks';

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

test('restoration batch derivation returns known Shelley payment-hash vectors', () => {
  const accountPublicKey = getAccountPublicKey();
  for (const chain of [0, 1]) {
    const expected = [
      [
        'addr_vkh1plw8sqprmzl8e8ln567upkxnkf3m6rxpy3yvgz2ga7l5ykge7ah',
        'addr_vkh15x72f5wxs6pfteh9vryfjqrnu0q47yralwnxa9ak6attxcwq3d2',
        'addr_vkh19k9sy5ndhn0tztkw8wuns5xtvmr4wrjwjkcaqzs99uwkughqt24',
        'addr_vkh1244smfnwds2taf68whtuh7nuazhgeqszjp07pn4hzea3cjet5n7',
      ],
      [
        'addr_vkh194lt2umysd34lk3jqm7l9dlxp26pmmej5p5qxwue0q3u58j3q63',
        'addr_vkh1xqk74fzs56gga6jwv8pyu90wxfsgavxcad8z7yg9yemwzwphdya',
        'addr_vkh15skg460z6r7j5rmvu283unlr38ca9l8ffqc6krx60w42gq8edzf',
        'addr_vkh1rpvwaszt0lsk4n590gxva03p8e7y23ekkle48uf85gquggwdf58',
      ],
    ][chain];
    expect(genKeyhashBatchFunc(accountPublicKey, chain)([0, 19, 20, 239])).toEqual(expected);
  }
});

test('CML-derived account key matches the known public key vector', () => {
  const keys = RustModule.WasmScope(Module => {
    const CML = Module.CML;
    const cmlRoot = CML.Bip32PrivateKey.from_bip39_entropy(new Uint8Array(16), new Uint8Array(0));
    let cmlAccount = cmlRoot;
    for (const index of [1852 + 0x80000000, 1815 + 0x80000000, 0x80000000]) cmlAccount = cmlAccount.derive(index);
    return {
      publicKeyHex: bytesToHex(cmlAccount.to_public().to_raw_bytes()),
    };
  });
  expect(keys.publicKeyHex).toBe(
    'beb7e770b3d0f1932b0a2f3a63285bf9ef7d3e461d55446d6a3911d8f0ee55c0b0e2df16538508046649d0e6d5b32969555a23f2f1ebf2db2819359b0d88bd16'
  );

  const accountKeyHash = deriveBip32PublicKeyHashHex(keys.publicKeyHex, [ChainDerivations.EXTERNAL, 0]);
  expect(accountKeyHash).toEqual('0fdc780023d8be7c9ff3a6bdc0d8d3b263bd0cc12448c40948efbf42');
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
    networks.CardanoMainnet
  );

  expect(batches).toEqual([
    [1, 2, 3],
    [4, 5, 6],
    [7, 8, 9],
  ]);
  expect(restored.map(({ index }) => index)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  expect(restored.filter(({ isUsed }) => isUsed).map(({ index }) => index)).toEqual([2, 5]);
});

test('CML derives restore addresses with the frozen bytes and network IDs', () => {
  const accountPublicKey = getAccountPublicKey();
  for (const networkId of [0, 1, 42]) {
    const [payment, stake] = RustModule.WasmScope(Module => {
      const account = Module.CML.Bip32PublicKey.from_raw_bytes(hexToBytes(accountPublicKey));
      return [account.derive(0).derive(7).to_raw_key().hash().to_hex(), account.derive(2).derive(0).to_raw_key().hash().to_hex()];
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

  const externalAddress = external?.children?.[0];
  const chimericAddress = chimeric?.children?.[0];
  if (externalAddress == null || chimericAddress == null) throw new Error('Missing default derivation fixtures');
  await externalAddress.insert(({ keyDerivationId: 10 }: any));
  await chimericAddress.insert(({ keyDerivationId: 11 }: any));
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
