// @flow

/** Certificate.Kind is persisted as the legacy numeric enum value. Keep this
 * storage contract independent from the serialization library implementation.
 */
export const StoredCertificateKind = Object.freeze({
  StakeRegistration: 0,
  StakeDeregistration: 1,
  StakeDelegation: 2,
  PoolRegistration: 3,
  PoolRetirement: 4,
  GenesisKeyDelegation: 5,
  MoveInstantaneousRewardsCert: 6,
  CommitteeHotAuth: 7,
  CommitteeColdResign: 8,
  DRepDeregistration: 9,
  DRepRegistration: 10,
  DRepUpdate: 11,
  StakeAndVoteDelegation: 12,
  StakeRegistrationAndDelegation: 13,
  StakeVoteRegistrationAndDelegation: 14,
  VoteDelegation: 15,
  VoteRegistrationAndDelegation: 16,
});
