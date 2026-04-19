'use strict';

function parseArgv(argv) {
  const args = argv.slice(2);
  const positionals = [];
  const options = Object.create(null);

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith('-')) {
      positionals.push(arg);
      continue;
    }

    if (arg === '--json' || arg === '-j') {
      options.json = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }

    const eqIndex = arg.indexOf('=');
    let key = arg;
    let value = null;
    if (eqIndex !== -1) {
      key = arg.slice(0, eqIndex);
      value = arg.slice(eqIndex + 1);
    }

    if (value === null) {
      value = args[i + 1];
      if (typeof value === 'undefined' || value.startsWith('-')) {
        value = true;
      } else {
        i += 1;
      }
    }

    const normalizedKey = key.replace(/^--?/, '').replace(/-([a-z])/g, (_, chr) => chr.toUpperCase());
    if (normalizedKey === 'scope') {
      if (!Array.isArray(options.scope)) {
        options.scope = [];
      }
      options.scope.push(value);
      continue;
    }
    options[normalizedKey] = value;
  }

  return {
    command: positionals[0] || 'help',
    positionals: positionals.slice(1),
    options,
  };
}

module.exports = {
  parseArgv,
};
