// @flow

declare function BigInt(value: string | number): any;

// Flow 0.142 has no primitive bigint type; the runtime values remain native
// BigInts and must not be converted to Number.
declare type BigIntValue = any;
