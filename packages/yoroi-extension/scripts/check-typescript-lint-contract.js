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

  const wrapperObjectMessages = messagesForRule(
    await lintText("export const fixture: String = 'value';\n"),
    '@typescript-eslint/no-wrapper-object-types'
  );
  if (wrapperObjectMessages.length !== 1 || wrapperObjectMessages[0].severity !== 2) {
    throw new Error(`TypeScript wrapper object types must fail ESLint: ${JSON.stringify(wrapperObjectMessages)}`);
  }

  const emptyObjectMessages = messagesForRule(
    await lintText('export type Fixture = {};\n'),
    '@typescript-eslint/no-empty-object-type'
  );
  if (emptyObjectMessages.length !== 1 || emptyObjectMessages[0].severity !== 2) {
    throw new Error(`TypeScript empty object types must fail ESLint: ${JSON.stringify(emptyObjectMessages)}`);
  }

  const unsafeFunctionMessages = messagesForRule(
    await lintText('export type Fixture = Function;\n'),
    '@typescript-eslint/no-unsafe-function-type'
  );
  if (unsafeFunctionMessages.length !== 1 || unsafeFunctionMessages[0].severity !== 2) {
    throw new Error(`TypeScript unsafe function types must fail ESLint: ${JSON.stringify(unsafeFunctionMessages)}`);
  }

  const thisAliasMessages = messagesForRule(
    await lintText('export class Fixture { value = 1; read(): number { const alias = this; return alias.value; } }\n'),
    '@typescript-eslint/no-this-alias'
  );
  if (thisAliasMessages.length !== 1 || thisAliasMessages[0].severity !== 2) {
    throw new Error(`TypeScript this aliases must fail ESLint: ${JSON.stringify(thisAliasMessages)}`);
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
