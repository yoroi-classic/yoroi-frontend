// @flow

import '../../test-config.forTests';
import { RustModule } from '../rustLoader';
import { BIP32ED25519PrivateKey, BIP32ED25519PublicKey, derivePath } from './keyRepository';

beforeAll(async () => {
  await RustModule.load();
});

describe('CML BIP32-Ed25519 key wrappers', () => {
  it('preserves key bytes, derivation, signing, and verification behavior', () => {
    const fixture = {
      privateBytes: Buffer.from('9083f33a8075db9834f9d5dfc7fef6319ad382931cd52803d12409d9770e6f5374d5290b5d1036f3cda15ea58c2478df609d830da5e1bf1871ce6c2bc9ff33f2e2c5ba0973b868a55acb6b69f7297a0994013f31d44b188282b9dd2da8f46c27', 'hex'),
      publicBytes: Buffer.from('9084b82b7f96526e3156be44d01113ec20fa2e0936929cfa5ae6fca24980c42ae2c5ba0973b868a55acb6b69f7297a0994013f31d44b188282b9dd2da8f46c27', 'hex'),
      signature: Buffer.from('ce907cfa0cc1e693f7bbc643a06c746023463ced641014812ac2e9fbd083620db8620e9dc1d962236432265b24dcafe2b76c708a34498685f735c62114c15c08', 'hex'),
      publicSignature: Buffer.from('ce907cfa0cc1e693f7bbc643a06c746023463ced641014812ac2e9fbd083620db8620e9dc1d962236432265b24dcafe2b76c708a34498685f735c62114c15c08', 'hex'),
    };

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
    const fixture = {
      privateChild: Buffer.from('c014290440d86d690ad1e54b8c172e510b08693a340398750fbcecb7760e6f5328be95663cca1ecb8eb644e452dc2c5783386de0a205fe4142cadd536cc4aa4238772999e5df97500737e8670aa0e66bd2a0a7269d1ae8fde27537a9f4576025', 'hex'),
      publicChild: Buffer.from('9c62ac41c7bd765b9e150ba12b01b42784762dd3ddaa601dafb15d0180acc5f138772999e5df97500737e8670aa0e66bd2a0a7269d1ae8fde27537a9f4576025', 'hex'),
      publicPrivateChild: Buffer.from('9c62ac41c7bd765b9e150ba12b01b42784762dd3ddaa601dafb15d0180acc5f138772999e5df97500737e8670aa0e66bd2a0a7269d1ae8fde27537a9f4576025', 'hex'),
      softPath: [0, 9],
      accountPrivate: Buffer.from('50fc30e83bde38470955247d32a6d35bb2bcbccc18a648bcbfbe07716f0e6f53fabf6d38e5bac238d796cdae15dedbc6083238a6ceaef6a2f6626224a2abbc02b3ea35f04f2ca79e4a69c8e920be85486e4c8c3986675d3a32b41b362cd52c40', 'hex'),
      accountPublic: Buffer.from('589d388a38a61902a3216b49c7e818de2375102a960f50611b26273790bcc33db3ea35f04f2ca79e4a69c8e920be85486e4c8c3986675d3a32b41b362cd52c40', 'hex'),
    };
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
