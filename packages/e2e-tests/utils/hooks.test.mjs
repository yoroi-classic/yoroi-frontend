import assert from 'node:assert/strict';
import test from 'node:test';
import { mochaHooks } from './hooks.mjs';

const runBeforeEach = async ({ parentTests, grandParentTests = [] }) => {
  let skipped = false;
  let completed = false;
  const context = {
    currentTest: {
      parent: {
        tests: parentTests,
        parent: {
          tests: grandParentTests,
        },
      },
    },
    skip() {
      skipped = true;
    },
  };

  await mochaHooks.beforeEach.call(context, () => {
    completed = true;
  });

  return { completed, skipped };
};

test('does not skip a live sibling after an intentionally pending test', async () => {
  const result = await runBeforeEach({
    parentTests: [{ state: 'pending', fn: undefined }, { state: undefined }],
  });

  assert.deepEqual(result, { completed: true, skipped: false });
});

test('skips subsequent tests after a runtime precondition skip', async () => {
  const result = await runBeforeEach({
    parentTests: [{ state: 'pending', fn() {} }, { state: undefined }],
  });

  assert.deepEqual(result, { completed: true, skipped: true });
});

test('still skips subsequent tests after a failed sibling', async () => {
  const result = await runBeforeEach({
    parentTests: [{ state: 'failed' }, { state: undefined }],
  });

  assert.deepEqual(result, { completed: true, skipped: true });
});

test('still skips nested tests after a failed parent test', async () => {
  const result = await runBeforeEach({
    parentTests: [{ state: undefined }],
    grandParentTests: [{ state: 'failed' }],
  });

  assert.deepEqual(result, { completed: true, skipped: true });
});
