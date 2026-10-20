// @flow

import { RustModule } from './rustLoader';
import '../test-config.forTests';
import {
  transactionBodyHexToTransaction,
  transactionHexAddSignaturesFromWitnessSetHex,
  transactionHexReplaceWitnessSet,
  transactionHexToBodyHex,
  transactionHexToHash,
  transactionHexToWitnessSet,
} from './utils';

describe('CML transaction serialization helpers', () => {
  beforeAll(async () => {
    await RustModule.load();
  });

  function createEmptyTransaction(): {| txHex: string, bodyHex: string, witnessSetHex: string |} {
    return RustModule.WasmScope(Module => {
      const body = Module.CML.TransactionBody.new(
        Module.CML.TransactionInputList.new(),
        Module.CML.TransactionOutputList.new(),
        0n
      );
      const witnessSet = Module.CML.TransactionWitnessSet.new();
      const tx = Module.CML.Transaction.new(body, witnessSet, true);
      return { txHex: tx.to_cbor_hex(), bodyHex: body.to_cbor_hex(), witnessSetHex: witnessSet.to_cbor_hex() };
    });
  }

  it('matches the frozen body, witness-set, and transaction-hash fixture', () => {
    const fixture = createEmptyTransaction();
    expect(transactionHexToBodyHex(fixture.txHex)).toBe('a300d901028001800200');
    expect(transactionHexToWitnessSet(fixture.txHex)).toBe('a0');
    expect(transactionHexToHash(fixture.txHex)).toBe('3da9a3b38dce0e87ca4a88f3328caac7a970cf9ac40424cde2b675768d11f11b');
  });

  it('wraps a transaction body with an empty witness set matching the frozen fixture', () => {
    const fixture = createEmptyTransaction();
    expect(transactionBodyHexToTransaction(fixture.bodyHex)).toBe('84a300d901028001800200a0f5f6');
  });

  it('replaces and appends vkey and bootstrap witnesses matching frozen fixtures', () => {
    const fixture = createEmptyTransaction();
    const replacement = RustModule.WasmScope(Module => {
      const cml = Module.CML;
      const witnessSet = cml.TransactionWitnessSet.new();
      const vkeys = cml.VkeywitnessList.new();
      const bootstrap = cml.BootstrapWitnessList.new();
      const bip32Key = cml.Bip32PrivateKey.from_bip39_entropy(new Uint8Array(16), new Uint8Array(0));
      const key = bip32Key.to_raw_key();
      const hash = cml.hash_transaction(cml.TransactionBody.from_cbor_hex(fixture.bodyHex));
      vkeys.add(cml.make_vkey_witness(hash, key));
      bootstrap.add(
        cml.make_icarus_bootstrap_witness(
          hash,
          cml.ByronAddress.from_base58('Ae2tdPwUPEZLmqiKtMQ4kKL38emRfkyPqBsHqL64pf8uRz6uzsQCd7GAu9R'),
          bip32Key
        )
      );
      witnessSet.set_vkeywitnesses(vkeys);
      witnessSet.set_bootstrap_witnesses(bootstrap);
      return witnessSet.to_cbor_hex();
    });
    expect(replacement).toBe(
      'a200d901028182582037fdfdbe9ac856469f8d83c66c57880246cd8bf7f852bf5b94336fe535c0efc85840d039f458d6bc36d517bc8ed1f07151d14be2c36eb7918f18564c8a6ea862d2d20fb39037da456c0889aa817be21e9f57ad2578cd53cf242f12389c2d9beffc0702d901028184582037fdfdbe9ac856469f8d83c66c57880246cd8bf7f852bf5b94336fe535c0efc85840d039f458d6bc36d517bc8ed1f07151d14be2c36eb7918f18564c8a6ea862d2d20fb39037da456c0889aa817be21e9f57ad2578cd53cf242f12389c2d9beffc075820072310084784c7308182dbbdb1449b2706586f1ff5cbf13d15e9b6e78c15f06741a0'
    );
    const expected =
      '84a300d901028001800200a200d901028182582037fdfdbe9ac856469f8d83c66c57880246cd8bf7f852bf5b94336fe535c0efc85840d039f458d6bc36d517bc8ed1f07151d14be2c36eb7918f18564c8a6ea862d2d20fb39037da456c0889aa817be21e9f57ad2578cd53cf242f12389c2d9beffc0702d901028184582037fdfdbe9ac856469f8d83c66c57880246cd8bf7f852bf5b94336fe535c0efc85840d039f458d6bc36d517bc8ed1f07151d14be2c36eb7918f18564c8a6ea862d2d20fb39037da456c0889aa817be21e9f57ad2578cd53cf242f12389c2d9beffc075820072310084784c7308182dbbdb1449b2706586f1ff5cbf13d15e9b6e78c15f06741a0f5f6';
    expect(transactionHexReplaceWitnessSet(fixture.txHex, replacement)).toBe(expected);
    expect(transactionHexAddSignaturesFromWitnessSetHex(fixture.txHex, replacement)).toBe(expected);
  });
});
