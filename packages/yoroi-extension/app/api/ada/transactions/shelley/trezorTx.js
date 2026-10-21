// @flow
import type { CardanoAddressedUtxo } from '../types';
import { toDerivationPathString } from '../../lib/cardanoCrypto/keys/path';
import type {
  CardanoAddressParameters,
  CardanoAssetGroup,
  CardanoCertificate,
  CardanoInput,
  CardanoOutput,
  CardanoSignedTxWitness,
  CardanoSignTransaction,
  CardanoToken,
} from 'trezor-connect-flow/index';
import {
  CardanoAddressType,
  CardanoCertificateType,
  CardanoGovernanceRegistrationFormat,
  CardanoTxOutputSerializationFormat,
  CardanoTxSigningMode,
  CardanoTxWitnessType,
  CardanoDRepType,
} from 'trezor-connect-flow';
import type { Addressing, Address, Value } from '../../lib/storage/models/PublicDeriver/interfaces';
import type { TrezorTCatalystRegistrationTxSignData } from './HaskellShelleyTxSignRequest';
import { RustModule } from '../../lib/cardanoCrypto/rustLoader';
import { iterateLenGet, forceNonNull, hexToBytes } from '../../../../coreUtils';
import { transactionHexToHash } from '../../lib/cardanoCrypto/utils';
import { transactionSetTagState } from '../../lib/cardanoCrypto/cmlTransaction';
import { stakePointerFromRawBytes } from '../../lib/cardanoCrypto/cmlAddress';

// ==================== TREZOR ==================== //

function formatTrezorCertificates(
  cml: typeof RustModule.CML,
  certificates: RustModule.CML.CertificateList,
  getPath: (stakeCredential: RustModule.CML.Credential) => Array<number>
): Array<CardanoCertificate> {
  const result = [];
  for (const cert of iterateLenGet(certificates)) {
    const registrationCert = cert.as_stake_registration();
    if (registrationCert != null) {
      result.push({
        type: CardanoCertificateType.STAKE_REGISTRATION,
        path: getPath(registrationCert.stake_credential()),
      });
      continue;
    }
    const deregistrationCert = cert.as_stake_deregistration();
    if (deregistrationCert != null) {
      result.push({
        type: CardanoCertificateType.STAKE_DEREGISTRATION,
        path: getPath(deregistrationCert.stake_credential()),
      });
      continue;
    }
    const delegationCert = cert.as_stake_delegation();
    if (delegationCert != null) {
      result.push({
        type: CardanoCertificateType.STAKE_DELEGATION,
        path: getPath(delegationCert.stake_credential()),
        pool: delegationCert.pool().to_hex(),
      });
      continue;
    }
    const voteDelegation = cert.as_vote_deleg_cert();
    if (voteDelegation != null) {
      const wasmDrep = voteDelegation.d_rep();
      let dRep;
      switch (wasmDrep.kind()) {
        case cml.DRepKind.Key:
          dRep = {
            type: CardanoDRepType.KEY_HASH,
            keyHash: forceNonNull(wasmDrep.as_key()).to_hex(),
          };
          break;
        case cml.DRepKind.Script:
          dRep = {
            type: CardanoDRepType.SCRIPT_HASH,
            scriptHash: forceNonNull(wasmDrep.as_script()).to_hex(),
          };
          break;
        case cml.DRepKind.AlwaysAbstain:
          dRep = {
            type: CardanoDRepType.ABSTAIN,
          };
          break;
        case cml.DRepKind.AlwaysNoConfidence:
          dRep = {
            type: CardanoDRepType.NO_CONFIDENCE,
          };
          break;
        default:
          throw new Error('Trezor: Unsupported dRep kind: ' + wasmDrep.kind());
      }
      result.push({
        type: CardanoCertificateType.VOTE_DELEGATION,
        dRep,
        path: getPath(voteDelegation.stake_credential()),
      });
      continue;
    }
    // TODO: @trezor/connect-web 9.4.2 hasn't supported dRep (de)registration and update
    throw new Error(`${nameof(formatTrezorCertificates)} Trezor doesn't support this certificate type`);
  }
  return result;
}

function toTrezorTokenBundle(
  cml: typeof RustModule.CML,
  assets: ?RustModule.CML.MultiAsset
): {|
  tokenBundle?: Array<CardanoAssetGroup>,
|} {
  if (assets == null || assets.policy_count() === 0) return Object.freeze({});

  const tokenBundle: Array<CardanoAssetGroup> = [];
  for (const policyId of iterateLenGet(assets.keys())) {
    const assetsForPolicy = assets.get_assets(policyId);
    if (assetsForPolicy == null) continue;
    const tokenAmounts: Array<CardanoToken> = [];
    for (const assetName of iterateLenGet(assetsForPolicy.keys())) {
      const amount = assetsForPolicy.get(assetName);
      if (amount == null) continue;
      tokenAmounts.push({ assetNameBytes: assetName.to_hex(), amount: amount.toString() });
    }
    tokenBundle.push({ policyId: policyId.to_hex(), tokenAmounts });
  }

  return { tokenBundle };
}

export function toTrezorAddressParameters(addressHex: string, path: Array<number>): CardanoAddressParameters {
  return RustModule.WasmScope(Module => {
    const cml = Module.CML;
    const address = cml.Address.from_hex(addressHex);
    const pathString = toDerivationPathString(path);
    if (cml.ByronAddress.from_address(address) != null) {
      return { addressType: CardanoAddressType.BYRON, path: pathString };
    }
    const baseAddr = cml.BaseAddress.from_address(address);
    if (baseAddr != null) {
      const stakeCred = baseAddr.stake();
      const hash = stakeCred.as_pub_key()?.to_hex() ?? stakeCred.as_script()?.to_hex();
      if (hash == null) throw new Error(`${nameof(toTrezorAddressParameters)} unknown hash type`);
      return {
        addressType: CardanoAddressType.BASE,
        path: pathString,
        // can't always know staking key path since address may not belong to the wallet
        // (mangled address)
        stakingKeyHash: hash,
      };
    }
    const ptrAddr = cml.PointerAddress.from_address(address);
    if (ptrAddr != null) {
      const [blockIndex, txIndex, certificateIndex] = stakePointerFromRawBytes(address.to_raw_bytes());
      return {
        addressType: CardanoAddressType.POINTER,
        path: pathString,
        certificatePointer: {
          blockIndex: Number(blockIndex),
          txIndex: Number(txIndex),
          certificateIndex: Number(certificateIndex),
        },
      };
    }
    if (cml.EnterpriseAddress.from_address(address) != null) {
      return { addressType: CardanoAddressType.ENTERPRISE, path: pathString };
    }
    if (cml.RewardAddress.from_address(address) != null) {
      return { addressType: CardanoAddressType.REWARD, path: pathString };
    }
    throw new Error(`${nameof(toTrezorAddressParameters)} unknown address type`);
  });
}

type AddressMap = (addressHex: string) => ?Array<number>;

// Convert connector sign tx input into request to Trezor.
// Note this function has some overlaps in functionality with above functions but
// this function is more generic because above functions deal only with Yoroi
// extension "send" transactions.
export function toTrezorSignRequest(
  txBodyHex: string,
  networkId: number,
  protocolMagic: number,
  ownAddressMap: AddressMap,
  // when sending money, `ownAddressMap` doesn't contain the change address, so we need to
  // pass it in explicitly
  changeAddrs: Array<{| ...Address, ...Value, ...Addressing |}>,
  senderUtxos: Array<CardanoAddressedUtxo>,
  catalystData?: TrezorTCatalystRegistrationTxSignData
): $Exact<CardanoSignTransaction> {
  const tagsState = transactionSetTagState(txBodyHex);

  if (tagsState === 'mixed') {
    throw new Error('Transaction with mixed sets cannot be signed by Ledger');
  }

  const txHasSetTags = tagsState === 'all';

  return RustModule.WasmScope(Module => {
    const cml = Module.CML;
    const txBody = cml.TransactionBody.from_cbor_hex(txBodyHex);

    function formatInputs(inputs: RustModule.CML.TransactionInputList): Array<CardanoInput> {
      const formatted = [];
      for (const input of iterateLenGet(inputs)) {
        const hash = input.transaction_id().to_hex();
        const index = Number(input.index());
        const ownUtxo = senderUtxos.find(utxo => utxo.tx_hash === hash && utxo.tx_index === index);
        const cardanoInput: CardanoInput = {
          prev_hash: hash,
          prev_index: index,
        };
        if (ownUtxo) {
          cardanoInput.path = ownUtxo.addressing.path;
        }
        formatted.push(cardanoInput);
      }
      return formatted;
    }

    function formatOutput(output: RustModule.CML.TransactionOutput): CardanoOutput {
      const encodedOutput = output.to_cbor_bytes();
      const isPostAlonzoTransactionOutput = encodedOutput.length > 0 && (encodedOutput[0] & 0xe0) === 0xa0;

      const amount = output.amount().coin().toString();
      const { tokenBundle } = toTrezorTokenBundle(cml, output.amount().multi_asset());
      const outputDataHash = output.datum_hash();

      const addr = output.address();
      let result;
      // Yoroi doesn't have Byron addresses or pointer addresses.
      // If the address is one of these, it's not a wallet address.
      const byronAddr = cml.ByronAddress.from_address(addr);
      const pointerAddr = cml.PointerAddress.from_address(addr);
      if (byronAddr || pointerAddr) {
        result = ({
          address: addr.to_bech32(),
          amount,
        }: CardanoOutput);
      }

      const enterpriseAddr = cml.EnterpriseAddress.from_address(addr);
      if (enterpriseAddr) {
        const ownAddressPath = ownAddressMap(addr.to_hex());
        if (ownAddressPath) {
          result = ({
            addressParameters: {
              addressType: CardanoAddressType.ENTERPRISE,
              path: ownAddressPath,
            },
            amount,
          }: CardanoOutput);
        } else {
          result = ({
            address: addr.to_bech32(),
            amount,
          }: CardanoOutput);
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
            result = ({
              addressParameters: {
                addressType: CardanoAddressType.BASE,
                path: ownPaymentPath,
                stakingPath: ownStakePath,
              },
              amount,
            }: CardanoOutput);
          } else {
            const keyHash = stake.as_pub_key();
            const scriptHash = stake.as_script();
            if (keyHash) {
              // stake address is foreign key hash
              result = ({
                addressParameters: {
                  addressType: CardanoAddressType.BASE,
                  path: ownPaymentPath,
                  stakingKeyHash: keyHash.to_hex(),
                },
                amount,
              }: CardanoOutput);
            } else if (scriptHash) {
              // stake address is script hash
              result = ({
                addressParameters: {
                  addressType: CardanoAddressType.BASE,
                  path: ownPaymentPath,
                  stakingScriptHash: scriptHash.to_hex(),
                },
                amount,
              }: CardanoOutput);
            } else {
              throw new Error('unexpected stake credential type in base address');
            }
          }
          // not having BASE_PAYMENT_SCRIPT_ because payment script is
          // treated as third party address
        } else {
          // payment address is not ours
          result = ({
            address: addr.to_bech32(),
            amount,
          }: CardanoOutput);
        }
      }

      // we do not allow payment to RewardAddresses
      if (!result) {
        throw new Error('not expecting to pay to reward address');
      }
      if (tokenBundle) {
        result.tokenBundle = tokenBundle;
      }
      if (outputDataHash) {
        result.datumHash = outputDataHash.to_hex();
      }

      if (isPostAlonzoTransactionOutput) {
        result.format = CardanoTxOutputSerializationFormat.MAP_BABBAGE;
      }

      const inlineDatum = output.datum()?.as_datum();
      if (inlineDatum) {
        result.inlineDatum = inlineDatum.to_cbor_hex();
        result.format = CardanoTxOutputSerializationFormat.MAP_BABBAGE;
      }

      const refScript = output.script_ref();
      if (refScript) {
        result.referenceScript = refScript.to_cbor_hex();
        result.format = CardanoTxOutputSerializationFormat.MAP_BABBAGE;
      }

      return result;
    }

    const outputs = iterateLenGet(txBody.outputs()).map(formatOutput).toArray();

    const formattedRequiredSigners = [];
    const additionalWitnessRequests = [];
    const requiredSigners = txBody.required_signers();
    if (requiredSigners) {
      for (const hash of iterateLenGet(requiredSigners)) {
        const credential = cml.Credential.new_pub_key(hash);
        const enterpriseAddress = cml.EnterpriseAddress.new(networkId, credential).to_address().to_hex();
        const stakeAddress = cml.RewardAddress.new(networkId, credential).to_address().to_hex();
        const ownAddressPath = ownAddressMap(enterpriseAddress) || ownAddressMap(stakeAddress);
        if (ownAddressPath) {
          formattedRequiredSigners.push({
            keyPath: ownAddressPath,
          });
          additionalWitnessRequests.push(ownAddressPath);
        } else {
          formattedRequiredSigners.push({
            keyHash: hash.to_hex(),
          });
        }
      }
    }

    let formattedCertificates = null;
    const certificates = txBody.certs();
    if (certificates) {
      const getPath = (stakeCredential: RustModule.CML.Credential): Array<number> => {
        const rewardAddr = cml.RewardAddress.new(networkId, stakeCredential);
        const addressPayload = rewardAddr.to_address().to_hex();
        const addressing = ownAddressMap(addressPayload);
        if (addressing == null) {
          throw new Error('not own address in certificate');
        }
        return addressing;
      };
      formattedCertificates = formatTrezorCertificates(cml, certificates, getPath);
    }

    let formattedWithdrawals = null;
    const withdrawals = txBody.withdrawals();
    if (withdrawals) {
      const result = [];

      for (const rewardAddress of iterateLenGet(withdrawals.keys())) {
        const withdrawalAmount = withdrawals.get(rewardAddress);
        if (withdrawalAmount == null) continue;
        const rewardAddressPayload = rewardAddress.to_address().to_hex();
        const path = ownAddressMap(rewardAddressPayload);
        if (path == null) {
          throw new Error('foreign withdrawal reward address');
        }
        result.push({
          amount: withdrawalAmount.toString(),
          path,
        });
      }
      formattedWithdrawals = result;
    }

    let formattedAuxiliaryData = null;
    const auxiliaryDataHash = txBody.auxiliary_data_hash();
    if (auxiliaryDataHash) {
      formattedAuxiliaryData = {
        hash: auxiliaryDataHash.to_hex(),
      };
    }

    // note: we know that `catelystData` is only used for voting in the extension and there
    // should be no other auxiliary data in this scenario so we just overwrite the auxiliary data
    if (catalystData) {
      const { votingPublicKey, nonce, paymentKeyPath, stakingKeyPath } = catalystData;
      formattedAuxiliaryData = {
        cVoteRegistrationParameters: {
          delegations: [
            {
              votePublicKey: votingPublicKey.replace(/^0x/, ''),
              weight: 1,
            },
          ],
          stakingPath: stakingKeyPath,
          paymentAddressParameters: {
            addressType: CardanoAddressType.BASE,
            path: paymentKeyPath,
            stakingPath: stakingKeyPath,
          },
          nonce: String(nonce),
          format: CardanoGovernanceRegistrationFormat.CIP36,
          votingPurpose: 0,
        },
      };
    }

    let formattedCollateral = null;
    const collateral = txBody.collateral_inputs();
    if (collateral) {
      formattedCollateral = formatInputs(collateral);
    }

    const mint = txBody.mint();
    const formattedMint =
      mint == null
        ? null
        : iterateLenGet(mint.keys())
            .map(policyId => {
              const assets = mint.get_assets(policyId);
              if (assets == null) throw new Error('Missing mint assets');
              return {
                policyId: policyId.to_hex(),
                tokenAmounts: iterateLenGet(assets.keys())
                  .map(assetName => {
                    const amount = assets.get(assetName);
                    if (amount == null) throw new Error('Missing mint amount');
                    return {
                      assetNameBytes: assetName.to_hex(),
                      mintAmount: amount.toString(),
                    };
                  })
                  .toArray(),
              };
            })
            .toArray();

    const scriptDataHash = txBody.script_data_hash()?.to_hex();

    const result: $Exact<CardanoSignTransaction> = {
      signingMode: CardanoTxSigningMode.ORDINARY_TRANSACTION,
      inputs: formatInputs(txBody.inputs()),
      outputs,
      fee: txBody.fee().toString(),
      protocolMagic,
      networkId,
      includeNetworkId: txBody.network_id() != null,
    };

    const ttl = txBody.ttl()?.toString();
    const validityIntervalStart = txBody.validity_interval_start()?.toString();

    if (ttl) {
      result.ttl = ttl;
    }
    if (validityIntervalStart) {
      result.validityIntervalStart = validityIntervalStart;
    }
    if (formattedCertificates) {
      result.certificates = formattedCertificates;
    }
    if (formattedWithdrawals) {
      result.withdrawals = formattedWithdrawals;
    }
    if (formattedAuxiliaryData) {
      result.auxiliaryData = formattedAuxiliaryData;
    }
    if (formattedMint) {
      result.mint = formattedMint;
    }
    if (scriptDataHash) {
      result.scriptDataHash = scriptDataHash;
    }
    if (formattedCollateral) {
      result.collateralInputs = formattedCollateral;
    }
    if (requiredSigners) {
      result.requiredSigners = formattedRequiredSigners;
    }
    const collateralReturn = txBody.collateral_return();
    if (collateralReturn) {
      result.collateralReturn = formatOutput(collateralReturn);
    }
    const totalCollateral = txBody.total_collateral();
    if (totalCollateral) {
      result.totalCollateral = totalCollateral.toString();
    }
    const referenceInputs = txBody.reference_inputs();
    if (referenceInputs) {
      const formattedReferenceInputs = [];
      for (const input of iterateLenGet(referenceInputs)) {
        formattedReferenceInputs.push({
          prev_hash: input.transaction_id().to_hex(),
          prev_index: input.index(),
        });
      }
      result.referenceInputs = formattedReferenceInputs;
    }
    if (additionalWitnessRequests.length > 0) {
      result.additionalWitnessRequests = additionalWitnessRequests;
    }
    if (txHasSetTags) {
      result.tagCborSets = true;
    }

    if (formattedCollateral || referenceInputs) {
      result.signingMode = CardanoTxSigningMode.PLUTUS_TRANSACTION;
    }
    return result;
  });
}

export function buildConnectorSignedTransaction(
  rawTxHex: string,
  witnesses: Array<CardanoSignedTxWitness>,
  metadata: ?Uint8Array
): {| txHex: string, txId: string |} {
  const txHex = RustModule.WasmScope(Module => {
    const cml = Module.CML;
    const tx = cml.Transaction.from_cbor_hex(rawTxHex);
    const body = tx.body();
    const auxiliaryData = metadata == null ? tx.auxiliary_data() : cml.AuxiliaryData.from_cbor_bytes(metadata);
    if (metadata != null) body.set_auxiliary_data_hash(cml.hash_auxiliary_data(auxiliaryData));
    const witnessSet = tx.witness_set();
    const vkeyWitnesses = witnessSet.vkeywitnesses() ?? cml.VkeywitnessList.new();

    for (const witness of witnesses) {
      if (witness.type === CardanoTxWitnessType.BYRON_WITNESS) {
        throw new Error('Byron wallet does not support connector API');
      } else if (witness.type === CardanoTxWitnessType.SHELLEY_WITNESS) {
        const vkey = cml.PublicKey.from_bytes(hexToBytes(witness.pubKey));
        const signature = cml.Ed25519Signature.from_raw_bytes(hexToBytes(witness.signature));
        vkeyWitnesses.add(cml.Vkeywitness.new(vkey, signature));
      } else {
        throw new Error('unexpected witness type');
      }
    }

    if (vkeyWitnesses.len() > 0) witnessSet.set_vkeywitnesses(vkeyWitnesses);
    return cml.Transaction.new(body, witnessSet, tx.is_valid(), auxiliaryData).to_cbor_hex();
  });
  return { txHex, txId: transactionHexToHash(txHex) };
}
