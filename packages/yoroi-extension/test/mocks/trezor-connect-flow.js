const cardanoAddressType = {
  BASE: 0,
  BASE_SCRIPT_KEY: 1,
  BASE_KEY_SCRIPT: 2,
  BASE_SCRIPT_SCRIPT: 3,
  POINTER: 4,
  POINTER_SCRIPT: 5,
  ENTERPRISE: 6,
  ENTERPRISE_SCRIPT: 7,
  BYRON: 8,
  REWARD: 14,
  REWARD_SCRIPT: 15,
};
const cardanoCertificateType = {
  STAKE_REGISTRATION: 0,
  STAKE_DEREGISTRATION: 1,
  STAKE_DELEGATION: 2,
  STAKE_POOL_REGISTRATION: 3,
  STAKE_REGISTRATION_CONWAY: 7,
  STAKE_DEREGISTRATION_CONWAY: 8,
  VOTE_DELEGATION: 9,
};
const cardanoDRepType = {
  KEY_HASH: 0,
  SCRIPT_HASH: 1,
  ABSTAIN: 2,
  NO_CONFIDENCE: 3,
};
const cardanoTxSigningMode = {
  ORDINARY_TRANSACTION: 0,
  POOL_REGISTRATION_AS_OWNER: 1,
  MULTISIG_TRANSACTION: 2,
  PLUTUS_TRANSACTION: 3,
};

module.exports = {
  CardanoAddressType: cardanoAddressType,
  CardanoCertificateType: cardanoCertificateType,
  CardanoDRepType: cardanoDRepType,
  CardanoDerivationType: { LEDGER: 0, ICARUS: 1, ICARUS_TREZOR: 2 },
  CardanoGovernanceRegistrationFormat: { CIP15: 0, CIP36: 1 },
  CardanoTxOutputSerializationFormat: { ARRAY_LEGACY: 0, MAP_BABBAGE: 1 },
  CardanoTxSigningMode: cardanoTxSigningMode,
  CardanoTxWitnessType: { BYRON_WITNESS: 0, SHELLEY_WITNESS: 1 },
  default: {
    init: async () => {},
    dispose: async () => {},
    cardanoGetPublicKey: async () => ({ success: false, payload: { error: 'Mock Trezor method' } }),
    cardanoGetAddress: async () => ({ success: false, payload: { error: 'Mock Trezor method' } }),
    cardanoSignMessage: async () => ({ success: false, payload: { error: 'Mock Trezor method' } }),
    cardanoSignTransaction: async () => ({ success: false, payload: { error: 'Mock Trezor method' } }),
    getFeatures: async () => ({ success: false, payload: { error: 'Mock Trezor method' } }),
    setSelectedWallet: async () => {},
  },
};
