// @flow

// Flow 0.142 has no primitive bigint type. Keep values nominal so numbers
// cannot accidentally be passed to CML APIs that require native BigInts.
declare opaque type BigIntValue: { toString(): string };

declare function BigInt(value: string | number): BigIntValue;
