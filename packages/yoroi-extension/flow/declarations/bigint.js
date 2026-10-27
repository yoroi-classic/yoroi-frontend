// @flow

// Flow 0.142 cannot model the native BigInt primitive or its arithmetic.
// Keep this boundary explicit; never convert these values through Number.
declare function BigInt(value: string | number): any;

declare type BigIntValue = any;
