// @flow
import type { CardanoAddressedUtxo } from '../types';
import { verifyFromDerivationRoot } from '../../lib/storage/models/utils';
import type {
  AnchorParams,
  AssetGroup,
  Certificate,
  CredentialParams,
  DeviceOwnedAddress,
  DRepParams,
  SignTransactionRequest,
  Token,
  TxInput,
  TxOutput,
  Withdrawal,
  Witness,
} from '@cardano-foundation/ledgerjs-hw-app-cardano';
import {
  AddressType,
  CertificateType,
  CIP36VoteDelegationType,
  CIP36VoteRegistrationFormat,
  CredentialParamsType,
  DatumType,
  DRepParamsType,
  TransactionSigningMode,
  TxAuxiliaryDataType,
  TxOutputDestinationType,
  TxOutputFormat,
  TxRequiredSignerType,
  VoterType,
  VoteOption,
} from '@cardano-foundation/ledgerjs-hw-app-cardano';
import type { Addressing, Address, Value } from '../../lib/storage/models/PublicDeriver/interfaces';
import type { LedgerNanoCatalystRegistrationTxSignData } from './HaskellShelleyTxSignRequest';
import { RustModule } from '../../lib/cardanoCrypto/rustLoader';
import { WalletTypePurpose, HARD_DERIVATION_START } from '../../../../config/numbersConfig';
import { bytesToHex, forceNonNull, hexToBytes, maybe } from '../../../../coreUtils';
import { transactionHexToHash } from '../../lib/cardanoCrypto/utils';
import { transactionSetTagState } from '../../lib/cardanoCrypto/cmlTransaction';
import { stakePointerFromRawBytes } from '../../lib/cardanoCrypto/cmlAddress';

// ==================== LEDGER ==================== //
function toLedgerTokenBundle(assets: any): Array<AssetGroup> | null {
  if (assets == null || assets.keys().len() === 0) return null;

  const assetGroup: Array<AssetGroup> = [];
  const policies = assets.keys();
  for (let i = 0; i < policies.len(); i++) {
    const policyId = policies.get(i);
    if (policyId == null) throw new Error('Missing policy id');
    const assetsForPolicy = assets.get_assets(policyId);
    const names = assetsForPolicy.keys();
    const tokens: Array<Token> = [];
    for (let j = 0; j < names.len(); j++) {
      const assetName = names.get(j);
      if (assetName == null) throw new Error('Missing asset name');
      const amount = assetsForPolicy.get(assetName);
      if (amount == null) throw new Error('Missing asset amount');
      tokens.push({ assetNameHex: bytesToHex(assetName.to_raw_bytes()), amount: amount.toString() });
    }

    // sort by asset name to the order specified by rfc7049
    tokens.sort((token1, token2) => compareCborKey(token1.assetNameHex, token2.assetNameHex));

    assetGroup.push({ policyIdHex: policyId.to_hex(), tokens });
  }

  // sort by policy id to the order specified by rfc7049
  assetGroup.sort((asset1, asset2) => compareCborKey(asset1.policyIdHex, asset2.policyIdHex));

  return assetGroup;
}

/*
 Compare two hex string keys according to the key order specified by RFC 7049:
  *  If two keys have different lengths, the shorter one sorts
     earlier;

  *  If two keys have the same length, the one with the lower value
     in (byte-wise) lexical order sorts earlier.
*/
function compareCborKey(hex1: string, hex2: string): number {
  if (hex1.length < hex2.length) {
    return -1;
  }
  if (hex1.length > hex2.length) {
    return 1;
  }
  if (hex1 < hex2) {
    return -1;
  }
  if (hex1 > hex2) {
    return 1;
  }
  return 0;
}

function formatLedgerWithdrawals(
  withdrawals: any,
  addressingMap: string => void | { +path: Array<number>, ... }
): Array<Withdrawal> {
  const result = [];

  const rewardAddresses = withdrawals.keys();
  for (let i = 0; i < rewardAddresses.len(); i++) {
    const rewardAddress = rewardAddresses.get(i);
    if (rewardAddress == null) throw new Error('Missing reward address');
    const withdrawalAmount = withdrawals.get(rewardAddress);
    if (withdrawalAmount == null) throw new Error('Missing withdrawal amount');
    const rewardAddressPayload = rewardAddress.to_address().to_hex();
    const addressing = addressingMap(rewardAddressPayload);
    let stakeCredential;
    if (addressing != null) {
      stakeCredential = {
        type: CredentialParamsType.KEY_PATH,
        keyPath: addressing.path,
      };
    } else {
      const cred = rewardAddress.payment();
      const maybeKeyHash = cred.as_pub_key();
      const maybeScriptHash = cred.as_script();
      if (maybeKeyHash) {
        stakeCredential = {
          type: CredentialParamsType.KEY_HASH,
          keyHashHex: maybeKeyHash.to_hex(),
        };
      } else if (maybeScriptHash) {
        stakeCredential = {
          type: CredentialParamsType.SCRIPT_HASH,
          scriptHashHex: maybeScriptHash.to_hex(),
        };
      }
    }
    if (stakeCredential == null) {
      throw new Error('Failed to resolve credential type for reward address: ' + rewardAddressPayload);
    }
    result.push({
      amount: withdrawalAmount.toString(),
      stakeCredential,
    });
  }
  // $FlowIgnore[incompatible-return]
  return result;
}

function wasmCertToAnchor(wasmAnchor: any): ?AnchorParams {
  return wasmAnchor == null
    ? undefined
    : {
        url: wasmAnchor.anchor_url().get(),
        hashHex: wasmAnchor.anchor_doc_hash().to_hex(),
      };
}

function wasmCertToDrep(wasmDrep: any, cml: any): DRepParams {
  switch (wasmDrep.kind()) {
    case cml.DRepKind.Key:
      return {
        type: DRepParamsType.KEY_HASH,
        keyHashHex: forceNonNull(wasmDrep.as_key()).to_hex(),
      };
    case cml.DRepKind.Script:
      return {
        type: DRepParamsType.SCRIPT_HASH,
        scriptHashHex: forceNonNull(wasmDrep.as_script()).to_hex(),
      };
    case cml.DRepKind.AlwaysAbstain:
      return { type: DRepParamsType.ABSTAIN };
    case cml.DRepKind.AlwaysNoConfidence:
      return { type: DRepParamsType.NO_CONFIDENCE };
    default:
      throw new Error('Ledger: Unsupported dRep kind');
  }
}

function formatLedgerCertificates(
  networkId: number,
  certificates: any,
  addressingMap: string => void | { +path: Array<number>, ... },
  cml: any
): Array<Certificate> {
  const getCredential = (credential: any): CredentialParams => ({
    type: CredentialParamsType.KEY_PATH,
    keyPath: getPath(credential),
  });
  const getPath = (credential: any): Array<number> => {
    const rewardAddr = cml.RewardAddress.new(networkId, credential);
    const addressPayload = rewardAddr.to_address().to_hex();
    const addressing = addressingMap(addressPayload);
    if (addressing == null)
      throw new Error(`${nameof(getPath)} Ledger only supports certificates from own address ${addressPayload}`);
    return addressing.path;
  };
  const list = [];
  for (let i = 0; i < certificates.len(); i++) {
    const wasmCertificateWrap = certificates.get(i);
    if (wasmCertificateWrap == null) throw new Error('Missing certificate');
    const kind = wasmCertificateWrap.kind();
    switch (kind) {
      case cml.CertificateKind.StakeRegistration: {
        const cert = forceNonNull(wasmCertificateWrap.as_stake_registration());
        list.push({
          type: CertificateType.STAKE_REGISTRATION,
          params: { stakeCredential: getCredential(cert.stake_credential()) },
        });
        break;
      }
      case cml.CertificateKind.RegCert: {
        const cert = forceNonNull(wasmCertificateWrap.as_reg_cert());
        list.push({
          type: CertificateType.STAKE_REGISTRATION_CONWAY,
          params: { stakeCredential: getCredential(cert.stake_credential()), deposit: cert.deposit().toString() },
        });
        break;
      }
      case cml.CertificateKind.StakeDeregistration: {
        const cert = forceNonNull(wasmCertificateWrap.as_stake_deregistration());
        list.push({
          type: CertificateType.STAKE_DEREGISTRATION,
          params: { stakeCredential: getCredential(cert.stake_credential()) },
        });
        break;
      }
      case cml.CertificateKind.UnregCert: {
        const cert = forceNonNull(wasmCertificateWrap.as_unreg_cert());
        list.push({
          type: CertificateType.STAKE_DEREGISTRATION_CONWAY,
          params: { stakeCredential: getCredential(cert.stake_credential()), deposit: cert.deposit().toString() },
        });
        break;
      }
      case cml.CertificateKind.StakeDelegation: {
        const cert = forceNonNull(wasmCertificateWrap.as_stake_delegation());
        list.push({
          type: CertificateType.STAKE_DELEGATION,
          params: { stakeCredential: getCredential(cert.stake_credential()), poolKeyHashHex: cert.pool().to_hex() },
        });
        break;
      }
      case cml.CertificateKind.VoteDelegCert: {
        const cert = forceNonNull(wasmCertificateWrap.as_vote_deleg_cert());
        list.push({
          type: CertificateType.VOTE_DELEGATION,
          params: { stakeCredential: getCredential(cert.stake_credential()), dRep: wasmCertToDrep(cert.d_rep(), cml) },
        });
        break;
      }
      case cml.CertificateKind.RegDrepCert: {
        const cert = forceNonNull(wasmCertificateWrap.as_reg_drep_cert());
        list.push({
          type: CertificateType.DREP_REGISTRATION,
          params: {
            dRepCredential: getCredential(cert.drep_credential()),
            anchor: wasmCertToAnchor(cert.anchor()),
            deposit: cert.deposit().toString(),
          },
        });
        break;
      }
      case cml.CertificateKind.UpdateDrepCert: {
        const cert = forceNonNull(wasmCertificateWrap.as_update_drep_cert());
        list.push({
          type: CertificateType.DREP_UPDATE,
          params: { dRepCredential: getCredential(cert.drep_credential()), anchor: wasmCertToAnchor(cert.anchor()) },
        });
        break;
      }
      case cml.CertificateKind.UnregDrepCert: {
        const cert = forceNonNull(wasmCertificateWrap.as_unreg_drep_cert());
        list.push({
          type: CertificateType.DREP_DEREGISTRATION,
          params: { dRepCredential: getCredential(cert.drep_credential()), deposit: cert.deposit().toString() },
        });
        break;
      }
      case cml.CertificateKind.StakeVoteDelegCert:
      case cml.CertificateKind.StakeRegDelegCert:
      case cml.CertificateKind.VoteRegDelegCert:
      case cml.CertificateKind.StakeVoteRegDelegCert:
        throw new Error(
          `${nameof(
            formatLedgerCertificates
          )} Ledger doesn't support combinatory certificate types (${kind}), use multiple simple certificates instead!`
        );
      default:
        throw new Error(`${nameof(formatLedgerCertificates)} Ledger doesn't support this certificate type!`);
    }
  }
  return list;
}

export function toLedgerAddressParameters(request: {|
  networkId: number,
  addressHex: string,
  path: Array<number>,
  addressingMap: string => void | $PropertyType<Addressing, 'addressing'>,
|}): DeviceOwnedAddress {
  return RustModule.WasmScope(Module => {
    const cml = Module.CML;
    const address = cml.Address.from_hex(request.addressHex);
    if (cml.ByronAddress.from_address(address) != null) {
      return { type: AddressType.BYRON, params: { spendingPath: request.path } };
    }
    const baseAddr = cml.BaseAddress.from_address(address);
    if (baseAddr != null) {
      const addressPayload = cml.RewardAddress.new(request.networkId, baseAddr.stake()).to_address().to_hex();
      const addressing = request.addressingMap(addressPayload);
      if (addressing == null) {
        const stakeCred = baseAddr.stake();
        const hashInAddress = stakeCred.as_pub_key()?.to_hex() ?? stakeCred.as_script()?.to_hex();
        if (hashInAddress == null) throw new Error(`${nameof(toLedgerAddressParameters)} unknown hash type`);
        return {
          type: AddressType.BASE_PAYMENT_KEY_STAKE_KEY,
          params: { spendingPath: request.path, stakingKeyHashHex: hashInAddress },
        };
      }
      return {
        type: AddressType.BASE_PAYMENT_KEY_STAKE_KEY,
        params: { spendingPath: request.path, stakingPath: addressing.path },
      };
    }
    if (cml.PointerAddress.from_address(address) != null) {
      const [blockIndex, txIndex, certificateIndex] = stakePointerFromRawBytes(address.to_raw_bytes());
      return {
        type: AddressType.POINTER_KEY,
        params: {
          spendingPath: request.path,
          stakingBlockchainPointer: {
            blockIndex: Number(blockIndex),
            txIndex: Number(txIndex),
            certificateIndex: Number(certificateIndex),
          },
        },
      };
    }
    if (cml.EnterpriseAddress.from_address(address) != null) {
      return { type: AddressType.ENTERPRISE_KEY, params: { spendingPath: request.path } };
    }
    if (cml.RewardAddress.from_address(address) != null) {
      return { type: AddressType.REWARD_KEY, params: { stakingPath: request.path } };
    }
    throw new Error(`${nameof(toLedgerAddressParameters)} unknown address type`);
  });
}

type AddressMap = (addressHex: string) => ?Array<number>;

// Convert connector sign tx input into request to Ledger.
// Note this function has some overlaps in functionality with above functions but
// this function is more generic because above functions deal only with Yoroi
// extension "send" transactions.
export function toLedgerSignRequest(
  txBodyHex: string,
  networkId: number,
  protocolMagic: number,
  ownAddressMap: AddressMap,
  // when sending money, `ownAddressMap` doesn't contain the change address, so we need to
  // pass it in explicitly
  changeAddrs: Array<{| ...Address, ...Value, ...Addressing |}>,
  senderUtxos: Array<CardanoAddressedUtxo>,
  additionalRequiredSigners: Array<string> = [],
  ledgerSupportsCip36?: boolean,
  catalystData?: LedgerNanoCatalystRegistrationTxSignData
): SignTransactionRequest {
  return RustModule.WasmScope(Module => {
    const cml = Module.CML;
    const tagsState = transactionSetTagState(txBodyHex);

    if (tagsState === 'mixed') {
      throw new Error('Transaction with mixed sets cannot be signed by Ledger');
    }

    const txHasSetTags = tagsState === 'all';

    const txBody = cml.TransactionBody.from_cbor_hex(txBodyHex);

    function formatInputs(inputs: any): Array<TxInput> {
      const result = [];
      for (let i = 0; i < inputs.len(); i++) {
        const input = inputs.get(i);
        if (input == null) throw new Error('Missing transaction input');
        const txHashHex = input.transaction_id().to_hex();
        const outputIndex = Number(input.index());
        const ownUtxo = senderUtxos.find(utxo => utxo.tx_hash === txHashHex && utxo.tx_index === outputIndex);
        const path = ownUtxo?.addressing.path ?? null;
        result.push({ txHashHex, outputIndex, path });
      }
      return result;
    }

    function formatOutput(output: any): TxOutput {
      const outputBytes = output.to_cbor_bytes();
      const isPostAlonzoTransactionOutput = (outputBytes[0] & 0xe0) === 0xa0;

      const addr = output.address();
      let destination;

      // Yoroi doesn't have Byron addresses or pointer addresses.
      // If the address is one of these, it's not a wallet address.
      const byronAddr = cml.ByronAddress.from_address(addr);
      const pointerAddr = cml.PointerAddress.from_address(addr);
      if (byronAddr || pointerAddr) {
        destination = {
          type: TxOutputDestinationType.THIRD_PARTY,
          params: {
            addressHex: addr.to_hex(),
          },
        };
      }

      const enterpriseAddr = cml.EnterpriseAddress.from_address(addr);
      if (enterpriseAddr) {
        const ownAddressPath = ownAddressMap(addr.to_hex());
        if (ownAddressPath) {
          destination = {
            type: TxOutputDestinationType.DEVICE_OWNED,
            params: {
              type: AddressType.ENTERPRISE_KEY,
              params: {
                spendingPath: ownAddressPath,
              },
            },
          };
        } else {
          destination = {
            type: TxOutputDestinationType.THIRD_PARTY,
            params: {
              addressHex: addr.to_hex(),
            },
          };
        }
      }

      const baseAddr = cml.BaseAddress.from_address(addr);
      if (baseAddr) {
        const paymentAddress = cml.EnterpriseAddress.new(networkId, baseAddr.payment()).to_address().to_hex();
        const ownPaymentPath =
          ownAddressMap(paymentAddress) || changeAddrs.find(({ address }) => address === addr.to_hex())?.addressing.path;
        if (ownPaymentPath) {
          const stake = baseAddr.stake();
          const stakeAddr = cml.RewardAddress.new(networkId, stake).to_address().to_hex();
          const ownStakePath = ownAddressMap(stakeAddr);
          if (ownStakePath) {
            // stake address is ours
            destination = {
              type: TxOutputDestinationType.DEVICE_OWNED,
              params: {
                type: AddressType.BASE_PAYMENT_KEY_STAKE_KEY,
                params: {
                  spendingPath: ownPaymentPath,
                  stakingPath: ownStakePath,
                },
              },
            };
          } else {
            const keyHash = stake.as_pub_key();
            const scriptHash = stake.as_script();
            if (keyHash) {
              // stake address is foreign key hash
              destination = {
                type: TxOutputDestinationType.DEVICE_OWNED,
                params: {
                  type: AddressType.BASE_PAYMENT_KEY_STAKE_KEY,
                  params: {
                    spendingPath: ownPaymentPath,
                    stakingKeyHashHex: keyHash.to_hex(),
                  },
                },
              };
            } else if (scriptHash) {
              // stake address is script hash
              destination = {
                type: TxOutputDestinationType.DEVICE_OWNED,
                params: {
                  type: AddressType.BASE_PAYMENT_KEY_STAKE_SCRIPT,
                  params: {
                    spendingPath: ownPaymentPath,
                    stakingScriptHashHex: scriptHash.to_hex(),
                  },
                },
              };
            } else {
              throw new Error('unexpected stake credential type in base address');
            }
          }
          // not having BASE_PAYMENT_SCRIPT_ because payment script is
          // treated as third party address
        } else {
          // payment address is not ours
          destination = {
            type: TxOutputDestinationType.THIRD_PARTY,
            params: {
              addressHex: addr.to_hex(),
            },
          };
        }
      }

      // we do not allow payment to RewardAddresses
      if (!destination) {
        throw new Error('not expecting to pay to reward address');
      }

      const amount = output.amount().coin().toString();
      const tokenBundle = toLedgerTokenBundle(output.amount().multi_asset());
      const outputDataHash = output.datum_hash();
      const plutusData = output.datum()?.as_datum();
      const scriptRef = output.script_ref();

      if (isPostAlonzoTransactionOutput || scriptRef || plutusData) {
        let datum = null;
        if (plutusData) {
          datum = {
            type: DatumType.INLINE,
            datumHex: plutusData.to_cbor_hex(),
          };
        } else if (outputDataHash) {
          datum = {
            type: DatumType.HASH,
            datumHashHex: outputDataHash.to_hex(),
          };
        }
        return {
          format: TxOutputFormat.MAP_BABBAGE,
          amount,
          destination,
          tokenBundle,
          datum,
          referenceScriptHex: scriptRef ? scriptRef.to_cbor_hex() : null,
        };
      }

      return {
        format: TxOutputFormat.ARRAY_LEGACY,
        amount,
        destination,
        tokenBundle,
        datumHashHex: outputDataHash ? outputDataHash.to_hex() : null,
      };
    }

    const outputList = txBody.outputs();
    const outputs = [];
    for (let i = 0; i < outputList.len(); i++) {
      const output = outputList.get(i);
      if (output == null) throw new Error('Missing transaction output');
      outputs.push(formatOutput(output));
    }

    const additionalWitnessPaths = [];
    const formattedRequiredSigners = [];
    function hashHexToOwnAddressPath(hashHex: string): ?Array<number> {
      const hash = cml.Ed25519KeyHash.from_hex(hashHex);
      const enterpriseAddress = cml.EnterpriseAddress.new(networkId, cml.Credential.new_pub_key(hash)).to_address().to_hex();
      const stakeAddress = cml.RewardAddress.new(networkId, cml.Credential.new_pub_key(hash)).to_address().to_hex();
      return ownAddressMap(enterpriseAddress) || ownAddressMap(stakeAddress);
    }

    const requiredSigners = txBody.required_signers();
    const seenRequiredSignerHashes = new Set();
    if (requiredSigners)
      for (let i = 0; i < requiredSigners.len(); i++) {
        const signer = requiredSigners.get(i);
        if (!signer) continue;
        const hashHex = signer.to_hex();
        if (seenRequiredSignerHashes.has(hashHex)) continue;
        seenRequiredSignerHashes.add(hashHex);
        const ownAddressPath = hashHexToOwnAddressPath(hashHex);
        if (ownAddressPath != null) {
          formattedRequiredSigners.push({
            type: TxRequiredSignerType.PATH,
            path: ownAddressPath,
          });
          additionalWitnessPaths.push(ownAddressPath);
        } else {
          formattedRequiredSigners.push({
            type: TxRequiredSignerType.HASH,
            hashHex,
          });
        }
      }

    for (const additionalHashHex of additionalRequiredSigners || []) {
      if (seenRequiredSignerHashes.has(additionalHashHex)) continue;
      seenRequiredSignerHashes.add(additionalHashHex);
      const ownAddressPath = hashHexToOwnAddressPath(additionalHashHex);
      if (ownAddressPath != null) {
        additionalWitnessPaths.push(ownAddressPath);
      }
    }

    function addressingMap(addr: string): void | {| +path: Array<number> |} {
      const path = ownAddressMap(addr);
      if (path) {
        return { path };
      }
      return undefined;
    }

    let formattedCertificates = null;
    const certificates = txBody.certs();
    if (certificates) {
      formattedCertificates = formatLedgerCertificates(networkId, certificates, addressingMap, cml);
    }

    let formattedWithdrawals = null;
    const withdrawals = txBody.withdrawals();
    if (withdrawals) {
      formattedWithdrawals = formatLedgerWithdrawals(withdrawals, addressingMap);
    }

    let formattedAuxiliaryData = null;
    const auxiliaryDataHash = txBody.auxiliary_data_hash();
    if (auxiliaryDataHash) {
      formattedAuxiliaryData = {
        type: TxAuxiliaryDataType.ARBITRARY_HASH,
        params: {
          hashHex: auxiliaryDataHash.to_hex(),
        },
      };
    }

    // note: we know that `catelystData` is only used for voting in the extension and there
    // should be no other auxiliary data in this scenario so we just overwrite the auxiliary data
    if (catalystData) {
      const { votingPublicKey, stakingKeyPath, nonce, paymentKeyPath } = catalystData;

      if (ledgerSupportsCip36) {
        formattedAuxiliaryData = {
          type: TxAuxiliaryDataType.CIP36_REGISTRATION,
          params: {
            format: CIP36VoteRegistrationFormat.CIP_36,
            delegations: [
              {
                type: CIP36VoteDelegationType.KEY,
                voteKeyHex: votingPublicKey.replace(/^0x/, ''),
                weight: 1,
              },
            ],
            stakingPath: stakingKeyPath,
            paymentDestination: {
              type: TxOutputDestinationType.DEVICE_OWNED,
              params: {
                type: AddressType.BASE_PAYMENT_KEY_STAKE_KEY,
                params: {
                  spendingPath: paymentKeyPath,
                  stakingPath: stakingKeyPath,
                },
              },
            },
            nonce,
            votingPurpose: 0,
          },
        };
      } else {
        formattedAuxiliaryData = {
          type: TxAuxiliaryDataType.CIP36_REGISTRATION,
          params: {
            format: CIP36VoteRegistrationFormat.CIP_15,
            voteKeyHex: votingPublicKey.replace(/^0x/, ''),
            stakingPath: stakingKeyPath,
            paymentDestination: {
              type: TxOutputDestinationType.DEVICE_OWNED,
              params: {
                type: AddressType.BASE_PAYMENT_KEY_STAKE_KEY,
                params: {
                  spendingPath: paymentKeyPath,
                  stakingPath: stakingKeyPath,
                },
              },
            },
            nonce,
          },
        };
      }
    }

    let formattedCollateral = null;
    const collateral = txBody.collateral_inputs();
    if (collateral) {
      formattedCollateral = formatInputs(collateral);
    }

    const formattedCollateralReturn = maybe(txBody.collateral_return(), formatOutput);

    let formattedReferenceInputs = null;
    const referenceInputs = txBody.reference_inputs();
    if (referenceInputs) {
      formattedReferenceInputs = formatInputs(referenceInputs);
    }

    let formattedVotingProcedures = null;
    const votingProcedures = txBody.voting_procedures();
    if (votingProcedures) {
      formattedVotingProcedures = [];
      const voters = votingProcedures.keys();
      for (let i = 0; i < voters.len(); i++) {
        const voter = voters.get(i);
        if (!voter) {
          throw new Error('unexpectedly missing voter');
        }
        let formattedVoter;

        const dRepKeyHash = voter.as_d_rep_key_hash();
        if (dRepKeyHash) {
          formattedVoter = {
            type: VoterType.DREP_KEY_PATH,
            // fixme
            keyPath: [1852 + HARD_DERIVATION_START, 1815 + HARD_DERIVATION_START, 0 + HARD_DERIVATION_START, 3, 0],
          };
        }
        const dRepScriptHash = voter.as_d_rep_script_hash();
        if (dRepScriptHash) {
          formattedVoter = {
            type: VoterType.DREP_SCRIPT_HASH,
            scriptHashHex: dRepScriptHash.to_hex(),
          };
        }
        const stakePoolKeyHash = voter.as_staking_pool_key_hash();
        if (stakePoolKeyHash) {
          // todo: support key path for friendly UI
          formattedVoter = {
            type: VoterType.STAKE_POOL_KEY_HASH,
            keyHashHex: stakePoolKeyHash.to_hex(),
          };
        }
        // don't support cc hot credential for now

        if (!formattedVoter) {
          throw new Error('unexpected voter');
        }
        formattedVotingProcedures.push({
          voter: formattedVoter,
          votes: [],
        });
        const proceduresByAction = votingProcedures.get(voter);
        if (!proceduresByAction) {
          throw new Error('unexpectedly missing voting procedures for voter');
        }
        const govActionIds = proceduresByAction.keys();
        for (let j = 0; j < govActionIds.len(); j++) {
          const govActionId = govActionIds.get(j);
          if (!govActionId) {
            throw new Error('unexpectedly missing gov action id');
          }
          const votingProcedure = proceduresByAction.get(govActionId);
          if (!votingProcedure) {
            throw new Error('unexpectedly missing voting procedure');
          }
          const voteKind = votingProcedure.vote();
          let formattedVoteKind;
          if (voteKind === 0) {
            formattedVoteKind = VoteOption.NO;
          } else if (voteKind === 1) {
            formattedVoteKind = VoteOption.YES;
          } else if (voteKind === 2) {
            formattedVoteKind = VoteOption.ABSTAIN;
          } else {
            throw new Error(`unexpected vote kind ${voteKind}`);
          }
          const anchor = votingProcedure.anchor();

          formattedVotingProcedures[formattedVotingProcedures.length - 1].votes.push({
            govActionId: {
              txHashHex: govActionId.transaction_id().to_hex(),
              govActionIndex: Number(govActionId.gov_action_index().toString()),
            },
            votingProcedure: {
              vote: formattedVoteKind,
              anchor: anchor
                ? {
                    url: anchor.anchor_url().get(),
                    hashHex: anchor.anchor_doc_hash().to_hex(),
                  }
                : null,
            },
          });
        }
      }
    }

    let signingMode = TransactionSigningMode.ORDINARY_TRANSACTION;
    if (formattedCollateral || formattedReferenceInputs) {
      signingMode = TransactionSigningMode.PLUTUS_TRANSACTION;
    }

    return {
      signingMode,
      tx: {
        network: {
          networkId,
          protocolMagic,
        },
        inputs: formatInputs(txBody.inputs()),
        outputs,
        fee: txBody.fee().toString(),
        ttl: txBody.ttl()?.toString() ?? null,
        validityIntervalStart: txBody.validity_interval_start()?.toString() ?? null,
        certificates: formattedCertificates,
        withdrawals: formattedWithdrawals,
        auxiliaryData: formattedAuxiliaryData,
        mint: toLedgerTokenBundle(txBody.mint()),
        scriptDataHashHex: txBody.script_data_hash()?.to_hex() ?? null,
        collateralInputs: formattedCollateral,
        requiredSigners: formattedRequiredSigners.length > 0 ? formattedRequiredSigners : null,
        includeNetworkId: txBody.network_id() != null,
        collateralOutput: formattedCollateralReturn,
        totalCollateral: txBody.total_collateral()?.toString() ?? null,
        referenceInputs: formattedReferenceInputs,
        votingProcedures: formattedVotingProcedures,
      },
      additionalWitnessPaths,
      options: {
        tagCborSets: txHasSetTags,
      },
    };
  });
}

export function buildConnectorSignedTransaction(
  rawTxHex: string,
  witnesses: Array<Witness>,
  publicKey: {|
    ...Addressing,
    key: RustModule.CML.Bip32PublicKey,
  |},
  metadata: ?Uint8Array,
  // to support transfering from Byron address when initializing Ledger wallets
  pathToReceiverMapping: Map<string, string> = new Map()
): {| txHex: string, txId: string |} {
  const keyLevel = publicKey.addressing.startLevel + publicKey.addressing.path.length - 1;
  const txHex = RustModule.WasmScope(Module => {
    const cml = Module.CML;
    const publicKeyBytes =
      typeof (publicKey.key: any).to_raw_bytes === 'function'
        ? (publicKey.key: any).to_raw_bytes()
        : (publicKey.key: any).as_bytes();
    const rootPublicKey = cml.Bip32PublicKey.from_raw_bytes(publicKeyBytes);
    const tx = cml.Transaction.from_cbor_hex(rawTxHex);
    const body = tx.body();
    const auxiliaryData = metadata == null ? tx.auxiliary_data() : cml.AuxiliaryData.from_cbor_bytes(metadata);
    if (metadata != null) body.set_auxiliary_data_hash(cml.hash_auxiliary_data(auxiliaryData));
    const witnessSet = tx.witness_set();
    const vkeyWitnesses = witnessSet.vkeywitnesses() ?? cml.VkeywitnessList.new();
    const bootstrapWitnesses = witnessSet.bootstrap_witnesses() ?? cml.BootstrapWitnessList.new();

    for (const witness of witnesses) {
      const addressing = { path: witness.path, startLevel: 1 };
      verifyFromDerivationRoot(addressing);
      const firstPathIndex = keyLevel - addressing.startLevel + 1;
      if (firstPathIndex < 0) throw new Error('Public key derivation level is before the addressing start level');
      let witnessKey = rootPublicKey;
      for (let i = firstPathIndex; i < addressing.path.length; i++) {
        const index = addressing.path[i];
        if (index == null) throw new Error('Invalid public key derivation path');
        witnessKey = witnessKey.derive(index);
      }
      const witnessPublicKey = cml.PublicKey.from_bytes(witnessKey.to_raw_key().to_raw_bytes());
      const signature = cml.Ed25519Signature.from_raw_bytes(hexToBytes(witness.witnessSignatureHex));

      if (witness.path[0] === WalletTypePurpose.BIP44) {
        const receiver = pathToReceiverMapping.get(witness.path.join('/'));
        if (!receiver) continue;
        const byronAddress = cml.ByronAddress.from_base58(receiver);
        bootstrapWitnesses.add(
          cml.BootstrapWitness.new(witnessPublicKey, signature, witnessKey.chaincode(), byronAddress.content().addr_attributes())
        );
      } else if (witness.path[0] === WalletTypePurpose.CIP1852) {
        vkeyWitnesses.add(cml.Vkeywitness.new(witnessPublicKey, signature));
      } else {
        throw new Error(`unexpected witness path purpose value ${witness.path[0]}`);
      }
    }

    if (vkeyWitnesses.len() > 0) witnessSet.set_vkeywitnesses(vkeyWitnesses);
    if (bootstrapWitnesses.len() > 0) witnessSet.set_bootstrap_witnesses(bootstrapWitnesses);
    return cml.Transaction.new(body, witnessSet, tx.is_valid(), auxiliaryData).to_cbor_hex();
  });
  return { txHex, txId: transactionHexToHash(txHex) };
}
