// @flow

import '../../../test-config.forTests';
import { RustModule } from '../../../cardanoCrypto/rustLoader';
import {
  addressToDisplayString,
  addressToKind,
  byronAddrToHex,
  getCardanoSpendingKeyHash,
  getAddressPayload,
  normalizeToAddress,
  normalizeToBase58,
  toHexOrBase58,
  toEnterprise,
} from '../utils';
import { CoreAddressTypes } from '../../database/primitives/enums';
import { networks } from '../../database/prepackaged/networks';

test('addressToKind classifies Cardano address forms with bech32 and hex inputs', async () => {
  await RustModule.load();

  const addressCases = [
    [
      'base bech32',
      'addr1qf2w3pe8jsyvr9kutpv6e0rzuaym7dvq0rrz9699a7y3wwvz6g3gz764vxla692p4ttcekdw0smpedxuqq7a8t8sv3usrcv98z',
      'bech32',
      CoreAddressTypes.CARDANO_BASE,
    ],
    ['pointer bech32', 'addr1gf2p2r9xrjq86u2p8sgumrfwu2f4eykahu6zxg60ttc7gnm7ycgqjjeqd8', 'bech32', CoreAddressTypes.CARDANO_PTR],
    [
      'enterprise bech32',
      'addr1vahzs6qr0cmmrh64p7jd2qtq2wlgggl5e0enr2my20f44ssv2wfee',
      'bech32',
      CoreAddressTypes.CARDANO_ENTERPRISE,
    ],
    ['reward bech32', 'stake1az0vrvznk3xya3c7l0fqp6qwkth5emmc37vyaevydah3r0cv6gnpm', 'bech32', CoreAddressTypes.CARDANO_REWARD],
    [
      'base hex',
      '0254e887279408c196dc5859acbc62e749bf358078c622e8a5ef89173982d222817b5561bfdd1541aad78cd9ae7c361cb4dc003dd3acf06479',
      'bytes',
      CoreAddressTypes.CARDANO_BASE,
    ],
    ['pointer hex', '4254150ca61c807d71413c11cd8d2ee2935c92ddbf3423234f5af1e44f7e2610', 'bytes', CoreAddressTypes.CARDANO_PTR],
    [
      'enterprise hex',
      '676e2868037e37b1df550fa4d5016053be8423f4cbf331ab6453d35ac2',
      'bytes',
      CoreAddressTypes.CARDANO_ENTERPRISE,
    ],
    ['reward hex', 'e89ec1b053b44c4ec71efbd200e80eb2ef4cef788f984ee5846f6f11bf', 'bytes', CoreAddressTypes.CARDANO_REWARD],
    ['legacy base58', 'Ae2tdPwUPEZC6WJfVQxTNN2tWw4skGrN6zRVukvxJmTFy1nYkVGQBuURU3L', 'bech32', CoreAddressTypes.CARDANO_LEGACY],
    [
      'legacy hex',
      '82d818582183581c99394e1ca570f79e250651062545898c022145444079d9019b612a51a0001a2ebac743',
      'bytes',
      CoreAddressTypes.CARDANO_LEGACY,
    ],
  ];

  for (const [, address, parseAs, expectedKind] of addressCases) {
    expect(addressToKind(address, parseAs, networks.CardanoMainnet)).toBe(expectedKind);
  }
});

test('extracts key-controlled payment hashes from bech32 addresses using CML-compatible bytes', async () => {
  await RustModule.load();
  const addresses = [
    'addr1qf2w3pe8jsyvr9kutpv6e0rzuaym7dvq0rrz9699a7y3wwvz6g3gz764vxla692p4ttcekdw0smpedxuqq7a8t8sv3usrcv98z',
    'addr1gf2p2r9xrjq86u2p8sgumrfwu2f4eykahu6zxg60ttc7gnm7ycgqjjeqd8',
    'addr1vahzs6qr0cmmrh64p7jd2qtq2wlgggl5e0enr2my20f44ssv2wfee',
    'stake1az0vrvznk3xya3c7l0fqp6qwkth5emmc37vyaevydah3r0cv6gnpm',
  ];
  const expected = RustModule.WasmScope(Module =>
    addresses.map(address => {
      const cslAddress = Module.WalletV4.Address.from_bech32(address);
      const keyHash =
        Module.WalletV4.BaseAddress.from_address(cslAddress)?.payment_cred().to_keyhash() ??
        Module.WalletV4.PointerAddress.from_address(cslAddress)?.payment_cred().to_keyhash() ??
        Module.WalletV4.EnterpriseAddress.from_address(cslAddress)?.payment_cred().to_keyhash() ??
        Module.WalletV4.RewardAddress.from_address(cslAddress)?.payment_cred().to_keyhash();
      return keyHash?.to_hex() ?? null;
    })
  );

  expect(addresses.map(getCardanoSpendingKeyHash)).toEqual(expected);
  expect(getCardanoSpendingKeyHash('Ae2tdPwUPEZC6WJfVQxTNN2tWw4skGrN6zRVukvxJmTFy1nYkVGQBuURU3L')).toBeNull();
});

test('derives enterprise address bytes from key-controlled address forms with CML', async () => {
  await RustModule.load();
  const addressHexes = [
    '0254e887279408c196dc5859acbc62e749bf358078c622e8a5ef89173982d222817b5561bfdd1541aad78cd9ae7c361cb4dc003dd3acf06479',
    '4254150ca61c807d71413c11cd8d2ee2935c92ddbf3423234f5af1e44f7e2610',
    '676e2868037e37b1df550fa4d5016053be8423f4cbf331ab6453d35ac2',
    'e89ec1b053b44c4ec71efbd200e80eb2ef4cef788f984ee5846f6f11bf',
  ];
  const expected = RustModule.WasmScope(Module =>
    addressHexes.map(addressHex => {
      const address = Module.WalletV4.Address.from_hex(addressHex);
      const keyHash =
        Module.WalletV4.BaseAddress.from_address(address)?.payment_cred().to_keyhash() ??
        Module.WalletV4.PointerAddress.from_address(address)?.payment_cred().to_keyhash() ??
        Module.WalletV4.EnterpriseAddress.from_address(address)?.payment_cred().to_keyhash() ??
        Module.WalletV4.RewardAddress.from_address(address)?.payment_cred().to_keyhash();
      if (keyHash == null) return undefined;
      return Module.WalletV4.EnterpriseAddress.new(
        address.network_id(),
        Module.WalletV4.Credential.from_keyhash(keyHash)
      ).to_address().to_hex();
    })
  );

  expect(addressHexes.map(toEnterprise)).toEqual(expected);
});

test('uses CML for Byron and Shelley string address conversions', async () => {
  await RustModule.load();

  const legacyBase58 = 'Ae2tdPwUPEZC6WJfVQxTNN2tWw4skGrN6zRVukvxJmTFy1nYkVGQBuURU3L';
  const legacyHex = '82d818582183581c99394e1ca570f79e250651062545898c022145444079d9019b612a51a0001a2ebac743';
  const baseAddressBech32 =
    'addr1qf2w3pe8jsyvr9kutpv6e0rzuaym7dvq0rrz9699a7y3wwvz6g3gz764vxla692p4ttcekdw0smpedxuqq7a8t8sv3usrcv98z';
  const baseAddressHex =
    '0254e887279408c196dc5859acbc62e749bf358078c622e8a5ef89173982d222817b5561bfdd1541aad78cd9ae7c361cb4dc003dd3acf06479';

  expect(byronAddrToHex(legacyBase58)).toBe(legacyHex);
  expect(normalizeToBase58(legacyBase58)).toBe(legacyBase58);
  expect(normalizeToBase58(legacyHex)).toBe(legacyBase58);
  expect(normalizeToBase58(baseAddressBech32)).toBeUndefined();
  expect(addressToDisplayString(baseAddressHex, networks.CardanoMainnet)).toBe(baseAddressBech32);
  expect(addressToDisplayString(legacyHex, networks.CardanoMainnet)).toBe(legacyBase58);
  expect(getAddressPayload(baseAddressBech32, networks.CardanoMainnet)).toBe(baseAddressHex);
  expect(getAddressPayload(legacyBase58, networks.CardanoMainnet)).toBe(legacyBase58);
  expect(normalizeToAddress(baseAddressBech32)).toBe(baseAddressHex);
  expect(normalizeToAddress(legacyBase58)).toBe(legacyHex);
  expect(toHexOrBase58(legacyHex)).toBe(legacyBase58);
  expect(toHexOrBase58(baseAddressHex)).toBe(baseAddressHex);
  expect(normalizeToAddress('not-an-address')).toBeUndefined();
});

test('normalizeToAddress parses ByronAddress', async done => {
  await RustModule.load();
  const address = 'Ae2tdPwUPEZC6WJfVQxTNN2tWw4skGrN6zRVukvxJmTFy1nYkVGQBuURU3L';
  const normalizedAddress = await normalizeToAddress(address);
  expect(normalizedAddress).toBeTruthy();
  done();
});

test('normalizeToAddress parses hex ByronAddress', async done => {
  await RustModule.load();
  const address = '82d818582183581c99394e1ca570f79e250651062545898c022145444079d9019b612a51a0001a2ebac743';
  const normalizedAddress = await normalizeToAddress(address);
  expect(normalizedAddress).toBeTruthy();
  done();
});

const addresses = [
  // base bech32
  'addr1qf2w3pe8jsyvr9kutpv6e0rzuaym7dvq0rrz9699a7y3wwvz6g3gz764vxla692p4ttcekdw0smpedxuqq7a8t8sv3usrcv98z',
  'addr1r5hqjwrsjft2ymrhndv035t37phwxk3vx6pncg5zse49c0qyl2ujq0luhv7cu0ymw4xenqk764axpx358e34ahq47k4q9hx7l5',
  'addr19ksy5jlqsp270e9ssyz6a5e4as33mmge452rq4kr5r88629tel0tvrnqds8k4ewexe886peqfhkvlwdgruusfru0q64srq5hnq',
  'addr187p3td2htr3jg7v62k6pghtzu9zp2j0ecjzgam5jpj8mjretkxk82ddu6gjqanx5mx0xnupxu8mrwaqjm5c0ll0g25qscl9pzl',
  // base hex
  '0254e887279408c196dc5859acbc62e749bf358078c622e8a5ef89173982d222817b5561bfdd1541aad78cd9ae7c361cb4dc003dd3acf06479',
  '1d2e0938709256a26c779b58f8d171f06ee35a2c36833c2282866a5c3c04fab9203ffcbb3d8e3c9b754d9982ded57a609a343e635edc15f5aa',
  '2da04a4be08055e7e4b08105aed335ec231ded19ad143056c3a0ce7d28abcfdeb60e606c0f6ae5d9364e7d07204deccfb9a81f39048f8f06ab',
  '3f8315b55758e324799a55b4145d62e1441549f9c4848eee920c8fb90f2bb1ac7535bcd2240eccd4d99e69f026e1f6377412dd30fffde85501',

  // pointer bech32
  'addr1gf2p2r9xrjq86u2p8sgumrfwu2f4eykahu6zxg60ttc7gnm7ycgqjjeqd8',
  'addr1t6efpm47hln0cfrzm33nen3z4tzzd9tl755xjcpe0e09ffcqqqqqkf5rpd',
  // pointer hex
  '4254150ca61c807d71413c11cd8d2ee2935c92ddbf3423234f5af1e44f7e2610',
  '5eb290eebebfe6fc2462dc633cce22aac426957ff5286960397e5e54a7000000',

  // enterprise bech32
  'addr1vahzs6qr0cmmrh64p7jd2qtq2wlgggl5e0enr2my20f44ssv2wfee',
  'addr10m9q5shafn5xzm6tgcpe28pea0kmksydctm6dfv6zseaqusmp48xt',
  // enterprise hex
  '676e2868037e37b1df550fa4d5016053be8423f4cbf331ab6453d35ac2',
  '7eca0a42fd4ce8616f4b4603951c39ebedbb408dc2f7a6a59a1433d072',

  // reward bech32,
  'stake1az0vrvznk3xya3c7l0fqp6qwkth5emmc37vyaevydah3r0cv6gnpm',
  'stake17549cufdznnkpy8c69z8utt8684403xmm8k4zamnncgpclcdpynl8',
  // reward hex
  'e89ec1b053b44c4ec71efbd200e80eb2ef4cef788f984ee5846f6f11bf',
  'f52a5c712d14e76090f8d1447e2d67d1eb57c4dbd9ed5177739e101c7f',
];

for (const address of addresses) {
  test(`normalizeToAddress parses ${address}`, async done => {
    await RustModule.load();
    const normalizedAddress = await normalizeToAddress(address);
    expect(normalizedAddress).toBeTruthy();
    done();
  });
}
