// @flow

import '../api/ada/lib/test-config.forTests';
import { RustModule } from '../api/ada/lib/cardanoCrypto/rustLoader';
import { WrongPassphraseError } from '../api/ada/lib/cardanoCrypto/cryptoErrors';
import { decryptWithPassword, encryptWithPassword } from './passwordCipher';

jest.mock('crypto-random-string', () => jest.fn(({ length }) => 'a'.repeat(length)));

describe('passwordCipher', () => {
  beforeAll(async () => {
    await RustModule.load();
  });

  it('preserves the EMIP-3 ciphertext format and decrypts it', () => {
    const password = new Uint8Array([1, 2, 3, 4]);
    const plaintext = new Uint8Array([5, 6, 7, 8, 9]);
    const expected = `${'a'.repeat(88)}ec270a8bf701c2ca038a30a8b2f85b348ab4e10cb9`;

    const ciphertext = encryptWithPassword(password, plaintext);
    expect(ciphertext).toBe(expected);
    expect(Array.from(decryptWithPassword(password, ciphertext))).toEqual(Array.from(plaintext));
  });

  it('maps a failed CML decryption to WrongPassphraseError', () => {
    expect(() => decryptWithPassword(new Uint8Array([1]), 'not-hex')).toThrow(WrongPassphraseError);
  });
});
