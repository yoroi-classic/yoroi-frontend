import { YoroiRemoteConfig } from '../../types/yoroi';

type UnknownRecord = Record<string, unknown>;
type Validator = (value: unknown) => boolean;

const isRecord = (value: unknown): value is UnknownRecord => value !== null && typeof value === 'object' && !Array.isArray(value);

const isBoolean = (value: unknown): value is boolean => typeof value === 'boolean';
const isString = (value: unknown): value is string => typeof value === 'string';
const isOptional = (value: unknown, validator: Validator): boolean => value === undefined || validator(value);
const isArrayOf = (value: unknown, validator: Validator): boolean => Array.isArray(value) && value.every(validator);
const isStringArray = (value: unknown): boolean => isArrayOf(value, isString);
const isRecordOf = (value: unknown, validator: Validator): boolean => isRecord(value) && Object.values(value).every(validator);

const isDisplayConfig = (value: unknown): boolean => isRecord(value) && isBoolean(value.display);

const isEarnRewardsConfig = (value: unknown): boolean =>
  isRecord(value) && isBoolean(value.display) && isString(value.poolId) && isString(value.poolName) && isString(value.drepId);

const isPushLinkKeysConfig = (value: unknown): boolean =>
  isRecord(value) && isOptional(value.internal, isRecord) && isOptional(value.external, isRecord);

const isBannersConfig = (value: unknown): boolean =>
  isRecord(value) &&
  isOptional(value.midnightAnnouncement, isDisplayConfig) &&
  isOptional(value.earnRewardsWithYoroi, isEarnRewardsConfig);

const isStakingUpdateConfig = (value: unknown): boolean =>
  isRecord(value) && isBoolean(value.display) && isStringArray(value.affectedPools);

const isPopupsConfig = (value: unknown): boolean =>
  isRecord(value) &&
  isOptional(value.midnightDistribution, isDisplayConfig) &&
  isOptional(value.stakingUpdate, isStakingUpdateConfig) &&
  isDisplayConfig(value.firefoxSupportAnnouncement) &&
  isOptional(value.cardanoCardAnnouncement, isDisplayConfig) &&
  isOptional(value.secondFiTeaser, isDisplayConfig);

const isRecommendedDapp = (value: unknown): boolean =>
  isRecord(value) &&
  isString(value.id) &&
  isString(value.name) &&
  isString(value.description) &&
  isString(value.category) &&
  isString(value.logo) &&
  isString(value.uri) &&
  isStringArray(value.origins) &&
  isOptional(value.isSingleAddress, isBoolean);

const isDappsConfig = (value: unknown): boolean =>
  isRecord(value) &&
  isArrayOf(value.recommended, isRecommendedDapp) &&
  isStringArray(value.banned) &&
  isOptional(value.filters, candidate => isRecordOf(candidate, isStringArray));

const isInitialPair = (value: unknown): boolean => isRecord(value) && isString(value.tokenIn) && isString(value.tokenOut);

const isSwapConfig = (value: unknown): boolean =>
  isRecord(value) &&
  isInitialPair(value.initialPair) &&
  isStringArray(value.excludedTokens) &&
  isStringArray(value.verifiedTokens) &&
  isRecordOf(value.partners, isString);

export const isYoroiRemoteConfig = (value: unknown): value is YoroiRemoteConfig =>
  isRecord(value) &&
  isOptional(value.pushLinkKeys, isPushLinkKeysConfig) &&
  isOptional(value.banners, isBannersConfig) &&
  isOptional(value.popups, isPopupsConfig) &&
  isOptional(value.dapps, isDappsConfig) &&
  isOptional(value.swap, isSwapConfig) &&
  isOptional(value.enableTrezorAirdrop, isBoolean);

export const parseYoroiRemoteConfig = (value: unknown): YoroiRemoteConfig => {
  if (!isYoroiRemoteConfig(value)) {
    throw new Error('Invalid Yoroi remote config response');
  }
  return value;
};
