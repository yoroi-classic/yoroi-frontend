import { Balance, Portfolio } from '@yoroi/types';

export type CardanoCredentialKind = 0 | 1;

export type TransactionInput = { index: number; transaction_id: string };
export type TransactionInputs = TransactionInput[];
export type TransactionOutput = {
  address: string;
  amount: { coin: string; multiasset?: Record<string, Record<string, string>> | null };
};
export type TransactionOutputs = TransactionOutput[];
export type TransactionBody = {
  auxiliary_data_hash?: string | null;
  certs?: Array<Record<string, unknown>> | null;
  fee: string;
  inputs: TransactionInputs;
  outputs: TransactionOutputs;
  reference_inputs?: TransactionInputs | null;
};

export type FormattedInput = {
  assets: Array<{
    tokenInfo: Portfolio.Token.Info;
    name: string;
    label: string;
    quantity: Balance.Quantity;
    isPrimary: boolean;
  }>;
  address: string | undefined;
  addressKind: CardanoCredentialKind | null;
  rewardAddress: string | null;
  ownAddress: boolean | null;
  txIndex: number;
  txHash: string;
};

export type FormattedInputs = Array<FormattedInput>;

export type FormattedOutput = {
  assets: Array<{
    tokenInfo: Portfolio.Token.Info;
    name: string;
    label: string;
    quantity: Balance.Quantity;
    isPrimary: boolean;
  }>;
  address: string;
  addressKind: CardanoCredentialKind | null;
  rewardAddress: string | null;
  ownAddress: boolean;
};

export type FormattedOutputs = Array<FormattedOutput>;

export type FormattedFee = {
  tokenInfo: Portfolio.Token.Info;
  name: string;
  label: string;
  quantity: Balance.Quantity;
  isPrimary: boolean;
};

export type FormattedTx = {
  inputs: FormattedInputs;
  outputs: FormattedOutputs;
  fee: FormattedFee;
  certificates: FormattedCertificate[] | any;
  // mint: Array<[Portfolio.Token.Info, string]> | null;
  referenceInputs: any;
};

export type FormattedMetadata = {
  hash: string | null;
  metadata: { msg: Array<string> } | null;
};

export type FormattedCertificate = { type: CertificateType; value: unknown };

export const CertificateType = {
  StakeRegistration: 'StakeRegistration', //
  StakeDeregistration: 'StakeDeregistration', //
  StakeDelegation: 'StakeDelegation', //
  PoolRegistration: 'PoolRegistration', //
  PoolRetirement: 'PoolRetirement', //
  GenesisKeyDelegation: 'GenesisKeyDelegation', //
  MoveInstantaneousRewardsCert: 'MoveInstantaneousRewardsCert', //
  CommitteeHotAuth: 'CommitteeHotAuth', //
  CommitteeColdResign: 'CommitteeColdResign', //
  DRepDeregistration: 'DRepDeregistration', //
  DRepRegistration: 'DRepRegistration', //
  DRepUpdate: 'DRepUpdate', //
  VoteDelegation: 'VoteDelegation', //
  StakeAndVoteDelegation: 'StakeAndVoteDelegation', // NO
  StakeRegistrationAndDelegation: 'StakeRegistrationAndDelegation', // NO
  StakeVoteRegistrationAndDelegation: 'StakeVoteRegistrationAndDelegation', // NO
  VoteRegistrationAndDelegation: 'VoteRegistrationAndDelegation', // NO
} as const;

export type CertificateType = (typeof CertificateType)[keyof typeof CertificateType];

export const TransactionResult = {
  SUCCESS: 'success', //
  FAIL: 'fail', //
  CANCEL: 'cancel', //
  NO_CARDANO_RUNNING: 'noCardanoRunning', //
} as const;

export type TransactionResultType = (typeof TransactionResult)[keyof typeof TransactionResult];
