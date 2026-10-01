// @flow
import '../test-config.forTests';
import { RustModule } from './rustLoader';
import { addressBech32ToHex, addressHexToBech32, deriveRewardAddressFromAddress } from './cmlAddress';

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
