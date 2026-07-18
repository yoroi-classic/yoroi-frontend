const path = require('path');
const { ESLint } = require('eslint');

const packageRoot = path.resolve(__dirname, '..');
const includedTypeScriptPath = path.join(packageRoot, 'app/UI/common/constants.ts');

async function lintText(source) {
  const eslint = new ESLint({ cwd: packageRoot });
  const [result] = await eslint.lintText(source, {
    filePath: includedTypeScriptPath,
  });
  return result.messages.filter(message => message.ruleId === '@typescript-eslint/no-unused-vars');
}

async function main() {
  const unusedMessages = await lintText('const unusedSymbol = 1;\nexport {};\n');
  if (unusedMessages.length !== 1 || unusedMessages[0].severity !== 2) {
    throw new Error('TypeScript unused symbols must fail ESLint');
  }

  const ignoredMessages = await lintText('const _intentionallyUnused = 1;\nexport {};\n');
  if (ignoredMessages.length !== 0) {
    throw new Error('Underscore-prefixed TypeScript symbols must remain explicitly ignorable');
  }

  console.log('TypeScript lint contract passed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
