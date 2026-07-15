'use strict';

const os = require('node:os');
const path = require('node:path');

const MINIMAL_ENV_KEYS = Object.freeze([
  'PATH', 'HOME', 'SHELL', 'TERM', 'COLORTERM', 'LANG', 'LANGUAGE',
  'LC_ALL', 'LC_CTYPE', 'USER', 'LOGNAME', 'TMUX', 'TMUX_TMPDIR',
  'XDG_RUNTIME_DIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME',
  'DBUS_SESSION_BUS_ADDRESS',
  // Termux/Android native clients need these to resolve their runtime, tmp and
  // platform paths.  They are location metadata, never credentials.
  'PREFIX', 'TMPDIR', 'TERMUX_VERSION', 'ANDROID_DATA', 'ANDROID_ROOT',
]);

const UTF8_RE = /utf-?8/i;

function localeDefaults(platform = process.platform, env = process.env) {
  const termux = platform === 'android' || String(env.PREFIX || '').includes('com.termux');
  if (platform === 'darwin') return { lang: 'en_US.UTF-8', ctype: 'UTF-8' };
  if (termux) return { lang: 'en_US.UTF-8', ctype: 'en_US.UTF-8' };
  return { lang: 'C.UTF-8', ctype: 'C.UTF-8' };
}

function withUtf8Locale(source = process.env, { platform = process.platform } = {}) {
  const env = { ...source };
  const defaults = localeDefaults(platform, env);
  const effective = env.LC_ALL || env.LC_CTYPE || env.LANG || '';
  if (!UTF8_RE.test(effective)) {
    if (env.LC_ALL) env.LC_ALL = defaults.lang;
    env.LANG = defaults.lang;
    env.LC_CTYPE = defaults.ctype;
  } else {
    if (!env.LANG) env.LANG = defaults.lang;
    if (!env.LC_CTYPE) env.LC_CTYPE = env.LC_ALL || env.LANG || defaults.ctype;
  }
  if (!env.TERM) env.TERM = 'xterm-256color';
  return env;
}

// Termux installs tmux with TMUX_TMPDIR=$PREFIX/var/run via a profile.d
// snippet. Background runtimes and Termux:Boot do not necessarily source that
// profile, so a first `tmux new-session` would otherwise try the Android/FHS
// fallback instead of the canonical Termux socket directory. Derive only from
// an explicit PREFIX or the standard .../files/home layout; never guess paths
// for Linux/macOS.
function termuxRuntimePaths(source = process.env, opts = {}) {
  const platform = opts.platform || process.platform;
  const home = String(source.HOME || opts.home || os.homedir());
  const suppliedPrefix = String(source.PREFIX || '');
  const termux = platform === 'android'
    || suppliedPrefix.includes('com.termux')
    || (path.basename(home) === 'home' && path.basename(path.dirname(home)) === 'files');
  if (!termux) return null;

  let prefix = suppliedPrefix;
  if (!prefix && path.basename(home) === 'home' && path.basename(path.dirname(home)) === 'files') {
    prefix = path.join(path.dirname(home), 'usr');
  }
  if (!path.isAbsolute(prefix)) return null;
  return {
    prefix,
    tmpdir: String(source.TMPDIR || path.join(prefix, 'tmp')),
    tmuxTmpdir: String(source.TMUX_TMPDIR || path.join(prefix, 'var', 'run')),
  };
}

function minimalRuntimeEnv(source = process.env, opts = {}) {
  const selected = {};
  for (const key of MINIMAL_ENV_KEYS) {
    if (source[key] !== undefined && source[key] !== '') selected[key] = String(source[key]);
  }
  if (!selected.PATH) selected.PATH = '/usr/local/bin:/usr/bin:/bin';
  if (!selected.HOME) selected.HOME = opts.home || os.homedir();
  const termux = termuxRuntimePaths(selected, opts);
  if (termux) {
    if (!selected.PREFIX) selected.PREFIX = termux.prefix;
    if (!selected.TMPDIR) selected.TMPDIR = termux.tmpdir;
    if (!selected.TMUX_TMPDIR) selected.TMUX_TMPDIR = termux.tmuxTmpdir;
  }
  return withUtf8Locale(selected, opts);
}

module.exports = {
  MINIMAL_ENV_KEYS, UTF8_RE, localeDefaults, withUtf8Locale,
  termuxRuntimePaths, minimalRuntimeEnv,
};
