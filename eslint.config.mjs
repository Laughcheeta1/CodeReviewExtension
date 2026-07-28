import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
export default tseslint.config(eslint.configs.recommended, ...tseslint.configs.recommendedTypeChecked, {
    languageOptions: {
        parserOptions: {
            projectService: true,
            tsconfigRootDir: import.meta.dirname
        }
    },
    rules: {
        '@typescript-eslint/no-floating-promises': 'error',
        'array-bracket-spacing': ['error', 'never'],
        'brace-style': ['error', '1tbs', { allowSingleLine: true }],
        'curly': ['error', 'all'],
        'comma-spacing': ['error', { before: false, after: true }],
        'computed-property-spacing': ['error', 'never'],
        'func-call-spacing': ['error', 'never'],
        'keyword-spacing': ['error', { before: true, after: true }],
        'key-spacing': ['error', { beforeColon: false, afterColon: true }],
        'object-curly-spacing': ['error', 'always'],
        'semi': ['error', 'always'],
        'space-before-blocks': ['error', 'always'],
        'space-before-function-paren': ['error', { anonymous: 'always', named: 'never', asyncArrow: 'always' }],
        'space-in-parens': ['error', 'never'],
        'space-infix-ops': 'error',
        'space-unary-ops': ['error', { words: true, nonwords: false }],
        'spaced-comment': ['error', 'always']
    }
}, { files: ['test/**/*.ts'], rules: { '@typescript-eslint/no-floating-promises': 'off' } }, { ignores: ['dist/**', 'node_modules/**', 'test/integration/**/*.js', 'test/integration/**/*.mjs'] });

