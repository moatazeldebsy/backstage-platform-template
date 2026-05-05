module.exports = {
  default: {
    require: ['steps/**/*.ts'],
    requireModule: ['ts-node/register'],
    format: [
      '${{ values.format }}',
      'junit:reports/junit.xml',
    ],
    paths: ['features/**/*.feature'],
    publishQuiet: true,
  },
};
