#!/usr/bin/env node
// Generates src/lib/terminal-unicode-table.js: a COMPACT range table, never a
// 65k-entry array and never edited by hand.
//
// Why ranges and where they come from. The terminal on the other side of the
// wire is tmux on Linux: it counts columns with the glibc rules, where East
// Asian Wide/Fullwidth is two columns. The browser must count them the same way
// or every glyph after a wide character lands one column off.
//   - East Asian Width W/F over the BMP: `is-fullwidth-code-point` (the data
//     source, declared as a devDependency of this generator only).
//   - Emoji presentation: two columns in every modern terminal. That package
//     does not cover the astral emoji blocks, so the ranges are listed below —
//     they are ranges, not a table, and they are the only hand-written part.
//   - Combining marks and zero-width characters: zero columns.
// Run: node scripts/gen-terminal-unicode-table.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import isFullwidthCodePoint from 'is-fullwidth-code-point';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, '..', 'src', 'lib', 'terminal-unicode-table.js');

// Emoji presentation, wide (Unicode 15.1 Emoji_Presentation, wide blocks).
const EMOJI_WIDE = [
  [0x231A, 0x231B], [0x23E9, 0x23EC], [0x23F0, 0x23F0], [0x23F3, 0x23F3],
  [0x25FD, 0x25FE], [0x2614, 0x2615], [0x2648, 0x2653], [0x267F, 0x267F],
  [0x2693, 0x2693], [0x26A1, 0x26A1], [0x26AA, 0x26AB], [0x26BD, 0x26BE],
  [0x26C4, 0x26C5], [0x26CE, 0x26CE], [0x26D4, 0x26D4], [0x26EA, 0x26EA],
  [0x26F2, 0x26F3], [0x26F5, 0x26F5], [0x26FA, 0x26FA], [0x26FD, 0x26FD],
  [0x2705, 0x2705], [0x270A, 0x270B], [0x2728, 0x2728], [0x274C, 0x274C],
  [0x274E, 0x274E], [0x2753, 0x2755], [0x2757, 0x2757], [0x2795, 0x2797],
  [0x27B0, 0x27B0], [0x27BF, 0x27BF], [0x2B1B, 0x2B1C], [0x2B50, 0x2B50],
  [0x2B55, 0x2B55], [0x1F000, 0x1FAFF],
];

// Combining marks (Mn/Me), variation selectors and zero-width characters: the
// principal blocks, zero columns.
const ZERO = [
  [0x0300, 0x036F], [0x0483, 0x0489], [0x0591, 0x05BD], [0x05BF, 0x05BF], [0x05C1, 0x05C2],
  [0x05C4, 0x05C5], [0x05C7, 0x05C7], [0x0610, 0x061A], [0x064B, 0x065F], [0x0670, 0x0670],
  [0x06D6, 0x06DC], [0x06DF, 0x06E4], [0x06E7, 0x06E8], [0x06EA, 0x06ED], [0x0711, 0x0711],
  [0x0730, 0x074A], [0x07A6, 0x07B0], [0x07EB, 0x07F3], [0x0816, 0x0819], [0x081B, 0x0823],
  [0x0825, 0x0827], [0x0829, 0x082D], [0x0859, 0x085B], [0x08E3, 0x0903], [0x093A, 0x093C],
  [0x0941, 0x0948], [0x094D, 0x094D], [0x0951, 0x0957], [0x0962, 0x0963], [0x0981, 0x0981],
  [0x09BC, 0x09BC], [0x09C1, 0x09C4], [0x09CD, 0x09CD], [0x0A01, 0x0A02], [0x0A3C, 0x0A3C],
  [0x0A41, 0x0A42], [0x0A47, 0x0A48], [0x0A4B, 0x0A4D], [0x0A70, 0x0A71], [0x0ABC, 0x0ABC],
  [0x0AC1, 0x0AC5], [0x0AC7, 0x0AC8], [0x0ACD, 0x0ACD], [0x0B01, 0x0B01], [0x0B3C, 0x0B3C],
  [0x0B3F, 0x0B3F], [0x0B41, 0x0B44], [0x0B4D, 0x0B4D], [0x0C3E, 0x0C40], [0x0C46, 0x0C48],
  [0x0C4A, 0x0C4D], [0x0E31, 0x0E31], [0x0E34, 0x0E3A], [0x0E47, 0x0E4E], [0x0EB1, 0x0EB1],
  [0x0EB4, 0x0EBC], [0x0EC8, 0x0ECE], [0x0F18, 0x0F19], [0x0F35, 0x0F35], [0x0F37, 0x0F37],
  [0x0F39, 0x0F39], [0x0F71, 0x0F7E], [0x0F80, 0x0F84], [0x0F86, 0x0F87], [0x0FC6, 0x0FC6],
  [0x135D, 0x135F], [0x1712, 0x1714], [0x1732, 0x1734], [0x1752, 0x1753], [0x1772, 0x1773],
  [0x17B4, 0x17B5], [0x17B7, 0x17BD], [0x17C6, 0x17C6], [0x17C9, 0x17D3], [0x180B, 0x180D],
  [0x1AB0, 0x1AFF], [0x1DC0, 0x1DFF], [0x20D0, 0x20F0], [0x2CEF, 0x2CF1], [0x2D7F, 0x2D7F],
  [0x2DE0, 0x2DFF], [0x302A, 0x302F], [0x3099, 0x309A], [0xA66F, 0xA672], [0xA674, 0xA67D],
  [0xA69E, 0xA69F], [0xA6F0, 0xA6F1], [0xA802, 0xA802], [0xA806, 0xA806], [0xA80B, 0xA80B],
  [0xA825, 0xA826], [0xA8C4, 0xA8C5], [0xFB1E, 0xFB1E], [0xFE00, 0xFE0F], [0xFE20, 0xFE2F],
  [0xFEFF, 0xFEFF], [0x101FD, 0x101FD], [0x102E0, 0x102E0], [0x1D165, 0x1D169],
  [0x1D16D, 0x1D172], [0x1D17B, 0x1D182], [0x1D185, 0x1D18B], [0x1D1AA, 0x1D1AD],
  [0x1D242, 0x1D244], [0xE0100, 0xE01EF],
  // Format characters (Cf) and separators: zero columns, whatever they look
  // like. Every block below was checked with unicodedata (all Cf) and with
  // glibc's wcwidth, which answers 0 for each of them — the joiner U+200D is
  // the one that matters most here, because a single emoji sequence can carry
  // several of them.
  [0x200B, 0x200F], [0x2028, 0x202E], [0x2060, 0x2064], [0x2066, 0x206F],
  [0xFEFF, 0xFEFF], [0x1BCA0, 0x1BCA3], [0x1D173, 0x1D17A],
  [0xE0001, 0xE0001], [0xE0020, 0xE007F],
  // Hangul medial/final jamo: glibc counts 0 (the leading ones above stay wide).
  [0x1160, 0x11FF],
];

function merge(ranges) {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [start, end] of sorted) {
    const last = out[out.length - 1];
    if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end);
    else out.push([start, end]);
  }
  return out;
}

// East Asian Width over the BMP, from the data package (not written here).
const eaw = [];
let runStart = null;
for (let cp = 0; cp <= 0xFFFF; cp += 1) {
  const wide = isFullwidthCodePoint(cp) === true;
  if (wide && runStart === null) runStart = cp;
  if (!wide && runStart !== null) { eaw.push([runStart, cp - 1]); runStart = null; }
}
if (runStart !== null) eaw.push([runStart, 0xFFFF]);

// Regional indicators are NOT wide: glibc's wcwidth answers 1 for each of
// them (so a flag pair is two columns), and tmux counts the pair as two as
// well (measured on a private tmux socket: cursor_x 3 after the pair and a
// one-column character). They sit inside the astral emoji blocks, so they are
// subtracted from the wide set rather than left to the blanket range.
const NARROW_INSIDE_WIDE = [[0x1F1E6, 0x1F1FF]];

function subtract(ranges, holes) {
  let out = ranges.map(([start, end]) => [start, end]);
  for (const [holeStart, holeEnd] of holes) {
    const next = [];
    for (const [start, end] of out) {
      if (holeEnd < start || holeStart > end) { next.push([start, end]); continue; }
      if (start < holeStart) next.push([start, holeStart - 1]);
      if (end > holeEnd) next.push([holeEnd + 1, end]);
    }
    out = next;
  }
  return out;
}

const wide = merge(subtract(merge([...eaw, ...EMOJI_WIDE]), NARROW_INSIDE_WIDE));
const zero = merge(ZERO);

const body = `// GENERATED by scripts/gen-terminal-unicode-table.mjs — do not edit by hand.
// Compact [start, end] ranges, inclusive. Sources and reasoning are in the
// generator: East Asian Width W/F (data package) plus emoji presentation for
// the wide set, combining marks and zero-width characters for the zero set.
export const TERMINAL_WIDE_RANGES = Object.freeze(${JSON.stringify(wide)});
export const TERMINAL_ZERO_RANGES = Object.freeze(${JSON.stringify(zero)});
`;
fs.writeFileSync(OUT, body);
console.log(`written ${path.relative(process.cwd(), OUT)}: ${wide.length} wide ranges, ${zero.length} zero ranges`);
