// @flow

jest.mock('copy-webpack-plugin', () => jest.fn());

const path = require('path');
const commonConfig = require('./commonConfig');

test('legacySwap asset-name import resolves to the extension implementation', () => {
  expect(commonConfig.resolve().alias['@emurgo/yoroi-lib/dist/internals/utils/assets']).toBe(
    path.resolve(__dirname, '../app/utils/cardanoAssetName.js')
  );
});
