// @flow

import { AssetNameUtils } from './cardanoAssetName';
import { isHex } from './hex';

test('recognizes non-empty hex strings without accepting invalid digits', () => {
  expect(isHex('aB09')).toBe(true);
  expect(isHex('abc')).toBe(false);
  expect(isHex('')).toBe(false);
  expect(isHex('0x10')).toBe(false);
});

test('resolves CIP-67 labels, printable names, and ADA blacklist consistently', () => {
  expect(AssetNameUtils.resolveProperties('000643b0616263')).toEqual({
    hexName: '616263',
    asciiName: 'abc',
    cip67Tag: 100,
  });
  expect(AssetNameUtils.resolveProperties('616263')).toEqual({
    hexName: '616263',
    asciiName: 'abc',
    cip67Tag: null,
  });
  expect(AssetNameUtils.resolveProperties('414441')).toEqual({
    hexName: '414441',
    asciiName: null,
    cip67Tag: null,
  });
  expect(AssetNameUtils.resolveProperties('ff')).toEqual({
    hexName: 'ff',
    asciiName: null,
    cip67Tag: null,
  });
  expect(() => AssetNameUtils.resolveProperties('zz')).toThrow('Valid HEX asset name is expected');
});
