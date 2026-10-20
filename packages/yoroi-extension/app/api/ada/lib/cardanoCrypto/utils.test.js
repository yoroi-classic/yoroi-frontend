// @flow

import { RustModule } from './rustLoader';
import '../test-config.forTests';
import { iterateLenGet } from '../../../../coreUtils';
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

  it('matches CSL body, witness-set, and transaction hash results', () => {
    const fixture = createEmptyTransaction();
    const expected = RustModule.WasmScope(Module => {
      const cslTx = Module.WalletV4.FixedTransaction.from_hex(fixture.txHex);
      return {
        body: Buffer.from(cslTx.raw_body()).toString('hex'),
        witnessSet: Buffer.from(cslTx.raw_witness_set()).toString('hex'),
        hash: cslTx.transaction_hash().to_hex(),
      };
    });

    expect(transactionHexToBodyHex(fixture.txHex)).toBe(expected.body);
    expect(transactionHexToWitnessSet(fixture.txHex)).toBe(expected.witnessSet);
    expect(transactionHexToHash(fixture.txHex)).toBe(expected.hash);
  });

  it('wraps a transaction body with an empty witness set like CSL', () => {
    const fixture = createEmptyTransaction();
    const expected = RustModule.WasmScope(Module =>
      Module.WalletV4.FixedTransaction.new(
        Module.WalletV4.TransactionBody.from_hex(fixture.bodyHex).to_bytes(),
        Module.WalletV4.TransactionWitnessSet.new().to_bytes(),
        true
      ).to_hex()
    );

    expect(transactionBodyHexToTransaction(fixture.bodyHex)).toBe(expected);
  });

  it('replaces the witness set and appends vkey and bootstrap witnesses like CSL', () => {
    const fixture = createEmptyTransaction();
    const replacement = RustModule.WasmScope(Module => {
      const witnessSet = Module.WalletV4.TransactionWitnessSet.new();
      const vkeys = Module.WalletV4.Vkeywitnesses.new();
      const bootstrap = Module.WalletV4.BootstrapWitnesses.new();
      const bip32Key = Module.WalletV4.Bip32PrivateKey.from_bip39_entropy(new Uint8Array(16), new Uint8Array(0));
      const key = bip32Key.to_raw_key();
      const hash = Module.WalletV4.FixedTransaction.from_hex(fixture.txHex).transaction_hash();
      vkeys.add(Module.WalletV4.make_vkey_witness(hash, key));
      bootstrap.add(
        Module.WalletV4.make_icarus_bootstrap_witness(
          hash,
          Module.WalletV4.ByronAddress.from_base58('Ae2tdPwUPEZLmqiKtMQ4kKL38emRfkyPqBsHqL64pf8uRz6uzsQCd7GAu9R'),
          bip32Key
        )
      );
      witnessSet.set_vkeys(vkeys);
      witnessSet.set_bootstraps(bootstrap);
      return witnessSet.to_hex();
    });
    const expectedReplacement = RustModule.WasmScope(Module => {
      const fixed = Module.WalletV4.FixedTransaction.from_hex(fixture.txHex);
      fixed.set_witness_set(Module.WalletV4.TransactionWitnessSet.from_hex(replacement).to_bytes());
      return fixed.to_hex();
    });
    expect(transactionHexReplaceWitnessSet(fixture.txHex, replacement)).toBe(expectedReplacement);

    const expectedAppend = RustModule.WasmScope(Module => {
      const fixed = Module.WalletV4.FixedTransaction.from_hex(fixture.txHex);
      const witnessSet = Module.WalletV4.TransactionWitnessSet.from_hex(replacement);
      for (const witness of iterateLenGet(witnessSet.vkeys())) fixed.add_vkey_witness(witness);
      for (const witness of iterateLenGet(witnessSet.bootstraps())) fixed.add_bootstrap_witness(witness);
      return fixed.to_hex();
    });
    expect(transactionHexAddSignaturesFromWitnessSetHex(fixture.txHex, replacement)).toBe(expectedAppend);
  });
});
