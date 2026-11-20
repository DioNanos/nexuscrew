'use strict';

// Test-only down plan for the direct recovery boundaries.
// The tables are LITERAL on purpose: the product keeps the only construction
// and scaling point, and the tests must not reimplement the formula.
const IDS = Object.freeze(['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8', 'p9']);

const TABLES = Object.freeze({
  200: Object.freeze({
    marginMs: 6,
    caps: Object.freeze([12, 18, 25, 6, 25, 12, 18, 50, 28]),
  }),
  2800: Object.freeze({
    marginMs: 87,
    caps: Object.freeze([175, 262, 350, 87, 350, 175, 262, 700, 352]),
  }),
  8000: Object.freeze({
    marginMs: 250,
    caps: Object.freeze([500, 750, 1000, 250, 1000, 500, 750, 2000, 1000]),
  }),
  15000: Object.freeze({
    marginMs: 250,
    caps: Object.freeze([937, 1406, 1875, 468, 1875, 937, 1406, 3750, 2096]),
  }),
});

function piano(budgetMs, deadlineAt) {
  const tabella = TABLES[budgetMs];
  if (!tabella) {
    throw new Error(`phase plan fixture missing for budget ${budgetMs}`);
  }
  if (!Number.isFinite(deadlineAt)) {
    throw new Error('phase plan fixture requires a finite deadlineAt');
  }
  const somma = tabella.caps.reduce((acc, v) => acc + v, 0) + tabella.marginMs;
  if (somma !== budgetMs) {
    throw new Error(`phase plan fixture inconsistent for budget ${budgetMs}`);
  }
  return {
    budgetMs,
    deadlineAt,
    marginMs: tabella.marginMs,
    phases: IDS.map((id, i) => ({ id, capMs: tabella.caps[i], allowanceMs: tabella.caps[i] })),
  };
}

module.exports = { piano, TABLES, IDS };
