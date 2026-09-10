const isps = require('../data/isp-flags.json');
const { normalize } = require('./deviceLookup');

function lookupIsp(rawInput) {
  const input = normalize(rawInput);
  if (!input) return null;

  for (const isp of isps) {
    if (isp.aliases.some((alias) => {
      const a = normalize(alias);
      return input === a || input.includes(a) || a.includes(input);
    })) {
      return isp;
    }
  }
  return null;
}

module.exports = { lookupIsp };
