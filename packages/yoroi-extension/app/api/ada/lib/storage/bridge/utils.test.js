// @flow
import '../../test-config.forTests';
import { RustModule } from '../../cardanoCrypto/rustLoader';
import { isCertificateKindDrepDelegation } from './utils';

beforeAll(async () => {
  await RustModule.load();
});

test('recognizes only CML certificate kinds that delegate voting power', () => {
  const kinds = RustModule.CML.CertificateKind;
  expect(isCertificateKindDrepDelegation(kinds.VoteDelegCert)).toBe(true);
  expect(isCertificateKindDrepDelegation(kinds.StakeVoteDelegCert)).toBe(true);
  expect(isCertificateKindDrepDelegation(kinds.VoteRegDelegCert)).toBe(true);
  expect(isCertificateKindDrepDelegation(kinds.StakeVoteRegDelegCert)).toBe(true);
  expect(isCertificateKindDrepDelegation(kinds.RegDrepCert)).toBe(false);
  expect(isCertificateKindDrepDelegation(kinds.UnregDrepCert)).toBe(false);
});
