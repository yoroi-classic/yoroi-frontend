// @flow
import '../../api/ada/lib/test-config.forTests';
import { RustModule } from '../../api/ada/lib/cardanoCrypto/rustLoader';
import { authSignHexPayload } from './index';

beforeAll(async () => {
  await RustModule.load();
});

test('connector payload signature from CML matches CSL', async () => {
  const privateKeyHex = '01'.repeat(64);
  const payloadHex = 'a1b2c3d4';
  const expected = RustModule.WalletV4.PrivateKey.from_extended_bytes(Buffer.from(privateKeyHex, 'hex'))
    .sign(Buffer.from(payloadHex, 'hex'))
    .to_hex();
  await expect(authSignHexPayload({ privKey: privateKeyHex, payloadHex })).resolves.toEqual(expected);
});
