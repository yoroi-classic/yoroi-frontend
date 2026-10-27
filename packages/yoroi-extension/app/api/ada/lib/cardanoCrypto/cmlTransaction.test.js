// @flow

import { transactionSetTagState } from './cmlTransaction';

test('detects untagged and fully tagged transaction body sets', () => {
  expect(transactionSetTagState('a200800201')).toBe('none');
  expect(transactionSetTagState('a200d90102800201')).toBe('all');
});

test('detects mixed tags across transaction body set fields', () => {
  expect(transactionSetTagState('a300d901028004800201')).toBe('mixed');
});

test('skips nested data without mistaking tag 258 for a body set tag', () => {
  // The output value contains tag 258, but neither set-valued body field is tagged.
  expect(transactionSetTagState('a300800181d90102800201')).toBe('none');
});

test('skips indefinite-length arrays nested in transaction body values', () => {
  expect(transactionSetTagState('a20080029f01ff')).toBe('none');
  expect(transactionSetTagState('a300d9010280029fff0480')).toBe('mixed');
});

test('rejects invalid transaction body CBOR', () => {
  expect(() => transactionSetTagState('')).toThrow();
  expect(() => transactionSetTagState('a100')).toThrow();
});
