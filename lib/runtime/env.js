'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MINIMAL_ENV_KEYS = Object.freeze([
  'PATH', 'HOME', 'SHELL', 'TERM', 'COLORTERM', 'LANG', 'LANGUAGE',
  'LC_ALL', 'LC_CTYPE', 'USER', 'LOGNAME', 'TMUX_TMPDIR',
  'XDG_RUNTIME_DIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME',
  'DBUS_SESSION_BUS_ADDRESS',
  // Termux/Android native clients need these to resolve their runtime, tmp and
  // platform paths.  They are location metadata, never credentials.
  'PREFIX', 'TMPDIR', 'TERMUX_VERSION', 'ANDROID_DATA', 'ANDROID_ROOT',
]);
// NOTE: TMUX is deliberately NOT in this allowlist.  A bare tmux client (no
// -S) lets $TMUX select the socket it connects to, which could disagree with
// the configured default every NexusCrew surface is meant to reach; see
// tmuxClientEnv() below for the single socket-selection policy.  TMUX set by
// tmux itself inside a pane is unaffected: tmux exports it to the processes it
// hosts regardless of what the spawning client carried.

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

// C17 — BASE EREDITATA DELLE CELLE INTERATTIVE (client e shell).
//
// Funzione PURA sulla sola base che finisce nel payload della cella: un TERM
// inutilizzabile diventa il ripiego e le due variabili di colore che l'operatore
// non ha scelto non entrano. NON e' una modifica di minimalRuntimeEnv: gli altri
// client tmux e i servizi restano com'erano. L'env esplicito dell'engine viene
// applicato DOPO, quindi una scelta dell'operatore vince sempre su questa base.
const TERM_RIPIEGO = 'xterm-256color';
const TERM_INUTILIZZABILI = Object.freeze(['dumb', 'unknown']);

function baseEreditataCella(base) {
  if (!base || typeof base !== 'object' || Array.isArray(base)) return {};
  const out = { ...base };
  // Solo la BASE: chi li vuole davvero li mette nell'env dell'engine.
  delete out.NO_COLOR;
  delete out.FORCE_COLOR;
  // Riconoscimento NORMALIZZATO (spazi e maiuscole) dei valori inutilizzabili:
  // assente, vuoto, «dumb», «unknown». Ogni altro TERM resta com'e'.
  const term = typeof out.TERM === 'string' ? out.TERM.trim() : '';
  if (!term || TERM_INUTILIZZABILI.includes(term.toLowerCase())) out.TERM = TERM_RIPIEGO;
  return out;
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

// SINGLE SOCKET-SELECTION POLICY.  Every tmux process NexusCrew spawns talks
// to the configured default socket — $TMUX_TMPDIR when set (minimalRuntimeEnv
// derives the Termux service value from PREFIX), otherwise /tmp, then
// tmux-<uid>/default — and never lets $TMUX choose for it: a bare client
// would prefer the socket recorded in $TMUX and could land on a different
// server than the launch, the protection and the -S-less surfaces.  tmuxClientEnv()
// removes TMUX from the environment of those invocations; sharedTmuxSocketPath()
// resolves the same default for the argv that pass -S explicitly.  One policy,
// two entry points, no interpretation of TMUX anywhere.
// A usable socket directory is an absolute path. A relative value, an empty
// value, or a non-string is not one: tmux would resolve a relative
// TMUX_TMPDIR against the client cwd, which is not the /tmp base the
// resolver already chooses.
function absoluteTmuxTmpdir(value) {
  if (typeof value !== 'string' || value.length === 0) return '';
  if (value.includes('\0')) return '';
  if (!value.startsWith('/')) return '';
  return value;
}

function tmuxClientEnv(source = process.env) {
  const out = { ...source };
  delete out.TMUX;
  if (!absoluteTmuxTmpdir(out.TMUX_TMPDIR)) delete out.TMUX_TMPDIR;
  return out;
}

// The pathname of the SHARED tmux server's default socket, resolved the way a
// tmux client WITHOUT $TMUX resolves it (and therefore the way every `-S`-less
// surface reaches the same server, because tmuxClientEnv() keeps TMUX out of
// their environment: sessionExists, pasteToSession, the PWA terminal,
// `tmux ls`): $TMUX_TMPDIR when set — minimalRuntimeEnv() derives the Termux
// service value from PREFIX — otherwise /tmp, then tmux-<uid>/
// default. A relative or invalid TMUX_TMPDIR is dropped by tmuxClientEnv and
// ignored here, so every client falls back to the same /tmp base instead of
// resolving the relative value against its cwd. The result is always
// absolute, which is the only constraint tmux-control.js puts on the socket
// a launch may be born on. The directory is never created here: it belongs
// to tmux, not to us.
function sharedTmuxSocketPath(source = process.env, opts = {}) {
  const env = minimalRuntimeEnv(source, opts);
  const tmpdir = absoluteTmuxTmpdir(env.TMUX_TMPDIR);
  const base = tmpdir || '/tmp';
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  return path.join(base, `tmux-${uid}`, 'default');
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
  termuxRuntimePaths, minimalRuntimeEnv, baseEreditataCella, trustedTermuxPreload, TERMUX_EXEC_BASENAME_RE,
  sharedTmuxSocketPath, tmuxClientEnv,
};
