export default [{
    files: ['extension/**/*.js'],
    languageOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
        globals: {logError: 'readonly', TextDecoder: 'readonly'},
    },
    rules: {
        'no-undef': 'error',
        'no-unused-vars': ['error', {args: 'none', caughtErrors: 'none', varsIgnorePattern: '^_'}],
        'no-dupe-keys': 'error',
        'no-unreachable': 'error',
        'no-constant-condition': 'error',
        'eqeqeq': 'error',
        'no-trailing-spaces': 'error',
        'eol-last': ['error', 'always'],
        'no-multiple-empty-lines': ['error', {max: 1, maxEOF: 0}],
        'max-len': ['error', {code: 200}],
    },
}];
