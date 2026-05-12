module.exports = {
  default: {
    require: ['steps/**/*.ts'],
    requireModule: ['ts-node/register'],
    format: ['progress-bar', 'junit:reports/junit.xml'],
    paths: ['features/**/*.feature'],
    publishQuiet: true,
  },
};
