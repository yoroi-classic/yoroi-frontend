// @flow
import type { Addressing } from '../storage/models/PublicDeriver/interfaces';
import { RustModule } from './rustLoader';
import { hexToBytes } from '../../../../coreUtils';

export function derivePrivateKeyBytesByAddressing(request: {|
  privateKeyHex: string,
  addressing: $PropertyType<Addressing, 'addressing'>,
  level: number,
|}): Uint8Array {
  if (request.level + 1 < request.addressing.startLevel) {
    throw new Error('derivePrivateKeyBytesByAddressing keyLevel < startLevel');
  }
  return RustModule.WasmScope(Module => {
    let derivedKey = Module.CML.Bip32PrivateKey.from_raw_bytes(hexToBytes(request.privateKeyHex));
    const firstPathIndex = request.level - request.addressing.startLevel + 1;
    for (let index = firstPathIndex; index < request.addressing.path.length; index++) {
      const childIndex = request.addressing.path[index];
      if (childIndex == null) throw new Error('Invalid private key derivation path');
      derivedKey = derivedKey.derive(childIndex);
    }
    return derivedKey.to_raw_key().to_raw_bytes();
  });
}

export function derivePublicByAddressing(request: {|
  addressing: $PropertyType<Addressing, 'addressing'>,
  startingFrom: {|
    key: RustModule.WalletV4.Bip32PublicKey,
    level: number,
  |},
|}): RustModule.WalletV4.Bip32PublicKey {
  if (request.startingFrom.level + 1 < request.addressing.startLevel) {
    throw new Error(`${nameof(derivePublicByAddressing)} keyLevel < startLevel`);
  }
  let derivedKey = request.startingFrom.key;
  for (let i = request.startingFrom.level - request.addressing.startLevel + 1; i < request.addressing.path.length; i++) {
    derivedKey = derivedKey.derive(request.addressing.path[i]);
  }
  return derivedKey;
}

export function derivePrivateByAddressing(request: {|
  addressing: $PropertyType<Addressing, 'addressing'>,
  startingFrom: {|
    key: RustModule.WalletV4.Bip32PrivateKey,
    level: number,
  |},
|}): RustModule.WalletV4.Bip32PrivateKey {
  if (request.startingFrom.level + 1 < request.addressing.startLevel) {
    throw new Error(`${nameof(derivePrivateByAddressing)} keyLevel < startLevel`);
  }
  let derivedKey = request.startingFrom.key;
  for (let i = request.startingFrom.level - request.addressing.startLevel + 1; i < request.addressing.path.length; i++) {
    derivedKey = derivedKey.derive(request.addressing.path[i]);
  }
  return derivedKey;
}
