// @flow
import { beforeAll, expect, test } from '@jest/globals';
import '../../../../../api/ada/lib/test-config.forTests';
import { RustModule } from '../../../../../api/ada/lib/cardanoCrypto/rustLoader';
import type { TransactionBody } from '../types';
import { formatCborMetadata, formatUnsignedTxMetadata } from './useFormatMetadata';

const mockTxBody = (hash: string | null): TransactionBody => ({
  auxiliary_data_hash: hash,
  fee: '0',
  inputs: [],
  outputs: [],
});

beforeAll(async () => {
  await RustModule.load();
});

test('parses transaction auxiliary metadata with CML', () => {
  // Label 674 contains a map with one CIP-20-style message string.
  const txCbor = '84a3008001800200a0f5a11902a2a1636d736781717b2268656c6c6f223a22776f726c64227d';

  expect(formatCborMetadata(txCbor, mockTxBody('metadata-hash'))).toEqual({
    hash: 'metadata-hash',
    metadata: { msg: [{ hello: 'world' }] },
  });
});

test('parses auxiliary metadata bytes for unsigned transaction review', () => {
  const txCbor = '84a3008001800200a0f5a11902a2a1636d736781717b2268656c6c6f223a22776f726c64227d';
  const metadataBytes = RustModule.WasmScope(Module => {
    const auxiliaryData = Module.CML.Transaction.from_cbor_hex(txCbor).auxiliary_data();
    if (auxiliaryData == null) throw new Error('Expected transaction auxiliary data');
    return auxiliaryData.to_cbor_bytes();
  });

  expect(formatUnsignedTxMetadata(metadataBytes, mockTxBody('metadata-hash'))).toEqual({
    hash: 'metadata-hash',
    metadata: { msg: [{ hello: 'world' }] },
  });
});

test('joins label 674 JSON fragments split across list entries', () => {
  const txCbor = '84a3008001800200a0f5a11902a2a1636d736782697b2268656c6c6f223a6822776f726c64227d';
  const metadataBytes = RustModule.WasmScope(Module => {
    const auxiliaryData = Module.CML.Transaction.from_cbor_hex(txCbor).auxiliary_data();
    if (auxiliaryData == null) throw new Error('Expected transaction auxiliary data');
    return auxiliaryData.to_cbor_bytes();
  });

  expect(formatUnsignedTxMetadata(metadataBytes, mockTxBody('metadata-hash'))).toEqual({
    hash: 'metadata-hash',
    metadata: { msg: [{ hello: 'world' }] },
  });
});

test.each([
  ['single comment', ['A payment for dinner']],
  ['invoice lines', ['Invoice-No: 123', 'Invoice-No: 456', 'Invoice-No: 789']],
])('preserves plain-text CIP-20 %s in CBOR and unsigned metadata', (_name, lines) => {
  const encodeText = (value: string) => {
    const bytes = Buffer.from(value);
    const header = bytes.length < 24 ? [0x60 + bytes.length] : [0x78, bytes.length];
    return `${Buffer.from(header).toString('hex')}${bytes.toString('hex')}`;
  };
  const list = lines.map(encodeText).join('');
  const cbor = `84a3008001800200a0f5a11902a2a1636d7367${(0x80 + lines.length).toString(16)}${list}`;
  const metadataBytes = RustModule.WasmScope(Module => {
    const auxiliaryData = Module.CML.Transaction.from_cbor_hex(cbor).auxiliary_data();
    if (auxiliaryData == null) throw new Error('Expected transaction auxiliary data');
    return auxiliaryData.to_cbor_bytes();
  });

  expect(formatCborMetadata(cbor, mockTxBody('metadata-hash'))).toEqual({
    hash: 'metadata-hash',
    metadata: { msg: lines },
  });
  expect(formatUnsignedTxMetadata(metadataBytes, mockTxBody('metadata-hash'))).toEqual({
    hash: 'metadata-hash',
    metadata: { msg: lines },
  });
});

test('returns null metadata for malformed transaction CBOR', () => {
  expect(formatCborMetadata('not-cbor', mockTxBody(null))).toEqual({ hash: null, metadata: null });
});
