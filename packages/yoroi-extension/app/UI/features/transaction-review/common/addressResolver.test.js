// @flow
import '../../../../api/ada/lib/test-config.forTests';
import { RustModule } from '../../../../api/ada/lib/cardanoCrypto/rustLoader';
import { addressHexToBech32, resolveAddress } from './addressResolver';

beforeAll(async () => {
  await RustModule.load();
});

test('classifies a Shelley base address as having a public-key payment credential', () => {
  const address = 'addr1qf2w3pe8jsyvr9kutpv6e0rzuaym7dvq0rrz9699a7y3wwvz6g3gz764vxla692p4ttcekdw0smpedxuqq7a8t8sv3usrcv98z';

  expect(resolveAddress(address)).toEqual({
    resolvedAddress: address,
    paymentCredKind: RustModule.CML.CredentialKind.PubKey,
  });
});

test('converts address hex to bech32 with CML', () => {
  const address = 'addr1qf2w3pe8jsyvr9kutpv6e0rzuaym7dvq0rrz9699a7y3wwvz6g3gz764vxla692p4ttcekdw0smpedxuqq7a8t8sv3usrcv98z';
  const addressHex = RustModule.CML.Address.from_bech32(address).to_hex();

  expect(addressHexToBech32(addressHex)).toEqual(address);
});

test('preserves Byron base58 addresses with CML', () => {
  const address = 'Ae2tdPwUPEZ6ipzynAWN6atmb9LNqEogput2NrMD3Z8UL7phtQLDhrKt1bf';

  expect(resolveAddress(address)).toEqual({
    resolvedAddress: address,
    paymentCredKind: null,
  });
});
