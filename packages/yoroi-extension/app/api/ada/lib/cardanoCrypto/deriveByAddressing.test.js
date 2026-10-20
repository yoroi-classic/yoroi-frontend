// @flow
import '../test-config.forTests';
import { RustModule } from './rustLoader';
import { deriveBip32PrivateKeyBytesByAddressing, derivePrivateKeyBytesByAddressing } from './deriveByAddressing';
import { Bip44DerivationLevels } from '@emurgo/yoroi-lib';

beforeAll(async () => {
  await RustModule.load();
});

test('derives private key bytes with CML matching the legacy Shelley path', () => {
  const privateKeyHex =
    '70afd5ff1f7f551c481b7e3f3541f7c63f5f6bcb293af92565af3deea0bcd6481a6e7b8acbe38f3906c63ccbe8b2d9b876572651ac5d2afc0aca284d9412bb1b4839bf02e1d990056d0f06af22ce4bcca52ac00f1074324aab96bbaaaccf290d';
  const addressing = {
    path: [1852 + 0x80000000, 1815 + 0x80000000, 0x80000000, 0, 7],
    startLevel: Bip44DerivationLevels.PURPOSE.level,
  };
  const expected = RustModule.WasmScope(Module => {
    let derived = Module.WalletV4.Bip32PrivateKey.from_hex(privateKeyHex);
    const firstPathIndex = Bip44DerivationLevels.ACCOUNT.level - addressing.startLevel + 1;
    for (let i = firstPathIndex; i < addressing.path.length; i++) derived = derived.derive(addressing.path[i]);
    return {
      privateBytes: derived.to_raw_key().as_bytes(),
      extendedBytes: Uint8Array.from(Buffer.from(derived.to_hex(), 'hex')),
    };
  });
  expect(
    derivePrivateKeyBytesByAddressing({
      privateKeyHex,
      addressing,
      level: Bip44DerivationLevels.ACCOUNT.level,
    })
  ).toEqual(expected.privateBytes);
  expect(
    deriveBip32PrivateKeyBytesByAddressing({
      privateKeyHex,
      addressing,
      level: Bip44DerivationLevels.ACCOUNT.level,
    })
  ).toEqual(expected.extendedBytes);
});
