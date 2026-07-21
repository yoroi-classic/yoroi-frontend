import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';

const execFileAsync = promisify(execFile);
const mochaBin = new URL('../node_modules/mocha/bin/mocha.js', import.meta.url);
const rootHooks = new URL('./fixtures/hooks/root-hooks.mjs', import.meta.url);
const fixtures = new URL('./fixtures/hooks/', import.meta.url);

const runFixture = async fixture => {
  try {
    const result = await execFileAsync(
      process.execPath,
      [mochaBin.pathname, '--require', rootHooks.pathname, new URL(fixture, fixtures).pathname, '--reporter', 'dot'],
      { encoding: 'utf8' }
    );
    return { ...result, exitCode: 0 };
  } catch (error) {
    return {
      exitCode: error.code,
      stderr: error.stderr,
      stdout: error.stdout,
    };
  }
};

const assertSummary = (result, { exitCode, passing = 0, pending = 0, failing = 0 }) => {
  assert.equal(result.exitCode, exitCode, result.stderr);
  assert.match(result.stdout, new RegExp(`\\b${passing} passing\\b`));
  if (pending > 0) assert.match(result.stdout, new RegExp(`\\b${pending} pending\\b`));
  if (failing > 0) assert.match(result.stdout, new RegExp(`\\b${failing} failing\\b`));
};

test('a declaration-time it.skip does not hide a live sibling', async () => {
  const result = await runFixture('declaration-skip.mjs');
  assertSummary(result, { exitCode: 0, passing: 1, pending: 1 });
});

test('a runtime this.skip still blocks following siblings', async () => {
  const result = await runFixture('runtime-skip.mjs');
  assertSummary(result, { exitCode: 0, pending: 2 });
});

test('a beforeEach precondition skip still blocks following siblings', async () => {
  const result = await runFixture('before-each-skip.mjs');
  assertSummary(result, { exitCode: 0, pending: 2 });
});

test('a failed sibling still blocks following siblings', async () => {
  const result = await runFixture('failed-sibling.mjs');
  assertSummary(result, { exitCode: 1, pending: 1, failing: 1 });
});

test('a failed parent test still blocks nested tests', async () => {
  const result = await runFixture('failed-parent.mjs');
  assertSummary(result, { exitCode: 1, pending: 1, failing: 1 });
});
