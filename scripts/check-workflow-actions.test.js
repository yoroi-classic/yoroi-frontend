const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const { ACTIONS, auditWorkflows } = require('./check-workflow-actions');

const WORKSPACE_ROOT = path.resolve(__dirname, '..');

function mutatedWorkflows(replace) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yoroi-workflow-actions-'));
  const source = path.join(WORKSPACE_ROOT, '.github', 'workflows');
  const destination = path.join(root, '.github', 'workflows');
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.cpSync(source, destination, { recursive: true });

  const workflow = path.join(destination, 'tests.yml');
  const original = fs.readFileSync(workflow, 'utf8');
  const changed = replace(original);
  assert.notEqual(changed, original, 'test mutation must change tests.yml');
  fs.writeFileSync(workflow, changed);
  return root;
}

test('pins the complete official action inventory and preserves .nvmrc setup', () => {
  const result = auditWorkflows();
  assert.deepEqual(result.errors, []);
  assert.deepEqual(
    result.inventory,
    Object.fromEntries(Object.entries(ACTIONS).map(([action, contract]) => [action, contract.count]))
  );
});

test('rejects mutable action tags', t => {
  const root = mutatedWorkflows(source => source.replace(`actions/checkout@${ACTIONS.checkout.sha}`, 'actions/checkout@v7'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.match(auditWorkflows({ root }).errors.join('\n'), /full 40-character commit SHA/);
});

test('rejects action references disguised as shell commands', t => {
  const root = mutatedWorkflows(source =>
    source.replace(
      `- uses: actions/checkout@${ACTIONS.checkout.sha}`,
      `- run: echo "uses: actions/checkout@${ACTIONS.checkout.sha}" #`
    )
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const errors = auditWorkflows({ root }).errors.join('\n');
  assert.match(errors, /has an invalid official action reference/);
  assert.match(
    errors,
    new RegExp(`actions/checkout inventory must contain ${ACTIONS.checkout.count} uses, found ${ACTIONS.checkout.count - 1}`)
  );
});

test('rejects commented-out action references', t => {
  const root = mutatedWorkflows(source =>
    source.replace(`- uses: actions/checkout@${ACTIONS.checkout.sha}`, `# - uses: actions/checkout@${ACTIONS.checkout.sha}`)
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const errors = auditWorkflows({ root }).errors.join('\n');
  assert.match(errors, /has an invalid official action reference/);
  assert.match(
    errors,
    new RegExp(`actions/checkout inventory must contain ${ACTIONS.checkout.count} uses, found ${ACTIONS.checkout.count - 1}`)
  );
});

test('rejects short action SHAs', t => {
  const root = mutatedWorkflows(source =>
    source.replace(`actions/checkout@${ACTIONS.checkout.sha}`, `actions/checkout@${ACTIONS.checkout.sha.slice(0, 12)}`)
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.match(auditWorkflows({ root }).errors.join('\n'), /full 40-character commit SHA/);
});

test('rejects retired action generations even when pinned to a full SHA', t => {
  const root = mutatedWorkflows(source => source.replace(ACTIONS.checkout.sha, '34e114876b0b11c390a56381ad16ebd13914f8d5'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.match(auditWorkflows({ root }).errors.join('\n'), new RegExp(`must pin ${ACTIONS.checkout.sha}`));
});

test('rejects missing release comments', t => {
  const root = mutatedWorkflows(source => source.replace(` # ${ACTIONS.checkout.version}`, ''));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.match(auditWorkflows({ root }).errors.join('\n'), new RegExp(`must have comment # ${ACTIONS.checkout.version}`));
});

test('rejects setup-node steps that bypass .nvmrc', t => {
  const root = mutatedWorkflows(source =>
    source.replace("node-version: '${{ steps.nvm.outputs.NVMRC }}'", "node-version: '22.22.2'")
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.match(auditWorkflows({ root }).errors.join('\n'), /must install the version read from \.nvmrc/);
});

test('rejects action inventory drift', t => {
  const root = mutatedWorkflows(source => source.replace(/^\s*- uses: actions\/checkout@[^\n]+\n/m, ''));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.match(
    auditWorkflows({ root }).errors.join('\n'),
    new RegExp(`actions/checkout inventory must contain ${ACTIONS.checkout.count} uses, found ${ACTIONS.checkout.count - 1}`)
  );
});
