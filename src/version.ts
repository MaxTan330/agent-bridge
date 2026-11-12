import pkg from '../package.json' with { type: 'json' };

/** Package version is shared by the CLI, ACP handshake and release artifacts. */
export const version = pkg.version;
