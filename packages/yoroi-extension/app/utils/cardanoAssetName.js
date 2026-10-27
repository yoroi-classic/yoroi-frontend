// @flow

import { isHex } from './hex';

function crc8(bytes: Uint8Array): number {
  let checksum = 0;
  for (const byte of bytes) {
    checksum ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      checksum = (checksum & 0x80) === 0 ? checksum << 1 : (checksum << 1) ^ 0x07;
      checksum &= 0xff;
    }
  }
  return checksum;
}

function resolveCip67Tag(assetNameHex: string): {| hexName: string, tag: ?number |} {
  if (assetNameHex.length > 0 && !isHex(assetNameHex)) throw new Error('Valid HEX asset name is expected');
  const bytes = Buffer.from(assetNameHex, 'hex');
  if (bytes.length < 4) return { hexName: assetNameHex, tag: null };
  const a = bytes[0];
  const b = bytes[1];
  const c = bytes[2];
  const d = bytes[3];
  if (a == null || b == null || c == null || d == null || (a & 0xf0) !== 0 || (d & 0x0f) !== 0) {
    return { hexName: assetNameHex, tag: null };
  }
  const x = ((a & 0x0f) << 4) | (b >> 4);
  const y = ((b & 0x0f) << 4) | (c >> 4);
  const check = ((c & 0x0f) << 4) | (d >> 4);
  if (crc8(Uint8Array.from([x, y])) !== check) return { hexName: assetNameHex, tag: null };
  return { hexName: bytes.subarray(4).toString('hex'), tag: (x << 8) | y };
}

function resolveAsciiName(assetNameHex: string): {| isAscii: boolean, asciiName: ?string, hexName: string |} {
  if (assetNameHex.length > 0 && !isHex(assetNameHex)) throw new Error('Valid HEX asset name is expected');
  const bytes = Buffer.from(assetNameHex, 'hex');
  const ascii = [...bytes].every(byte => byte >= 32 && byte < 127);
  const asciiName = ascii && bytes.length > 0 ? bytes.toString('ascii') : null;
  if (asciiName != null && asciiName !== 'ADA') return { isAscii: true, asciiName, hexName: assetNameHex };
  return { isAscii: false, asciiName: null, hexName: assetNameHex };
}

export const AssetNameUtils = Object.freeze({
  resolveProperties(assetNameHex: string): {| hexName: string, asciiName: ?string, cip67Tag: ?number |} {
    const tagged = resolveCip67Tag(assetNameHex);
    const ascii = resolveAsciiName(tagged.hexName);
    return { hexName: ascii.hexName, asciiName: ascii.asciiName, cip67Tag: tagged.tag };
  },
});
