// @flow
import '../test-config.forTests';
import { RustModule } from './rustLoader';
import { deriveBip32PrivateKeyBytesByAddressing, derivePrivateKeyBytesByAddressing } from './deriveByAddressing';
import { Bip44DerivationLevels } from '../storage/database/walletTypes/bip44/api/utils';

beforeAll(async () => {
  await RustModule.load();
});

test('derives known private key bytes for the supplied addressing path', () => {
  const privateKeyHex =
    '70afd5ff1f7f551c481b7e3f3541f7c63f5f6bcb293af92565af3deea0bcd6481a6e7b8acbe38f3906c63ccbe8b2d9b876572651ac5d2afc0aca284d9412bb1b4839bf02e1d990056d0f06af22ce4bcca52ac00f1074324aab96bbaaaccf290d';
  const addressing = {
    path: [1852 + 0x80000000, 1815 + 0x80000000, 0x80000000, 0, 7],
    startLevel: Bip44DerivationLevels.PURPOSE.level,
  };
  const expectedPrivateBytes = Buffer.from(
    '90a86d391f667e61d59b8b4c3c68254e1b203febe018aef83694290ca9bcd6489d43c7fc0b9665a2444eb6e5d4532c8b893041c0d8124693c2cea7ad55aa6cdf',
    'hex'
  );
  const expectedExtendedBytes = Buffer.from(
    '90a86d391f667e61d59b8b4c3c68254e1b203febe018aef83694290ca9bcd6489d43c7fc0b9665a2444eb6e5d4532c8b893041c0d8124693c2cea7ad55aa6cdf248e98147e3173b267826fd53dd47f107037b94174daa91b66d824404f1c72f8',
    'hex'
  );
  expect(
    derivePrivateKeyBytesByAddressing({
      privateKeyHex,
      addressing,
      level: Bip44DerivationLevels.ACCOUNT.level,
    })
  ).toEqual(new Uint8Array(expectedPrivateBytes));
  expect(
    deriveBip32PrivateKeyBytesByAddressing({
      privateKeyHex,
      addressing,
      level: Bip44DerivationLevels.ACCOUNT.level,
    })
  ).toEqual(new Uint8Array(expectedExtendedBytes));
});
