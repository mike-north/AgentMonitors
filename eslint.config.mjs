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
      'experiments/**',
      'apps/website/**',
      '**/*.config.ts',
      '**/*.config.mjs',
      '**/*.workspace.ts',
      // aipm repo-config (`aipm.repo.ts`): a root meta-config file outside any
      // package tsconfig, alongside the already-ignored *.config.ts/*.workspace.ts.
      '**/*.repo.ts',
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
  {
    files: ['scripts/**/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      parserOptions: {
        projectService: false,
      },
      globals: {
        console: 'readonly',
        process: 'readonly',
      },
    },
  },
  // CommonJS launcher bin — not part of any tsconfig project; disable type-checked
  // rules and supply Node CJS globals so `require`/`module`/`__dirname` etc. are
  // recognised without bringing in a tsconfig for a 10-line hand-written script.
  // Split into two objects so that spreading disableTypeChecked (which sets
  // languageOptions.parserOptions) is not silently overridden by our own
  // languageOptions entry. `no-require-imports` is also disabled: this file is
  // intentionally CommonJS (the `require()` calls are its entire purpose).
  {
    files: ['apps/agentmonitors/bin/**/*.cjs'],
    ...tseslint.configs.disableTypeChecked,
    rules: {
      ...tseslint.configs.disableTypeChecked.rules,
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  {
    files: ['apps/agentmonitors/bin/**/*.cjs'],
    languageOptions: {
      parserOptions: {
        projectService: false,
      },
      globals: {
        require: 'readonly',
        module: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        console: 'readonly',
        process: 'readonly',
      },
    },
  },
  eslintConfigPrettier,
);
