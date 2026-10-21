// @flow

/** Returns true only for non-empty hexadecimal strings. */
export const isHex = (value: string): boolean => value.length % 2 === 0 && /^[0-9a-f]+$/i.test(value);
