import apiExtractorPlugin from '@api-extractor-tools/eslint-plugin';
import eslint from '@eslint/js';
import eslintConfigPrettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/temp/**',
      '**/node_modules/**',
      '**/.next/**',
      '.Codex/**',
      '.codex/**',
      '.worktrees/**',
      'scratch/**',
      'apps/website/**',
      '**/*.config.ts',
      '**/*.config.mjs',
      '**/*.workspace.ts',
      'eslint.config.mjs',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  apiExtractorPlugin.default.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      'no-plusplus': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    files: ['**/*.test.ts'],
    ...tseslint.configs.disableTypeChecked,
  },
  eslintConfigPrettier,
);
