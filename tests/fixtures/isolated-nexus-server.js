'use strict';

// Child-process fixture for the Share field gate. Every path and port comes
// from a dedicated temporary specification; no operator state or tmux socket
// is read. HTTP/federation is real, while the SSH supervisor boundary is an
// inert seam so the test can exercise authorization without opening tunnels.
const { createServer } = require('../../lib/server.js');

const spec = JSON.parse(process.env.NEXUSCREW_FIELD_SPEC || '{}');
if (!spec || typeof spec !== 'object' || !spec.home || !spec.nodesPath
  || !spec.tokenPath || !spec.configPath) {
  throw new Error('invalid isolated NexusCrew field specification');
}
if (process.env.NEXUSCREW_CONFIG_FILE !== spec.configPath) {
  throw new Error('isolated config override missing');
}

const made = createServer({
  home: spec.home,
  configDir: `${spec.home}/.nexuscrew`,
  configPath: spec.configPath,
  nodesPath: spec.nodesPath,
  tokenPath: spec.tokenPath,
  filesRoot: `${spec.home}/files`,
  bind: '127.0.0.1',
  port: Number.isInteger(spec.port) ? spec.port : 0,
  autoPort: false,
  autoUpdate: false,
  fleetEnabled: false,
  log: () => {},
  settingsSeams: {
    platform: 'linux',
    fetchImpl: fetch,
    pairDelay: async () => {},
    stopTunnelImpl: () => ({ stopped: true }),
    startForwardImpl: ({ node }) => {
      if (process.send) process.send({ type: 'forward', shared: node.shared === true });
      return { started: true, transport: 'isolated-field' };
    },
    readTunnelDiagnostic: () => ({ detail: 'isolated field tunnel unavailable' }),
  },
});

let closing = false;
function close(code = 0) {
  if (closing) return;
  closing = true;
  const timer = setTimeout(() => process.exit(code || 1), 3000);
  timer.unref();
  made.server.close(() => {
    clearTimeout(timer);
    process.exit(code);
  });
}

made.server.once('error', (error) => {
  if (process.send) process.send({ type: 'error', message: String(error && error.message || error) });
  close(1);
});
made.server.listen(Number.isInteger(spec.port) ? spec.port : 0, '127.0.0.1', () => {
  if (process.send) process.send({ type: 'ready', port: made.server.address().port });
});

process.on('SIGTERM', () => close(0));
process.on('SIGINT', () => close(0));
