// @flow
import { RustModule } from './rustLoader';
import { bytesToHex, hexToBytes } from '../../../../coreUtils';

const cborLength = (major: number, length: number): Array<number> => {
  if (length < 24) return [(major << 5) | length];
  if (length < 256) return [(major << 5) | 24, length];
  if (length < 65536) return [(major << 5) | 25, (length >> 8) & 0xff, length & 0xff];
  throw new Error('CBOR value is too long');
};

const utf8Bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

const cborTextHex = (text: string): string => {
  const bytes = utf8Bytes(text);
  return bytesToHex(new Uint8Array([...cborLength(3, bytes.length), ...bytes]));
};

const cborInteger = (value: BigIntValue): Array<number> => {
  const major = value < BigInt('0') ? 1 : 0;
  const remaining = value < BigInt('0') ? -value - BigInt('1') : value;
  // CBOR's 8-byte integer representation is limited to an unsigned 64-bit
  // magnitude. Never truncate a larger MIR reward while writing the payload.
  if (remaining > BigInt('18446744073709551615')) throw new Error('MIR reward amount exceeds the CBOR integer range');
  if (remaining < BigInt('24')) return [(major << 5) | Number(remaining)];
  const width = remaining <= BigInt('0xff') ? 1 : remaining <= BigInt('0xffff') ? 2 : remaining <= BigInt('0xffffffff') ? 4 : 8;
  const bytes = [];
  for (let index = width - 1; index >= 0; index--) {
    // eslint-disable-next-line no-undef
    bytes.push(Number((remaining >> BigInt(index * 8)) & BigInt('0xff')));
  }
  const additional = width === 1 ? 24 : width === 2 ? 25 : width === 4 ? 26 : 27;
  return [(major << 5) | additional, ...bytes];
};

type CborHeader = {| major: number, length: number, next: number |};

const readHeader = (bytes: Uint8Array, offset: number): CborHeader => {
  const first = bytes[offset];
  if (first == null) throw new Error('Invalid MIR certificate CBOR');
  const major = first >> 5;
  const additional = first & 0x1f;
  if (additional < 24) return { major, length: additional, next: offset + 1 };
  const width = additional === 24 ? 1 : additional === 25 ? 2 : additional === 26 ? 4 : additional === 27 ? 8 : 0;
  if (width === 0 || offset + 1 + width > bytes.length) throw new Error('Invalid MIR certificate CBOR');
  let length = 0;
  for (let index = 0; index < width; index++) length = length * 256 + (bytes[offset + 1 + index] ?? 0);
  if (!Number.isSafeInteger(length)) throw new Error('Invalid MIR certificate CBOR length');
  return { major, length, next: offset + 1 + width };
};

const readMirAmount = (bytes: Uint8Array, offset: number): {| amount: string, next: number |} => {
  const first = bytes[offset];
  if (first == null) throw new Error('Invalid MIR reward amount');
  const major = first >> 5;
  if (major !== 0 && major !== 1) throw new Error('Invalid MIR reward amount');
  const additional = first & 0x1f;
  if (additional < 24) return { amount: (major === 0 ? additional : -additional - 1).toString(), next: offset + 1 };
  const width = additional === 24 ? 1 : additional === 25 ? 2 : additional === 26 ? 4 : additional === 27 ? 8 : 0;
  if (width === 0 || offset + 1 + width > bytes.length) throw new Error('Invalid MIR reward amount');
  let magnitude = BigInt('0');
  for (let index = offset + 1; index < offset + 1 + width; index++) {
    // eslint-disable-next-line no-undef
    magnitude = (magnitude << BigInt('8')) | BigInt(bytes[index] ?? 0);
  }
  const amount = major === 0 ? magnitude : -magnitude - BigInt('1');
  return { amount: amount.toString(), next: offset + 1 + width };
};

export const mirRewardForCredential = (payloadHex: string, credentialHex: string): string | null => {
  const bytes = hexToBytes(payloadHex);
  const outer = readHeader(bytes, 0);
  if (outer.major !== 4 || outer.length !== 2) throw new Error('Invalid MIR certificate array');
  const kind = readHeader(bytes, outer.next);
  if (kind.major !== 0 || kind.length !== 6) throw new Error('Not an MIR certificate');
  const reward = readHeader(bytes, kind.next);
  if (reward.major !== 4 || reward.length !== 2) throw new Error('Invalid MIR reward');
  const pot = readHeader(bytes, reward.next);
  if (pot.major !== 0 || pot.length > 1) throw new Error('MIR certificate is not a stake credential map');
  const map = readHeader(bytes, pot.next);
  if (map.major === 0) return null; // MIR to the other pot has a numeric amount instead of a map.
  if (map.major !== 5) throw new Error('Invalid MIR credential map');
  const expected = credentialHex.toLowerCase();
  let offset = map.next;
  for (let index = 0; index < map.length; index++) {
    const keyStart = offset;
    const keyArray = readHeader(bytes, offset);
    if (keyArray.major !== 4 || keyArray.length !== 2) throw new Error('Invalid MIR credential');
    const credentialKind = readHeader(bytes, keyArray.next);
    if (credentialKind.major !== 0 || credentialKind.length > 1) throw new Error('Invalid MIR credential kind');
    const hash = readHeader(bytes, credentialKind.next);
    if (hash.major !== 2 || (hash.length !== 28 && hash.length !== 32)) throw new Error('Invalid MIR credential hash');
    offset = hash.next + hash.length;
    const keyHex = bytesToHex(bytes.slice(keyStart, offset)).toLowerCase();
    const amount = readMirAmount(bytes, offset);
    offset = amount.next;
    if (keyHex === expected) return amount.amount;
  }
  if (offset !== bytes.length) throw new Error('Trailing data in MIR certificate');
  return null;
};

export const mirCertificatePayloadHex = (pot: number, rewards: { [addressHex: string]: string }): string =>
  RustModule.WasmScope(Module => {
    if (pot !== 0 && pot !== 1) throw new Error('Invalid MIR pot');
    const entries = Object.keys(rewards).map(addressHex => {
      const rewardAddress = Module.CML.RewardAddress.from_address(Module.CML.Address.from_raw_bytes(hexToBytes(addressHex)));
      if (rewardAddress == null) throw new Error('MIR address is not a reward account');
      const key = hexToBytes(rewardAddress.payment().to_cbor_hex());
      // eslint-disable-next-line no-undef
      const value = BigInt(rewards[addressHex]);
      return { key, value };
    });
    entries.sort((left, right) => {
      const lengthDiff = left.key.length - right.key.length;
      if (lengthDiff !== 0) return lengthDiff;
      for (let index = 0; index < left.key.length; index++) {
        const diff = (left.key[index] ?? 0) - (right.key[index] ?? 0);
        if (diff !== 0) return diff;
      }
      return 0;
    });
    const encoded = [0x82, 0x06, 0x82, pot, ...cborLength(5, entries.length)];
    for (const { key, value } of entries) encoded.push(...key, ...cborInteger(value));
    return bytesToHex(new Uint8Array(encoded));
  });

export const mirRewardForRewardAddress = (payloadHex: string, addressHex: string): string | null =>
  RustModule.WasmScope(Module => {
    const address = Module.CML.RewardAddress.from_address(Module.CML.Address.from_raw_bytes(hexToBytes(addressHex)));
    if (address == null) return null;
    return mirRewardForCredential(payloadHex, address.payment().to_cbor_hex());
  });

export const poolRegistrationPayloads = (
  poolParams: $ReadOnly<{|
    operator: string,
    vrfKeyHash: string,
    pledge: string,
    cost: string,
    margin: number,
    rewardAccount: string,
    poolOwners: $ReadOnlyArray<string>,
    relays: $ReadOnlyArray<{|
      ipv4: string | null,
      ipv6: string | null,
      dnsName: string | null,
      dnsSrvName: string | null,
      port: string | null,
    |}>,
    poolMetadata: null | {| url: string, metadataHash: string |},
  |}>
): {| certificateHex: string, operatorCredentialHex: string, ownerCredentialHexes: Array<string> |} =>
  RustModule.WasmScope(Module => {
    const CML = Module.CML;
    const rewardAddress = CML.RewardAddress.from_address(CML.Address.from_raw_bytes(hexToBytes(poolParams.rewardAccount)));
    if (rewardAddress == null) throw new Error('Pool registration address is not a reward account');

    const operator = CML.Ed25519KeyHash.from_hex(poolParams.operator);
    const owners = CML.Ed25519KeyHashList.new();
    const ownerCredentialHexes = [];
    for (const ownerHash of poolParams.poolOwners) {
      const owner = CML.Ed25519KeyHash.from_hex(ownerHash);
      owners.add(owner);
      ownerCredentialHexes.push(CML.Credential.new_pub_key(owner).to_cbor_hex());
    }

    let metadata = undefined;
    const poolMetadata = poolParams.poolMetadata;
    if (poolMetadata != null) {
      const url = CML.Url.from_cbor_hex(cborTextHex(poolMetadata.url));
      const metadataHash = CML.PoolMetadataHash.from_hex(poolMetadata.metadataHash);
      metadata = CML.PoolMetadata.new(url, metadataHash);
    }

    // eslint-disable-next-line no-undef
    const pledge = BigInt(poolParams.pledge);
    // eslint-disable-next-line no-undef
    const cost = BigInt(poolParams.cost);
    // eslint-disable-next-line no-undef
    const one = BigInt(1);
    const params = CML.PoolParams.new(
      operator,
      CML.VRFKeyHash.from_hex(poolParams.vrfKeyHash),
      pledge,
      cost,
      // The current db-sync endpoint only exposes a numeric margin; preserve the
      // prior behavior of storing a 1/1 placeholder rather than rounding it.
      CML.UnitInterval.new(one, one),
      rewardAddress,
      owners,
      CML.RelayList.new(),
      metadata
    );
    return {
      certificateHex: CML.Certificate.new_pool_registration(params).to_cbor_hex(),
      operatorCredentialHex: CML.Credential.new_pub_key(operator).to_cbor_hex(),
      ownerCredentialHexes,
    };
  });

export const genesisKeyDelegationCertificateHex = (
  genesisHash: string,
  genesisDelegateHash: string,
  vrfKeyHash: string
): string =>
  RustModule.WasmScope(Module => {
    const fields = [
      Module.CML.GenesisHash.from_hex(genesisHash).to_raw_bytes(),
      Module.CML.GenesisDelegateHash.from_hex(genesisDelegateHash).to_raw_bytes(),
      Module.CML.VRFKeyHash.from_hex(vrfKeyHash).to_raw_bytes(),
    ];
    const encoded = [0x84, 0x05]; // [GenesisKeyDelegation, genesis hash, delegate hash, VRF hash]
    for (const field of fields) encoded.push(...cborLength(2, field.length), ...field);
    return bytesToHex(new Uint8Array(encoded));
  });
