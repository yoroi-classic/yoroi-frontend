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
    const password = 'test-password';
    const plaintext = new Uint8Array([5, 6, 7, 8, 9]);
    const expected = `${'a'.repeat(88)}368047ba94f48d80cb8c39e4debfaadcb5d2c4dd5b`;

    const ciphertext = encryptWithPassword(password, plaintext);
    expect(ciphertext).toBe(expected);
    expect(Array.from(decryptWithPassword(password, ciphertext))).toEqual(Array.from(plaintext));
  });

  it('decrypts a fixed EMIP-3 ciphertext independently of the current encryptor', () => {
    const legacyCiphertext = `${'a'.repeat(88)}368047ba94f48d80cb8c39e4debfaadcb5d2c4dd5b`;

    expect(Array.from(decryptWithPassword('test-password', legacyCiphertext))).toEqual([5, 6, 7, 8, 9]);
  });

  it('maps a failed CML decryption to WrongPassphraseError', () => {
    expect(() => decryptWithPassword('test-password', 'not-hex')).toThrow(WrongPassphraseError);
  });
});
