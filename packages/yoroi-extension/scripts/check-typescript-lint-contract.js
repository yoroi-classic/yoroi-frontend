const path = require('path');

// lintText must parse the supplied mutation instead of reusing the on-disk
// TypeScript Program that CI's single-run inference caches for this file path.
process.env.TSESTREE_SINGLE_RUN = 'false';

const { ESLint } = require('eslint');

const packageRoot = path.resolve(__dirname, '..');
const includedTypeScriptPath = path.join(packageRoot, 'app/UI/common/constants.ts');

async function lintText(source) {
  const eslint = new ESLint({ cwd: packageRoot });
  const [result] = await eslint.lintText(source, {
    filePath: includedTypeScriptPath,
  });
  return result.messages;
}

function messagesForRule(messages, ruleId) {
  return messages.filter(message => message.ruleId === ruleId);
}

async function main() {
  const syntaxMessages = await lintText('const broken: = 1;\n');
  if (!syntaxMessages.some(message => message.fatal === true)) {
    throw new Error(`TypeScript syntax errors must fail ESLint: ${JSON.stringify(syntaxMessages)}`);
  }

  const unsafeMessages = messagesForRule(
    await lintText('export async function fixture(): Promise<void> { await 42; }\n'),
    '@typescript-eslint/await-thenable'
  );
  if (unsafeMessages.length !== 1 || unsafeMessages[0].severity !== 2) {
    throw new Error(`Type-aware unsafe operations must fail ESLint: ${JSON.stringify(unsafeMessages)}`);
  }

  const unusedMessages = messagesForRule(
    await lintText('const unusedSymbol = 1;\nexport {};\n'),
    '@typescript-eslint/no-unused-vars'
  );
  if (unusedMessages.length !== 1 || unusedMessages[0].severity !== 2) {
    throw new Error(`TypeScript unused symbols must fail ESLint: ${JSON.stringify(unusedMessages)}`);
  }

  const ignoredMessages = messagesForRule(
    await lintText('const _intentionallyUnused = 1;\nexport {};\n'),
    '@typescript-eslint/no-unused-vars'
  );
  if (ignoredMessages.length !== 0) {
    throw new Error('Underscore-prefixed TypeScript symbols must remain explicitly ignorable');
  }

  const ignoredParameterMessages = messagesForRule(
    await lintText('export function fixture(_intentionallyUnused: string): void {}\n'),
    '@typescript-eslint/no-unused-vars'
  );
  if (ignoredParameterMessages.length !== 0) {
    throw new Error('Underscore-prefixed TypeScript parameters must remain explicitly ignorable');
  }

  console.log('TypeScript lint contract passed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
