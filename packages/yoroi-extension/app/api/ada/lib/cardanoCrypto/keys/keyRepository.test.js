// @flow

import '../../test-config.forTests';
import { RustModule } from '../rustLoader';
import { BIP32ED25519PrivateKey, BIP32ED25519PublicKey, derivePath } from './keyRepository';

beforeAll(async () => {
  await RustModule.load();
});

describe('CML BIP32-Ed25519 key wrappers', () => {
  it('preserves CSL key bytes, derivation, signing, and verification behavior', () => {
    const fixture = RustModule.WasmScope(Module => {
      const root = Module.WalletV4.Bip32PrivateKey.from_bip39_entropy(new Uint8Array(16), new Uint8Array(0));
      const cslPrivate = root.derive(0x8000002c).derive(0x80000717).derive(0x80000000).derive(0).derive(7);
      const cslPublic = cslPrivate.to_public();
      const message = Buffer.from('CML key wrapper parity');
      const signature = cslPrivate.to_raw_key().sign(message);
      return {
        privateBytes: Buffer.from(cslPrivate.as_bytes()),
        publicBytes: Buffer.from(cslPublic.as_bytes()),
        signature: Buffer.from(signature.to_bytes()),
        publicSignature: Buffer.from(cslPublic.to_raw_key().verify(message, signature) ? signature.to_bytes() : []),
      };
    });

    const privateKey = BIP32ED25519PrivateKey.fromBuffer(fixture.privateBytes);
    const publicKey = BIP32ED25519PublicKey.fromBuffer(fixture.publicBytes);
    const message = Buffer.from('CML key wrapper parity');
    const signature = privateKey.sign(message);

    expect(privateKey.toBuffer()).toEqual(fixture.privateBytes);
    expect(publicKey.toBuffer()).toEqual(fixture.publicBytes);
    expect(signature).toEqual(fixture.signature);
    expect(signature).toEqual(fixture.publicSignature);
    expect(privateKey.toPublic().toBuffer()).toEqual(fixture.publicBytes);
    expect(publicKey.verify(message, signature)).toBe(true);
    expect(publicKey.verify(Buffer.from('different message'), signature)).toBe(false);
  });

  it('preserves public and private path derivation bytes', () => {
    const fixture = RustModule.WasmScope(Module => {
      const root = Module.WalletV4.Bip32PrivateKey.from_bip39_entropy(new Uint8Array(16), new Uint8Array(0));
      const account = root.derive(0x8000002c).derive(0x80000717).derive(0x80000000);
      const publicAccount = account.to_public();
      const path = [0, 9];
      const privateChild = account.derive(path[0]).derive(path[1]);
      const publicChild = publicAccount.derive(path[0]).derive(path[1]);
      return {
        privateChild: Buffer.from(privateChild.as_bytes()),
        publicChild: Buffer.from(publicChild.as_bytes()),
        publicPrivateChild: Buffer.from(privateChild.to_public().as_bytes()),
        softPath: path,
        accountPrivate: Buffer.from(account.as_bytes()),
        accountPublic: Buffer.from(publicAccount.as_bytes()),
      };
    });
    const privateAccount = BIP32ED25519PrivateKey.fromBuffer(fixture.accountPrivate);
    const publicAccount = BIP32ED25519PublicKey.fromBuffer(fixture.accountPublic);
    const privateChild = derivePath(privateAccount, fixture.softPath);
    const publicChild = derivePath(publicAccount, fixture.softPath);

    expect(privateChild.toBuffer()).toEqual(fixture.privateChild);
    expect(publicChild.toBuffer()).toEqual(fixture.publicChild);
    expect(privateChild.toPublic().toBuffer()).toEqual(fixture.publicPrivateChild);
    expect(publicChild.toBuffer()).toEqual(fixture.publicPrivateChild);
  });
});
