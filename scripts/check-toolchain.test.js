const assert = require('node:assert/strict');
const test = require('node:test');

const { detectNpmVersion, parseNpmConfig, parseNpmVersionFromUserAgent } = require('./check-toolchain');

test('parseNpmConfig reads committed install semantics', () => {
  assert.deepEqual(parseNpmConfig('# install contract\nengine-strict = true\nlegacy-peer-deps=true\n'), {
    'engine-strict': 'true',
    'legacy-peer-deps': 'true',
  });
});

test('detectNpmVersion trims npm output', () => {
  const result = detectNpmVersion({ runCommand: () => ' 10.9.7\n', env: {} });

  assert.deepEqual(result, {
    version: '10.9.7',
    error: null,
  });
});

test('detectNpmVersion reports empty npm output clearly', () => {
  const result = detectNpmVersion({ runCommand: () => '\n', env: {} });

  assert.equal(result.version, null);
  assert.match(result.error, /produced no output/);
});

test('detectNpmVersion falls back to npm user agent after empty output', () => {
  const result = detectNpmVersion({
    runCommand: () => '\n',
    env: { npm_config_user_agent: 'npm/10.9.7 node/v22.22.2 linux x64 workspaces/false' },
  });

  assert.deepEqual(result, {
    version: '10.9.7',
    error: null,
  });
});

test('detectNpmVersion reports npm command failures clearly', () => {
  const error = new Error('spawn failed');
  error.status = 127;
  error.stderr = 'npm unavailable\n';

  const result = detectNpmVersion({
    runCommand: () => {
      throw error;
    },
    env: {},
  });

  assert.equal(result.version, null);
  assert.match(result.error, /exit status 127/);
  assert.match(result.error, /npm unavailable/);
});

test('parseNpmVersionFromUserAgent returns npm version only for npm user agents', () => {
  assert.equal(parseNpmVersionFromUserAgent('npm/10.9.7 node/v22.22.2 linux x64 workspaces/false'), '10.9.7');
  assert.equal(parseNpmVersionFromUserAgent('pnpm/9.0.0 node/v22.22.2'), null);
});
