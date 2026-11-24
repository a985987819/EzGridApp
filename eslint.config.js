import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'

export default tseslint.config(
  { ignores: ['dist', 'e2e/out', 'tmpcache', '.tmp', 'node_modules'] },
  {
    files: ['**/*.{ts,tsx}'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      globals: { ...globals.browser, ...globals.node },
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  // 工程原则（AGENTS.md「工程原则」）的自动门禁：domain 纯函数单源、写库唯一在 store、pages 只消费派生 Ledger。
  {
    files: ['src/domain/**/*.ts'],
    ignores: ['src/domain/**/*.spec.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['react', 'react-*'], message: 'domain/* 必须是纯函数，不依赖 React。' },
            {
              group: ['**/store/**', '**/ui/**', '**/components/**', '**/pages/**', '**/io/**', 'xlsx', 'dexie'],
              message: 'domain/* 不得依赖 IO / 写库 / UI 层：业务口径只能在 domain 内单源。',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/pages/**/*.{ts,tsx}', 'src/components/**/*.{ts,tsx}'],
    ignores: ['src/**/*.spec.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/store/db', 'dexie'],
              message: '页面/组件禁止直接访问 Dexie：写库唯一走 store/useApp 的 action。',
            },
          ],
        },
      ],
    },
  },
)
