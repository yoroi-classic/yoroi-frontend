// @flow

import '../api/ada/lib/test-config.forTests';
import { RustModule } from '../api/ada/lib/cardanoCrypto/rustLoader';
import { WrongPassphraseError } from '../api/ada/lib/cardanoCrypto/cryptoErrors';
import { bytesToHex } from '../coreUtils';
import { decryptWithPassword, encryptWithPassword } from './passwordCipher';

jest.mock('crypto-random-string', () => jest.fn(({ length }) => 'a'.repeat(length)));

describe('passwordCipher', () => {
  beforeAll(async () => {
    await RustModule.load();
  });

  it('uses the same EMIP-3 ciphertext as CSL and decrypts it with CML', () => {
    const password = new Uint8Array([1, 2, 3, 4]);
    const plaintext = new Uint8Array([5, 6, 7, 8, 9]);
    const passwordHex = bytesToHex(password);
    const plaintextHex = bytesToHex(plaintext);
    const salt = 'a'.repeat(64);
    const nonce = 'a'.repeat(24);
    const expected = RustModule.WasmScope(Module =>
      Module.WalletV4.encrypt_with_password(passwordHex, salt, nonce, plaintextHex)
    );

    const ciphertext = encryptWithPassword(password, plaintext);
    expect(ciphertext).toBe(expected);
    expect(Array.from(decryptWithPassword(password, ciphertext))).toEqual(Array.from(plaintext));
  });

  it('maps a failed CML decryption to WrongPassphraseError', () => {
    expect(() => decryptWithPassword(new Uint8Array([1]), 'not-hex')).toThrow(WrongPassphraseError);
  });
});
