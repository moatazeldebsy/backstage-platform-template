const factory = require('@backstage/cli/config/eslint-factory')(__dirname);

module.exports = {
  ...factory,
  rules: {
    ...factory.rules,
    // `x != null` is the idiomatic null-or-undefined check and is what this
    // codebase uses throughout (nullable API fields, optional Prometheus
    // values). Rewriting each to `!== null && !== undefined` would be longer and
    // no safer, so allow the null comparison while keeping eqeqeq strict
    // everywhere else.
    eqeqeq: ['error', 'always', { null: 'ignore' }],
  },
};
