'use strict';

const fs = require('node:fs');
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
    // Termux Google Play (targetSdk >= 29) runs under the SELinux `untrusted_app`
    // domain, which forbids execve() of files in the app's data directory unless
    // libtermux-exec is preloaded (it redirects those execs to the system linker).
    // The shared tmux server and every pane are launched with this minimal env,
    // so without the preload every command pane dies at execve. Preserve ONLY the
    // validated trusted preload; every other LD_*/provider/credential value stays
    // dropped as before. Fail-closed: any doubt -> drop, never pass through.
    const trusted = trustedTermuxPreload(source, opts);
    if (trusted) selected.LD_PRELOAD = trusted;
  }
  return withUtf8Locale(selected, opts);
}

// Basenames of the trusted termux-exec preload library shipped by Termux.
// Modern builds ship `libtermux-exec-ld-preload.so`; older ones shipped
// `libtermux-exec.so`. The optional numeric segment accepts a versioned
// variant; every other name is rejected. This IS the allowlist: adding a new
// trusted entry requires extending this regex (after a device-specific proof).
const TERMUX_EXEC_BASENAME_RE = /^libtermux-exec(?:-ld-preload)?(?:-\d+(?:\.\d+)*)?\.so$/;

// Pure validator for the single Termux LD_PRELOAD entry minimalRuntimeEnv may
// preserve. Returns the canonical realpath of the trusted library, or null when
// the value is absent, non-Termux, relative, a list/mixed value, outside the
// active Termux PREFIX/lib, missing, non-regular, world/group-writable, or not
// owned by the running user (or root). Never throws, never logs.
//
// Security model: the preload must come from the already-trusted service env
// (the attacker who controls that env is already inside the trust domain). We
// only make sure it cannot escape that domain: a relative path, a foreign
// library, or a path planted outside PREFIX/lib is dropped as if absent.
function trustedTermuxPreload(source = process.env, opts = {}) {
  const raw = source && source.LD_PRELOAD;
  if (typeof raw !== 'string' || raw === '') return null;
  // Reject list-shaped / ambiguous / mixed values: LD_PRELOAD accepts a
  // colon-(or space-)separated list; we only ever preserve a single entry.
  if (/[ \t\r\n:]/.test(raw)) return null;
  if (raw.includes('\0')) return null;
  if (!path.isAbsolute(raw)) return null;
  // Only when the runtime is genuinely Termux (PREFIX or files/home layout).
  const termux = termuxRuntimePaths(source, opts);
  if (!termux || !termux.prefix) return null;
  let realPrefix;
  let realRaw;
  try {
    realPrefix = fs.realpathSync(termux.prefix);
    realRaw = fs.realpathSync(raw);
  } catch (_) { return null; }
  // Resolve the canonical trusted directory and require the library to live in
  // it directly (no nested paths, no elsewhere). Both sides are realpath'd so a
  // symlinked PREFIX or a planted symlink cannot escape.
  const trustedDir = path.join(realPrefix, 'lib');
  if (path.dirname(realRaw) !== trustedDir) return null;
  const base = path.basename(realRaw);
  if (!TERMUX_EXEC_BASENAME_RE.test(base)) return null;
  let st;
  try { st = fs.lstatSync(realRaw); } catch (_) { return null; }
  if (!st.isFile()) return null;                  // regular file only (realpath already resolved symlinks)
  if (st.mode & 0o022) return null;               // not group/world-writable
  if (typeof process.getuid === 'function' && st.uid !== process.getuid() && st.uid !== 0) return null;
  return realRaw;
}

module.exports = {
  MINIMAL_ENV_KEYS, UTF8_RE, localeDefaults, withUtf8Locale,
  termuxRuntimePaths, minimalRuntimeEnv, trustedTermuxPreload, TERMUX_EXEC_BASENAME_RE,
};
