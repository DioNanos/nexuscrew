// Column widths for the web terminal, aligned with the terminal on the other
// side of the wire.
//
// WHY THIS EXISTS. tmux (and glibc, which it uses to count columns) gives two
// columns to an East Asian Wide character; xterm 6.0.0's default provider
// (UnicodeV6) gives one to the emoji that started this: U+1F7E2, U+1F4CC and
// the rest of the measured case. The browser and the producer then disagree
// about where the next glyph goes, so each wide character leaves one column of
// stale pixels behind — the "stale glyphs after an emoji" on the phone.
//
// WHAT IT IS. A provider for the interface xterm documents
// (IUnicodeVersionProvider: `version`, `wcwidth`, `charProperties`), built on a
// generated range table (see scripts/gen-terminal-unicode-table.mjs). The
// `charProperties` arithmetic is the same one the default provider uses, bit
// layout included: width in bits 1-2, "should join" in bit 0.
import { TERMINAL_WIDE_RANGES, TERMINAL_ZERO_RANGES } from './terminal-unicode-table.js';

// Never '6': the default provider owns that name, and shadowing it would make
// `activeVersion` unable to say which provider is in use.
export const TERMINAL_WIDTH_VERSION = 'nc-15.1';

function inRanges(ranges, codepoint) {
  let low = 0;
  let high = ranges.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const [start, end] = ranges[mid];
    if (codepoint < start) high = mid - 1;
    else if (codepoint > end) low = mid + 1;
    else return true;
  }
  return false;
}

// xterm's own property encoding: (codepoint << 3) | (width << 1) | join.
function propertyValue(codepoint, width, shouldJoin) {
  return ((codepoint & 0xFFFFFF) << 3) | ((width & 3) << 1) | (shouldJoin ? 1 : 0);
}

export function terminalWcwidth(codepoint) {
  const cp = Number(codepoint);
  if (!Number.isFinite(cp) || cp < 0) return 0;
  // C0/C1 controls take no column, exactly as the default provider has them.
  if (cp < 32) return 0;
  if (cp >= 0x7F && cp < 0xA0) return 0;
  if (inRanges(TERMINAL_ZERO_RANGES, cp)) return 0;
  if (inRanges(TERMINAL_WIDE_RANGES, cp)) return 2;
  return 1;
}

export function createTerminalWidthProvider() {
  return {
    version: TERMINAL_WIDTH_VERSION,
    wcwidth: terminalWcwidth,
    charProperties(codepoint, preceding) {
      let width = terminalWcwidth(codepoint);
      let shouldJoin = width === 0 && preceding !== 0;
      if (shouldJoin) {
        const previousWidth = (preceding >> 1) & 3;
        if (previousWidth === 0) shouldJoin = false;
        else if (previousWidth > width) width = previousWidth;
      }
      return propertyValue(codepoint, width, shouldJoin);
    },
  };
}

// Registers the provider and makes it active. `term.unicode` is a proposed API:
// without `allowProposedApi: true` xterm throws on the getter, so the caller
// must treat a null return as "stay with the default provider" and never as a
// reason to fail the terminal.
export function registerTerminalWidth(term) {
  try {
    const unicode = term && term.unicode;
    if (!unicode || typeof unicode.register !== 'function') return null;
    const provider = createTerminalWidthProvider();
    if (!unicode.versions.includes(provider.version)) unicode.register(provider);
    unicode.activeVersion = provider.version;
    return provider;
  } catch (_) {
    return null;
  }
}
