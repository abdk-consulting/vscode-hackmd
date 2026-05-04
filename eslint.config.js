const js = require('@eslint/js');
const tseslint = require('typescript-eslint');
// const importPlugin = require('eslint-plugin-import');

module.exports = tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'out/**', 'eslint.config.js'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  // importPlugin.flatConfigs.recommended,
  // importPlugin.flatConfigs.typescript,
  {
    files: ['**/*.{ts,js}'],
    // settings: {
    //   'import/resolver': {
    //     typescript: true,
    //     node: true,
    //   },
    //   'import/core-modules': ['vscode'],
    // },
    rules: {
      // 'import/order': [
      //   'error',
      //   {
      //     'newlines-between': 'always',
      //     alphabetize: {
      //       order: 'asc',
      //       caseInsensitive: true,
      //     },
      //   },
      // ],
      // 'import/no-named-as-default': 'off',
      // 'import/no-named-as-default-member': 'off',
      // 'import/default': 'warn',
      'no-case-declarations': 'off',
      'prefer-const': 'off',
    },
  },
  {
    files: ['**/*.ts'],
    rules: {
      '@typescript-eslint/no-var-requires': 'off',
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      'no-useless-escape': 'off',
    },
  },
  {
    files: ['**/*.js'],
    languageOptions: {
      globals: {
        module: 'readonly',
        require: 'readonly',
        __dirname: 'readonly',
        process: 'readonly',
        global: 'readonly',
        globalThis: 'readonly',
      },
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/no-var-requires': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      'no-undef': 'off',
    },
  }
);
