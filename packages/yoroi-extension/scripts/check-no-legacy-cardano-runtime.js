#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const WORKSPACE_ROOT = path.resolve(__dirname, '..', '..', '..');
const SOURCE_DIRECTORIES = [
  'packages/yoroi-extension/api',
  'packages/yoroi-extension/assets',
  'packages/yoroi-extension/app',
  'packages/yoroi-extension/chrome',
  'packages/yoroi-extension/config',
  'packages/yoroi-extension/flow',
  'packages/yoroi-extension/flow-typed',
  'packages/yoroi-extension/ledger',
  'packages/yoroi-extension/posthog',
  'packages/yoroi-extension/scripts',
  'packages/yoroi-extension/webpack',
  'packages/yoroi-extension/workers',
  'packages/e2e-tests/helpers',
  'packages/e2e-tests/pages',
  'packages/e2e-tests/scripts',
  'packages/e2e-tests/test',
  'packages/e2e-tests/testRunsData',
  'packages/e2e-tests/utils',
];
const ROOT_SOURCE_FILES = [
  'packages/yoroi-extension/.babelrc.js',
  'packages/yoroi-extension/eslint.config.js',
  'packages/yoroi-extension/jest.config.js',
  'packages/yoroi-extension/jestSetup.js',
  'packages/yoroi-extension/.d.ts',
  'packages/yoroi-extension/.flowconfig',
];
const PACKAGE_PATHS = ['packages/yoroi-extension', 'packages/e2e-tests'];
const SOURCE_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs']);
const FORBIDDEN_SOURCE_PATTERNS = [
  /@emurgo\/cardano-serialization-lib-(?:browser|nodejs)/,
  /@emurgo\/cross-csl-[\w-]+/,
  /\byoroi-eutxo-txs\b/,
  /\b(?:WalletV2|WalletV4|CrossCsl)\b/,
  /\b(?:RustModule|Module)\.CSL\b/,
];
const FORBIDDEN_PACKAGE_PATTERNS = [
  /^@emurgo\/cardano-serialization-lib-(?:browser|nodejs)$/,
  /^@emurgo\/cross-csl-[\w-]+$/,
  /^yoroi-eutxo-txs$/,
];

function sourceFindings(source, relativePath) {
  return FORBIDDEN_SOURCE_PATTERNS.flatMap(pattern => {
    const match = pattern.exec(source);
    return match ? [`${relativePath}: ${match[0]}`] : [];
  });
}

function sourceFiles(directory) {
  const absoluteDirectory = path.join(WORKSPACE_ROOT, directory);
  if (!fs.existsSync(absoluteDirectory)) return [];

  return fs.readdirSync(absoluteDirectory, { withFileTypes: true }).flatMap(entry => {
    const absolutePath = path.join(absoluteDirectory, entry.name);
    const relativePath = path.relative(WORKSPACE_ROOT, absolutePath);
    if (entry.isDirectory()) return sourceFiles(relativePath);
    return SOURCE_EXTENSIONS.has(path.extname(entry.name)) ? [relativePath] : [];
  });
}

function packageFindings(packagePath) {
  const packageJson = JSON.parse(fs.readFileSync(path.join(WORKSPACE_ROOT, packagePath, 'package.json'), 'utf8'));
  const packageLock = JSON.parse(fs.readFileSync(path.join(WORKSPACE_ROOT, packagePath, 'package-lock.json'), 'utf8'));
  const dependencyFields = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
  const findings = dependencyFields.flatMap(field =>
    Object.keys(packageJson[field] || {})
      .filter(dependencyName => FORBIDDEN_PACKAGE_PATTERNS.some(pattern => pattern.test(dependencyName)))
      .map(dependencyName => `${packagePath}/package.json ${field}: ${dependencyName}`)
  );

  for (const [packageEntry, packageMetadata] of Object.entries(packageLock.packages || {})) {
    if (packageEntry === '') continue;
    const packageName = packageEntry.split('node_modules/').at(-1);
    if (FORBIDDEN_PACKAGE_PATTERNS.some(pattern => pattern.test(packageName))) {
      findings.push(`${packagePath}/package-lock.json: ${packageEntry}`);
    }
    for (const dependencyName of Object.keys(packageMetadata.dependencies || {})) {
      if (FORBIDDEN_PACKAGE_PATTERNS.some(pattern => pattern.test(dependencyName))) {
        findings.push(`${packagePath}/package-lock.json ${packageEntry}: ${dependencyName}`);
      }
    }
  }
  return findings;
}

function scanWorkspace() {
  const checkerFiles = new Set([
    'packages/yoroi-extension/scripts/check-no-legacy-cardano-runtime.js',
    'packages/yoroi-extension/scripts/check-no-legacy-cardano-runtime.test.js',
  ]);
  const findings = SOURCE_DIRECTORIES.flatMap(sourceFiles)
    .filter(relativePath => !checkerFiles.has(relativePath))
    .flatMap(relativePath => {
      const source = fs.readFileSync(path.join(WORKSPACE_ROOT, relativePath), 'utf8');
      return sourceFindings(source, relativePath);
    });
  for (const relativePath of ROOT_SOURCE_FILES) {
    const absolutePath = path.join(WORKSPACE_ROOT, relativePath);
    if (!fs.existsSync(absolutePath)) {
      findings.push(`${relativePath}: configured source file is missing`);
      continue;
    }
    findings.push(...sourceFindings(fs.readFileSync(absolutePath, 'utf8'), relativePath));
  }
  findings.push(...PACKAGE_PATHS.flatMap(packageFindings));
  return findings;
}

if (require.main === module) {
  const findings = scanWorkspace();
  if (findings.length > 0) {
    console.error(['Legacy Cardano serialization runtime references found:', ...findings.map(value => `  ${value}`)].join('\n'));
    process.exit(1);
  }
  console.log('No legacy Cardano serialization runtime references found in extension or E2E source/dependency graphs.');
}

module.exports = { scanWorkspace, sourceFindings, SOURCE_DIRECTORIES, ROOT_SOURCE_FILES };
