// @flow
import '../../../test-config.forTests';
import { RustModule } from '../../../cardanoCrypto/rustLoader';
import { StoredCertificateKind } from './storedCertificateKinds';

test('stored certificate kinds preserve the database enum values', async () => {
  await RustModule.load();
  const legacyKinds = RustModule.WalletV4.CertificateKind;
  for (const name of Object.keys(StoredCertificateKind)) {
    expect(StoredCertificateKind[name]).toEqual(legacyKinds[name]);
  }
});
