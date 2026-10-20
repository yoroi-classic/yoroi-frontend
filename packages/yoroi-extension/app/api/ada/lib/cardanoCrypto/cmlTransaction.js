// @flow

import { hexToBytes } from '../../../../coreUtils';

const SET_TAG = 258n;
const SET_BODY_KEYS = new Set([0, 4, 13, 14, 18]);

type CborHead = {| major: number, additional: number, value: bigint |};

function readHead(bytes: Uint8Array, offset: number): CborHead {
  if (offset >= bytes.length) throw new Error('Unexpected end of CBOR');
  const initial = bytes[offset];
  const additional = initial & 31;
  let value;
  // eslint-disable-next-line no-undef
  if (additional < 24) value = BigInt(additional);
  // eslint-disable-next-line no-undef
  else if (additional === 24) value = BigInt(bytes[offset + 1]);
  // eslint-disable-next-line no-undef
  else if (additional === 25) value = BigInt((bytes[offset + 1] << 8) | bytes[offset + 2]);
  else if (additional === 26) {
    // eslint-disable-next-line no-undef
    value = BigInt(bytes[offset + 1]) * 16777216n + BigInt(bytes[offset + 2]) * 65536n + BigInt(bytes[offset + 3]) * 256n + BigInt(bytes[offset + 4]);
  } else if (additional === 27) {
    value = 0n;
    // eslint-disable-next-line no-undef
    for (let index = 1; index <= 8; index++) value = (value << 8n) | BigInt(bytes[offset + index]);
  } else if (additional === 31) value = -1n;
  else throw new Error('Invalid CBOR additional information');
  const width = additional < 24 || additional === 31 ? 1 : additional === 24 ? 2 : additional === 25 ? 3 : additional === 26 ? 5 : 9;
  if (offset + width > bytes.length) throw new Error('Unexpected end of CBOR');
  return { major: initial >> 5, additional, value };
}

function skipItem(bytes: Uint8Array, offset: number, depth: number = 0): number {
  if (depth > 100) throw new Error('CBOR nesting exceeds supported depth');
  const head = readHead(bytes, offset);
  let cursor = offset + (head.additional < 24 || head.additional === 31 ? 1 : head.additional === 24 ? 2 : head.additional === 25 ? 3 : head.additional === 26 ? 5 : 9);
  if (head.major === 0 || head.major === 1) return cursor;
  if (head.major === 2 || head.major === 3) {
    if (head.value === -1n) {
      while (bytes[cursor] !== 0xff) cursor = skipItem(bytes, cursor, depth + 1);
      return cursor + 1;
    }
    const end = cursor + Number(head.value);
    if (end > bytes.length) throw new Error('CBOR byte/text string exceeds input');
    return end;
  }
  if (head.major === 4 || head.major === 5) {
    const indefinite = head.value === -1n;
    const count = indefinite ? undefined : Number(head.value) * (head.major === 5 ? 2 : 1);
    let consumed = 0;
    while (indefinite ? bytes[cursor] !== 0xff : consumed < count) {
      cursor = skipItem(bytes, cursor, depth + 1);
      consumed++;
    }
    return indefinite ? cursor + 1 : cursor;
  }
  if (head.major === 6) return skipItem(bytes, cursor, depth + 1);
  if (head.major === 7) return cursor;
  throw new Error('Invalid CBOR major type');
}

function bodySetTagStates(bytes: Uint8Array): Array<boolean> {
  const body = readHead(bytes, 0);
  if (body.major !== 5) throw new Error('Transaction body must be a CBOR map');
  const indefinite = body.value === -1n;
  let cursor = body.additional === 31 ? 1 : body.additional < 24 ? 1 : body.additional === 24 ? 2 : body.additional === 25 ? 3 : body.additional === 26 ? 5 : 9;
  let pairs = 0;
  const states = [];
  while (indefinite ? bytes[cursor] !== 0xff : pairs < Number(body.value)) {
    const key = readHead(bytes, cursor);
    if (key.major !== 0) throw new Error('Transaction body map key is not an unsigned integer');
    cursor = skipItem(bytes, cursor);
    const value = readHead(bytes, cursor);
    if (SET_BODY_KEYS.has(Number(key.value))) {
      const tagged = value.major === 6 && value.value === SET_TAG;
      states.push(tagged);
    }
    cursor = skipItem(bytes, cursor);
    pairs++;
  }
  if (indefinite && bytes[cursor] === 0xff) cursor++;
  if (cursor !== bytes.length) throw new Error('Unexpected trailing bytes in transaction body CBOR');
  return states;
}

export function transactionSetTagState(txBodyHex: string): 'none' | 'all' | 'mixed' {
  const states = bodySetTagStates(hexToBytes(txBodyHex));
  if (states.length === 0 || states.every(tagged => !tagged)) return 'none';
  if (states.every(Boolean)) return 'all';
  return 'mixed';
}
