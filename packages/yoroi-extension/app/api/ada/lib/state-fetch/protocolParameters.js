// @flow

export type ProtocolParameters = {|
  linearFee: {| constant: string, coefficient: string |},
  coinsPerUtxoByte: string,
  poolDeposit: string,
  keyDeposit: string,
  epoch: number,
|};
