'use strict';
// Synthetic composer fixtures for the 0.9.80 s2a composer parser (C6).
//
// PROVENANCE — READ THIS BEFORE EXTENDING. Every fixture and contract in
// this file is SYNTHETIC, authored for the test simulator of NexusCrew
// 0.9.80 strato 2a. None of it qualifies a real client: the product ships
// with an EMPTY contract registry, so a real Claude/Kimi composer resolves
// 'unknown' and the delivery is conservatively skipped (declared limit of
// 2a). Qualifying a real client requires a contract with verifiable
// provenance (pinned renderer/version/theme, or authorized non-sensitive
// samples) plus empty/placeholder/typed triples demonstrating the
// distinction — synthetic fixtures alone never do (DevAuditor C6,
// decision 4). The simulator contract below qualifies ONLY the simulator.
//
// Simulator rendering contract (what these fixtures model):
//  - prompt glyph '❯' rendered in cyan (SGR 36) then RESET;
//  - placeholder text rendered in a 24-bit gray
//    (SGR 38;2;136;136;136) when the composer is EMPTY;
//  - typed text rendered with DEFAULT attributes (no active SGR) after the
//    glyph; typed whitespace is still typed content (significant spaces);
//  - one blank line terminates the composer region (chrome/status below).

const GRAY = '\x1b[38;2;136;136;136m';
const CYAN = '\x1b[36m';
const RESET = '\x1b[0m';

const SIM_CLAUDE_CONTRACT = Object.freeze({
  client: 'claude',
  provenance: 'synthetic test simulator, NC 0.9.80 s2a tests only — qualifies no real client',
  renderer: 'nc-s2a-test-simulator',
  version: '1',
  theme: 'default',
  placeholderAttrs: Object.freeze(['38;2;136;136;136']),
  typedAttrs: Object.freeze(['']),
});

// Empty composer WITH the gray placeholder: must classify 'empty'.
const CLAUDE_EMPTY = `${CYAN}❯${RESET} ${GRAY}Try "create a util logging.py that..."${RESET}`;

// Typed text (default attrs): must classify 'occupied'.
const CLAUDE_TYPED = (t) => `${CYAN}❯${RESET} ${t}`;

// Placeholder PLUS typed tail (suggestion with real input): 'occupied'.
const CLAUDE_PLACEHOLDER_PLUS_TYPED = `${CYAN}❯${RESET} ${GRAY}Try "${RESET}build the logging module`;

// Multi-line typed composer: continuation line carries typed content.
const CLAUDE_MULTILINE = `${CLAUDE_TYPED('first line of input')}\nsecond line of input`;

// Placeholder-only wrap across two lines: still 'empty'.
const CLAUDE_EMPTY_WRAPPED = `${CYAN}❯${RESET} ${GRAY}Try "create a util logging.py${RESET}\n${GRAY} that... "${RESET}`;

// Significant spaces typed into the composer (no placeholder): 'occupied'.
const CLAUDE_SPACES = `${CYAN}❯${RESET} ${RESET}   `;

// Cursor moved inside typed text (text present, cursor not at start): 'occupied'.
const CLAUDE_CURSOR_MOVED = `${CYAN}❯${RESET} build the log|ging module`;

// Unknown theme/color: content in an SGR the contract does not know.
const CLAUDE_UNKNOWN_THEME = `${CYAN}❯${RESET} \x1b[35mTry "create a util logging.py that..."\x1b[0m`;

// Attributes MISSING entirely (plain capture, escapes stripped/lost).
const CLAUDE_NO_ATTRS = '❯ build the logging module';

// Truncated/malformed escape sequence.
const CLAUDE_BROKEN_ESCAPE = `${CYAN}❯${RESET} \x1b[38;2;136Try "create a util logging.py..."`;

// Empty composer with NO placeholder at all: unqualified rendering.
const CLAUDE_BARE_PROMPT = `${CYAN}❯${RESET} `;

// Full composer region as a pane-like capture (blank line closes the region,
// chrome below must not be read as continuation).
const CLAUDE_EMPTY_REGION = [
  '│             Welcome back!          │',
  '',
  '────────────────────────────────────',
  CLAUDE_EMPTY,
  '',
  '  ⏸ manual mode on · ? for shortcuts · ← for agents                               ● high · /effort',
].join('\n');

// Kimi box composer (synthetic, same provenance limits). No qualified Kimi
// contract exists in 2a: every Kimi capture resolves 'unknown' (decision 3).
const KIMI_BOX_EMPTY = ' ╭──────────────────────────────────────────╮\n │ >                                        │\n ╰──────────────────────────────────────────╯';

// Plain (no -e) ready capture for the readiness loop: the ❯ line classifies
// 'ready' for client claude.
const CLAUDE_READY_LIKE = [
  '│             Welcome back!          │',
  '',
  '────────────────────────────────────',
  '❯ ',
  '────────────────────────────────────',
  '  ⏸ manual mode on · ? for shortcuts · ← for agents                               ● high · /effort',
].join('\n');

// Attrs (-e) capture of an EMPTY composer (placeholder) as the simulator
// renders it, with the blank line closing the composer region.
const CLAUDE_ATTRS_EMPTY = [
  '────────────────────────────────────',
  CLAUDE_EMPTY,
  '',
  '  ⏸ manual mode on · ? for shortcuts · ← for agents                               ● high · /effort',
].join('\n');

// Not-ready plain screens (same markers as the live-verified fixtures of
// fleet-prompt-delivery.test.js; synthetic copies for this file).
const CLAUDE_CONSENT_LIKE = '  Detected a custom API key in your environment\n\n  Do you want to use this API key?\n\n  ❯ 2. No (recommended)\n';
const CLAUDE_TRUST_LIKE = ' Quick safety check: Is this a project you created or one you trust?\n\n ❯ 1. Yes, I trust this folder\n';
const CLAUDE_AUTH_LIKE = '❯ \n  ⏸ manual mode on · ? for shortcuts · ← for agents                     Not logged in · Run /login\n';

module.exports = {
  GRAY, CYAN, RESET,
  SIM_CLAUDE_CONTRACT,
  CLAUDE_EMPTY, CLAUDE_TYPED, CLAUDE_PLACEHOLDER_PLUS_TYPED, CLAUDE_MULTILINE,
  CLAUDE_EMPTY_WRAPPED, CLAUDE_SPACES, CLAUDE_CURSOR_MOVED, CLAUDE_UNKNOWN_THEME,
  CLAUDE_NO_ATTRS, CLAUDE_BROKEN_ESCAPE, CLAUDE_BARE_PROMPT, CLAUDE_EMPTY_REGION,
  KIMI_BOX_EMPTY, CLAUDE_READY_LIKE, CLAUDE_ATTRS_EMPTY,
  CLAUDE_CONSENT_LIKE, CLAUDE_TRUST_LIKE, CLAUDE_AUTH_LIKE,
};
