// @flow
import { StoredCertificateKind } from './storedCertificateKinds';

test('stored certificate kinds preserve the database enum values', async () => {
  expect(Object.values(StoredCertificateKind)).toEqual(Array.from({ length: 17 }, (_value, index) => index));
});
