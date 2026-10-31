// @flow

import { mnemonicToEntropy, entropyToMnemonic } from 'bip39';
// $FlowFixMe[cannot-resolve-module]
import { pbkdf2Sync } from 'pbkdf2';

import { Logger, stringifyError } from '../../../../utils/logging';

import { isValidBip39Mnemonic } from './wallet';
import config from '../../../../config';
import { bytesToHex, hexToBytes } from '../../../../coreUtils';

// <TODO:PENDING_REMOVAL> paper
/** Check validity of paper mnemonic (including checksum) */
export const isValidEnglishAdaPaperMnemonic = (phrase: string, numberOfWords: number): boolean => {
  // Any password will return some valid unscrambled mnemonic
  // so we just pass a fake password to pass downstream validation
  const fakePassword = numberOfWords === config.wallets.YOROI_PAPER_RECOVERY_PHRASE_WORD_COUNT ? 'xxx' : undefined;
  const [unscrambled, unscrambledLen] = unscramblePaperAdaMnemonic(phrase, numberOfWords, fakePassword);
  if (unscrambled != null && unscrambledLen) {
    return isValidBip39Mnemonic(unscrambled, unscrambledLen);
  }
  return false;
};

export function unscramblePaperWalletEntropy(scrambledEntropy: Uint8Array, password: string): Uint8Array {
  const ivSize = 8;
  if (scrambledEntropy.length <= ivSize) throw new Error('Invalid Yoroi paper wallet entropy length');
  const iv = scrambledEntropy.subarray(0, ivSize);
  const payload = scrambledEntropy.subarray(ivSize);
  const mask = pbkdf2Sync(password, iv, 10000, payload.length, 'sha512');
  const plaintext = new Uint8Array(payload.length);
  for (let i = 0; i < payload.length; i++) plaintext[i] = payload[i] ^ mask[i];
  return plaintext;
}

// <TODO:PENDING_REMOVAL> paper
/** Check validity of paper mnemonic (including checksum) */
export const unscramblePaperAdaMnemonic = (phrase: string, numberOfWords: number, password?: string): [?string, number] => {
  const words = phrase.split(' ');
  if (words.length === numberOfWords) {
    if (numberOfWords === config.wallets.YOROI_PAPER_RECOVERY_PHRASE_WORD_COUNT) {
      if (password == null) {
        throw new Error(`Password is expected for a ${config.wallets.YOROI_PAPER_RECOVERY_PHRASE_WORD_COUNT}-word paper!`);
      }
      try {
        const entropy = mnemonicToEntropy(phrase);
        const plaintext = unscramblePaperWalletEntropy(hexToBytes(entropy), password || '');
        const mnemonics = entropyToMnemonic(bytesToHex(plaintext));

        return [mnemonics, config.wallets.WALLET_RECOVERY_PHRASE_WORD_COUNT];
      } catch (e) {
        Logger.error('Failed to unscramble paper mnemonic! ' + stringifyError(e));
        return [undefined, 0];
      }
    }
  }
  return [undefined, 0];
};
