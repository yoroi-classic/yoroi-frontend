#!/usr/bin/env node
// Direct package replacement is intentionally not attempted here yet: extension
// runtime imports still use EMURGO CSL, message-signing, cross-csl, Bring,
// yoroi-eutxo-txs, and yoroi-lib APIs, while e2e still depends on CSL nodejs.
// This guard fails if that active dependency surface changes outside inventory.

const fs = require('fs');
const path = require('path');

const WORKSPACE_ROOT = path.resolve(__dirname, '..', '..', '..');
const PACKAGE_PATHS = ['packages/yoroi-extension', 'packages/e2e-tests'];
const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
const FORBIDDEN_SOURCE_PATTERNS = [/github(?::|\.com[:/])Emurgo\//i, /emurgornd\.com/i];
const FORBIDDEN_SOURCE_FIXTURES = [
  'github:Emurgo/yoroi-lib#1.0.0',
  'https://github.com/Emurgo/yoroi-lib#1.0.0',
  'git+https://github.com/Emurgo/yoroi-lib.git#1.0.0',
  'git+ssh://git@github.com:Emurgo/yoroi-lib.git#1.0.0',
  'https://prod.emurgornd.com/service',
];

const EXPECTED_DIRECT_EMURGO_DEPENDENCIES = [
  'packages/e2e-tests:devDependencies:@emurgo/cardano-serialization-lib-nodejs',
  'packages/yoroi-extension:dependencies:@emurgo/bringweb3-chrome-extension-kit',
  'packages/yoroi-extension:dependencies:@emurgo/cardano-message-signing-browser',
  'packages/yoroi-extension:dependencies:@emurgo/cardano-serialization-lib-browser',
  'packages/yoroi-extension:dependencies:@emurgo/cross-csl-browser',
  'packages/yoroi-extension:dependencies:@emurgo/cross-csl-core',
  'packages/yoroi-extension:dependencies:@emurgo/yoroi-eutxo-txs',
  'packages/yoroi-extension:dependencies:@emurgo/yoroi-lib',
  'packages/yoroi-extension:devDependencies:@emurgo/cardano-message-signing-nodejs',
  'packages/yoroi-extension:devDependencies:@emurgo/cardano-serialization-lib-nodejs',
  'packages/yoroi-extension:devDependencies:@emurgo/cross-csl-nodejs',
];

const EXPECTED_LOCKFILE_EMURGO_PACKAGE_ENTRIES = [
  'packages/e2e-tests:node_modules/@emurgo/cardano-serialization-lib-nodejs',
  'packages/yoroi-extension:node_modules/@emurgo/bringweb3-chrome-extension-kit',
  'packages/yoroi-extension:node_modules/@emurgo/cardano-message-signing-browser',
  'packages/yoroi-extension:node_modules/@emurgo/cardano-message-signing-nodejs',
  'packages/yoroi-extension:node_modules/@emurgo/cardano-serialization-lib-browser',
  'packages/yoroi-extension:node_modules/@emurgo/cardano-serialization-lib-nodejs',
  'packages/yoroi-extension:node_modules/@emurgo/cip4-js',
  'packages/yoroi-extension:node_modules/@emurgo/cip14-js',
  'packages/yoroi-extension:node_modules/@emurgo/cross-csl-browser',
  'packages/yoroi-extension:node_modules/@emurgo/cross-csl-core',
  'packages/yoroi-extension:node_modules/@emurgo/cross-csl-nodejs',
  'packages/yoroi-extension:node_modules/@emurgo/yoroi-eutxo-txs',
  'packages/yoroi-extension:node_modules/@emurgo/yoroi-lib',
  'packages/yoroi-extension:node_modules/@fivebinaries/coin-selection/node_modules/@emurgo/cardano-serialization-lib-browser',
  'packages/yoroi-extension:node_modules/@fivebinaries/coin-selection/node_modules/@emurgo/cardano-serialization-lib-nodejs',
];

const EXPECTED_TRANSITIVE_EMURGO_DEPENDENCY_EDGES = [
  'packages/yoroi-extension:node_modules/@emurgo/cross-csl-browser:dependencies:@emurgo/cardano-serialization-lib-browser',
  'packages/yoroi-extension:node_modules/@emurgo/cross-csl-browser:dependencies:@emurgo/cross-csl-core',
  'packages/yoroi-extension:node_modules/@emurgo/cross-csl-nodejs:dependencies:@emurgo/cardano-serialization-lib-nodejs',
  'packages/yoroi-extension:node_modules/@emurgo/cross-csl-nodejs:dependencies:@emurgo/cross-csl-core',
  'packages/yoroi-extension:node_modules/@emurgo/yoroi-eutxo-txs:dependencies:@emurgo/cross-csl-core',
  'packages/yoroi-extension:node_modules/@emurgo/yoroi-lib:dependencies:@emurgo/cross-csl-core',
  'packages/yoroi-extension:node_modules/@fivebinaries/coin-selection:dependencies:@emurgo/cardano-serialization-lib-browser',
  'packages/yoroi-extension:node_modules/@fivebinaries/coin-selection:dependencies:@emurgo/cardano-serialization-lib-nodejs',
  'packages/yoroi-extension:node_modules/@yoroi/api:dependencies:@emurgo/cip14-js',
  'packages/yoroi-extension:node_modules/@yoroi/staking:dependencies:@emurgo/cip14-js',
  'packages/yoroi-extension:node_modules/legacySwap/node_modules/@yoroi/api:dependencies:@emurgo/cip14-js',
  'packages/yoroi-extension:node_modules/legacySwap:dependencies:@emurgo/cip14-js',
];

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(WORKSPACE_ROOT, relativePath), 'utf8'));
}

function isForbiddenDependencySource(dependencySpec) {
  return FORBIDDEN_SOURCE_PATTERNS.some(pattern => pattern.test(String(dependencySpec)));
}

function assertForbiddenSourcePatternCoverage() {
  return FORBIDDEN_SOURCE_FIXTURES.filter(dependencySpec => !isForbiddenDependencySource(dependencySpec)).map(
    dependencySpec => `  missing fixture coverage: ${dependencySpec}`
  );
}

function packageNameFromLockfileEntry(packageEntry) {
  const nodeModulesSegments = packageEntry.split('node_modules/');
  const packagePath = nodeModulesSegments[nodeModulesSegments.length - 1];
  const [first, second] = packagePath.split('/');
  return first && first.startsWith('@') ? `${first}/${second}` : first;
}

function directEmurgoDependencies(packagePath) {
  const packageJson = readJson(path.join(packagePath, 'package.json'));

  return DEPENDENCY_FIELDS.flatMap(field =>
    Object.keys(packageJson[field] || {})
      .filter(dependencyName => dependencyName.startsWith('@emurgo/'))
      .map(dependencyName => `${packagePath}:${field}:${dependencyName}`)
  );
}

function lockfilePackages(packagePath) {
  const packageLock = readJson(path.join(packagePath, 'package-lock.json'));
  return packageLock.packages || {};
}

function lockfileEmurgoPackageEntries(packagePath) {
  return Object.keys(lockfilePackages(packagePath))
    .filter(packageEntry => packageEntry !== '')
    .filter(packageEntry => packageNameFromLockfileEntry(packageEntry).startsWith('@emurgo/'))
    .map(packageEntry => `${packagePath}:${packageEntry}`);
}

function transitiveEmurgoDependencyEdges(packagePath) {
  return Object.entries(lockfilePackages(packagePath)).flatMap(([packageEntry, packageMetadata]) => {
    if (packageEntry === '') return [];

    const dependencies = (packageMetadata && packageMetadata.dependencies) || {};
    return Object.keys(dependencies)
      .filter(dependencyName => dependencyName.startsWith('@emurgo/'))
      .map(dependencyName => `${packagePath}:${packageEntry}:dependencies:${dependencyName}`);
  });
}

function forbiddenDependencySources(packagePath) {
  const packageJson = readJson(path.join(packagePath, 'package.json'));
  const packageJsonFindings = DEPENDENCY_FIELDS.flatMap(field =>
    Object.entries(packageJson[field] || {})
      .filter(([, dependencySpec]) => isForbiddenDependencySource(dependencySpec))
      .map(([dependencyName, dependencySpec]) => `${packagePath}:package.json:${field}:${dependencyName}:${dependencySpec}`)
  );

  const packageLockFindings = Object.entries(lockfilePackages(packagePath)).flatMap(([packageEntry, packageMetadata]) => {
    const resolved = packageMetadata && packageMetadata.resolved;
    if (!isForbiddenDependencySource(resolved || '')) return [];
    return [`${packagePath}:package-lock.json:${packageEntry}:resolved:${resolved}`];
  });

  return [...packageJsonFindings, ...packageLockFindings];
}

function sorted(values) {
  return [...values].sort();
}

function diff(actual, expected) {
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);

  return {
    missing: expected.filter(value => !actualSet.has(value)),
    unexpected: actual.filter(value => !expectedSet.has(value)),
  };
}

function assertInventory(name, actualValues, expectedValues) {
  const actual = sorted(actualValues);
  const expected = sorted(expectedValues);
  const { missing, unexpected } = diff(actual, expected);

  if (missing.length === 0 && unexpected.length === 0) return [];

  return [
    `${name} inventory mismatch`,
    ...missing.map(value => `  missing: ${value}`),
    ...unexpected.map(value => `  unexpected: ${value}`),
  ];
}

const failures = [
  ...assertForbiddenSourcePatternCoverage(),
  ...assertInventory(
    'Direct EMURGO dependency',
    PACKAGE_PATHS.flatMap(directEmurgoDependencies),
    EXPECTED_DIRECT_EMURGO_DEPENDENCIES
  ),
  ...assertInventory(
    'Lockfile EMURGO package entry',
    PACKAGE_PATHS.flatMap(lockfileEmurgoPackageEntries),
    EXPECTED_LOCKFILE_EMURGO_PACKAGE_ENTRIES
  ),
  ...assertInventory(
    'Transitive EMURGO dependency edge',
    PACKAGE_PATHS.flatMap(transitiveEmurgoDependencyEdges),
    EXPECTED_TRANSITIVE_EMURGO_DEPENDENCY_EDGES
  ),
];

const forbiddenSources = PACKAGE_PATHS.flatMap(forbiddenDependencySources);
if (forbiddenSources.length > 0) {
  failures.push('Forbidden EMURGO-owned dependency source found', ...forbiddenSources.map(value => `  ${value}`));
}

if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exit(1);
}

console.log('EMURGO dependency inventory matches the current migration surface.');
