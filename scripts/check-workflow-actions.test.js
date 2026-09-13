const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const { ACTIONS, auditWorkflows } = require('./check-workflow-actions');

const WORKSPACE_ROOT = path.resolve(__dirname, '..');
const CHECKOUT = ACTIONS['actions/checkout'];
const SETUP_CHROME = ACTIONS['browser-actions/setup-chrome'];

function mutatedWorkflow(replace, filename = 'tests.yml') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yoroi-workflow-actions-'));
  const source = path.join(WORKSPACE_ROOT, '.github', 'workflows');
  const destination = path.join(root, '.github', 'workflows');
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.cpSync(source, destination, { recursive: true });

  const workflow = path.join(destination, filename);
  const original = fs.readFileSync(workflow, 'utf8');
  const changed = replace(original);
  assert.notEqual(changed, original, `test mutation must change ${filename}`);
  fs.writeFileSync(workflow, changed);
  return root;
}

test('pins the complete external action inventory and preserves .nvmrc setup', () => {
  const result = auditWorkflows();
  assert.deepEqual(result.errors, []);
  assert.deepEqual(
    result.inventory,
    Object.fromEntries(Object.entries(ACTIONS).map(([action, contract]) => [action, contract.count]))
  );
});

test('rejects mutable action tags', t => {
  const root = mutatedWorkflow(source => source.replace(`actions/checkout@${CHECKOUT.sha}`, 'actions/checkout@v7'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.match(auditWorkflows({ root }).errors.join('\n'), /full 40-character commit SHA/);
});

test('rejects action references disguised as shell commands', t => {
  const root = mutatedWorkflow(source =>
    source.replace(`- uses: actions/checkout@${CHECKOUT.sha}`, `- run: echo "uses: actions/checkout@${CHECKOUT.sha}" #`)
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const errors = auditWorkflows({ root }).errors.join('\n');
  assert.match(errors, /has an invalid action reference/);
  assert.match(errors, new RegExp(`actions/checkout inventory must contain ${CHECKOUT.count} uses, found ${CHECKOUT.count - 1}`));
});

test('rejects commented-out action references', t => {
  const root = mutatedWorkflow(source =>
    source.replace(`- uses: actions/checkout@${CHECKOUT.sha}`, `# - uses: actions/checkout@${CHECKOUT.sha}`)
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const errors = auditWorkflows({ root }).errors.join('\n');
  assert.match(errors, /has an invalid action reference/);
  assert.match(errors, new RegExp(`actions/checkout inventory must contain ${CHECKOUT.count} uses, found ${CHECKOUT.count - 1}`));
});

test('rejects short action SHAs', t => {
  const root = mutatedWorkflow(source =>
    source.replace(`actions/checkout@${CHECKOUT.sha}`, `actions/checkout@${CHECKOUT.sha.slice(0, 12)}`)
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.match(auditWorkflows({ root }).errors.join('\n'), /full 40-character commit SHA/);
});

test('rejects retired action generations even when pinned to a full SHA', t => {
  const root = mutatedWorkflow(source => source.replace(CHECKOUT.sha, '34e114876b0b11c390a56381ad16ebd13914f8d5'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.match(auditWorkflows({ root }).errors.join('\n'), new RegExp(`must pin ${CHECKOUT.sha}`));
});

test('rejects missing release comments', t => {
  const root = mutatedWorkflow(source => source.replace(` # ${CHECKOUT.version}`, ''));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.match(auditWorkflows({ root }).errors.join('\n'), new RegExp(`must have comment # ${CHECKOUT.version}`));
});

test('rejects setup-node steps that bypass .nvmrc', t => {
  const root = mutatedWorkflow(source =>
    source.replace("node-version: '${{ steps.nvm.outputs.NVMRC }}'", "node-version: '22.22.2'")
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.match(auditWorkflows({ root }).errors.join('\n'), /must install the version read from \.nvmrc/);
});

test('rejects action inventory drift', t => {
  const root = mutatedWorkflow(source => source.replace(/^\s*- uses: actions\/checkout@[^\n]+\n/m, ''));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.match(
    auditWorkflows({ root }).errors.join('\n'),
    new RegExp(`actions/checkout inventory must contain ${CHECKOUT.count} uses, found ${CHECKOUT.count - 1}`)
  );
});

test('rejects mutable third-party action tags', t => {
  const root = mutatedWorkflow(
    source => source.replace(`browser-actions/setup-chrome@${SETUP_CHROME.sha}`, 'browser-actions/setup-chrome@v2'),
    'e2e-tests.yml'
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.match(auditWorkflows({ root }).errors.join('\n'), /full 40-character commit SHA/);
});

test('rejects mutable actions behind quoted escape-encoded uses keys', t => {
  const root = mutatedWorkflow(source =>
    source.replace(`uses: actions/checkout@${CHECKOUT.sha}`, '"u\\u0073es": actions/checkout@v7')
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const errors = auditWorkflows({ root }).errors.join('\n');
  assert.match(errors, /quoted YAML mapping keys are not allowed/);
  assert.match(errors, new RegExp(`actions/checkout inventory must contain ${CHECKOUT.count} uses, found ${CHECKOUT.count - 1}`));
});

test('rejects unreviewed external actions even when SHA-pinned', t => {
  const root = mutatedWorkflow(source => source.replace('actions/checkout@', 'unreviewed/example-action@'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.match(auditWorkflows({ root }).errors.join('\n'), /uses unreviewed external action unreviewed\/example-action/);
});

test('preserves the Chrome Web Store nightly publication inputs in the action with block', t => {
  const root = mutatedWorkflow(
    source =>
      source.replace('oauth-client-id:', 'client-id:').replace(
        '      - name: Configure Git',
        `      - name: "Decoy oauth-client-id: \${{ secrets.NIGHTLY_CLIENT_ID }}"
        run: echo decoy

      - name: Configure Git`
      ),
    'nightly-publish.yml'
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.match(
    auditWorkflows({ root }).errors.join('\n'),
    /Chrome publication inputs must preserve the nightly release contract/
  );
});

test('rejects mutable actions behind explicit escape-encoded mapping keys', t => {
  const root = mutatedWorkflow(source =>
    source.replace(
      `uses: actions/checkout@${CHECKOUT.sha}`,
      `? "u\\u0073es"
        : actions/checkout@v7`
    )
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.match(auditWorkflows({ root }).errors.join('\n'), /explicit, decorated, and merged YAML mappings are not allowed/);
});
