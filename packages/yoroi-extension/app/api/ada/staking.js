import type { IGetSigningKey, IGetStakingKey, IPublicDeriver } from './lib/storage/models/PublicDeriver/interfaces';
import { ConceptualWallet } from './lib/storage/models/ConceptualWallet';
import { derivePrivateKeyBytesByAddressing } from './lib/cardanoCrypto/deriveByAddressing';
import { Logger, stringifyError } from '../../utils/logging';
import { WrongPassphraseError } from './lib/cardanoCrypto/cryptoErrors';
import { GenericApiError, IncorrectWalletPasswordError } from '../common/errors';
import LocalizableError from '../../i18n/LocalizableError';

export async function genOwnStakingKey(request: {|
  publicDeriver: IPublicDeriver<ConceptualWallet> & IGetSigningKey & IGetStakingKey,
  password: string,
|}): Promise<Uint8Array> {
  try {
    const signingKeyFromStorage = await request.publicDeriver.getSigningKey();
    const stakingAddr = await request.publicDeriver.getStakingKey();
    const normalizedKey = await request.publicDeriver.normalizeKey({
      ...signingKeyFromStorage,
      password: request.password,
    });
    return derivePrivateKeyBytesByAddressing({
      addressing: stakingAddr.addressing,
      privateKeyHex: normalizedKey.prvKeyHex,
      level: request.publicDeriver.getParent().getPublicDeriverLevel(),
    });
  } catch (error) {
    Logger.error(`${nameof(genOwnStakingKey)} error: ` + stringifyError(error));
    if (error instanceof WrongPassphraseError) {
      throw new IncorrectWalletPasswordError();
    }
    if (error instanceof LocalizableError) throw error;
    throw new GenericApiError();
  }
}
