// @flow

/** Returns true only for non-empty hexadecimal strings. */
export const isHex = (value: string): boolean => /^[0-9a-f]+$/i.test(value);
