import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import tsDocPlugin from 'eslint-plugin-tsdoc';
import prettierConfig from 'eslint-config-prettier';

export default [
  {
    // Ignore build output and internal metadata folders
    ignores: ['**/dist/**', '**/temp/**', '**/etc/**', '**/docs/**', 'node_modules/**']
  },
  {
    files: ['packages/*/src/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: './packages/*/tsconfig.json',
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
      'tsdoc': tsDocPlugin,
    },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      'tsdoc/syntax': 'warn',
      '@typescript-eslint/no-explicit-any': 'warn'
    },
  },
  prettierConfig,
];