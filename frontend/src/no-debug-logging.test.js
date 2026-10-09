import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

// Guardia di pubblicazione: nessun console.log nei sorgenti del frontend
// (i file di test sono esclusi). Il bundle npm spedisce questi file: un log
// di debug dimenticato finisce nella console dell'operatore con dentro
// route e topologia. Se questo test fallisce, togli il log prima di
// committare — non aggiungere il file alla lista dei consentiti.
const SRC = resolve(process.cwd(), 'src');

function collect(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) collect(full, out);
    else if (/\.(js|jsx)$/.test(entry.name) && !/\.test\./.test(entry.name)) {
      const text = readFileSync(full, 'utf8');
      const lines = text.split('\n');
      lines.forEach((line, i) => {
        if (/console\.log\(/.test(line)) out.push(`${full.replace(`${SRC}/`, '')}:${i + 1}`);
      });
    }
  }
  return out;
}

describe('guardia: nessun console.log nei sorgenti del frontend', () => {
  it('nessun file non-di-test contiene console.log', () => {
    expect(collect(SRC)).toEqual([]);
  });
});
