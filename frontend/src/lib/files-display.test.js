import { describe, expect, it } from 'vitest';
import {
  fileDisplayName, fileStampDate, fileWhen, formatFileSize, fileExt,
  formatRowTime, formatDayLabel, formatFullWhen, groupFilesByDay, isPreviewable,
  fileKind, isOpenable, isNavigableMime, duplicateCounts,
} from './files-display.js';

// Le date sono costruite locali (new Date(anno, mese, giorno, …)): il
// risultato non dipende dal fuso di chi lancia i test, come lo stamp del server
// (lib/files/store.js scrive ore locali nel nome).

const NOON = (y, mo, d, h = 12, mi = 0) => new Date(y, mo - 1, d, h, mi);

describe('fileDisplayName — prefissi via via tolti, nome reale intatto', () => {
  it('toglie lo stamp dell\'arrivo YYYYMMDD-HHMM_', () => {
    expect(fileDisplayName('20261014-0930_report.md')).toBe('report.md');
  });

  it('toglie anche il secondo prefisso YYYY-MM-DD_ del mittente', () => {
    expect(fileDisplayName('20261014-0930_2026-10-14_report.md')).toBe('report.md');
  });

  it('toglie il secondo prefisso anche senza stamp davanti (file messo a mano)', () => {
    expect(fileDisplayName('2026-10-13_fattura.pdf')).toBe('fattura.pdf');
  });

  it('nessun prefisso: il nome resta identico', () => {
    expect(fileDisplayName('relazione finale.txt')).toBe('relazione finale.txt');
    expect(fileDisplayName('a.txt')).toBe('a.txt');
  });

  it('lo stamp senza underscore NON è un prefisso (data-che-sembra-nome)', () => {
    expect(fileDisplayName('20261014-0930-nota.md')).toBe('20261014-0930-nota.md');
  });

  it('il prefisso di dedup N- resta visibile: due gemelli restano distinti', () => {
    expect(fileDisplayName('1-20261014-0930_report.md')).toBe('1-report.md');
  });

  it('nomi lunghi: si tolgono solo i prefissi, il resto resta tutto', () => {
    const lungo = `${'x'.repeat(180)}.tar.gz`;
    expect(fileDisplayName(`20261014-0930_${lungo}`)).toBe(lungo);
  });

  it('estensioni note e insolite passano intatte', () => {
    expect(fileDisplayName('20261014-0930_foto.jPg')).toBe('foto.jPg');
    expect(fileDisplayName('20261014-0930_archivio.tar.gz')).toBe('archivio.tar.gz');
    expect(fileDisplayName('20261014-0930_noext')).toBe('noext');
  });

  it('totale: nome vuoto o degenere non produce un nome vuoto', () => {
    expect(fileDisplayName('')).toBe('');
    expect(fileDisplayName('20261014-0930_file')).toBe('file');
  });
});

describe('fileStampDate — il momento d\'arrivo ricavato dal nome', () => {
  it('parse lo stamp come data locale', () => {
    const d = fileStampDate('20261014-0935_report.md');
    expect([d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes()])
      .toEqual([2026, 10, 14, 9, 35]);
  });

  it('null senza prefisso valido', () => {
    expect(fileStampDate('report.md')).toBeNull();
    expect(fileStampDate('')).toBeNull();
  });

  it('legge lo stamp anche dietro l\'indice di dedup', () => {
    const d = fileStampDate('2-20261013-2205_report.md');
    expect([d.getDate(), d.getHours(), d.getMinutes()]).toEqual([13, 22, 5]);
  });

  it('cifre impossibili non rotolano in avanti: non è uno stamp', () => {
    // mese 13, giorno 45, ora 99: per il Date constructor sono conferme arrotolate
    expect(fileStampDate('20261345-9999_report.md')).toBeNull();
  });
});

describe('fileWhen — lo stamp vince, l\'mtime è il ripiego', () => {
  it('usa lo stamp del nome quando c\'è', () => {
    const w = fileWhen('20261014-0930_report.md', NOON(2026, 1, 1).getTime());
    expect([w.getMonth() + 1, w.getDate(), w.getHours(), w.getMinutes()]).toEqual([10, 14, 9, 30]);
  });

  it('usa l\'mtime quando il nome non ha stamp', () => {
    const w = fileWhen('report.md', NOON(2025, 3, 2, 8, 5).getTime());
    expect([w.getFullYear(), w.getMonth() + 1, w.getDate(), w.getHours(), w.getMinutes()])
      .toEqual([2025, 3, 2, 8, 5]);
  });

  it('mtime assente o rotto: epoca, non NaN', () => {
    expect(fileWhen('report.md').getTime()).toBe(0);
    expect(Number.isNaN(fileWhen('report.md', NaN).getTime())).toBe(false);
  });
});

describe('formatFileSize — leggibile KB/MB', () => {
  it('byte piccoli, KB, MB con un decimale', () => {
    expect(formatFileSize(0)).toBe('0 B');
    expect(formatFileSize(512)).toBe('512 B');
    expect(formatFileSize(2048)).toBe('2 KB');
    expect(formatFileSize(348160)).toBe('340 KB');
    expect(formatFileSize(1572864)).toBe('1.5 MB');
    expect(formatFileSize(52_428_800)).toBe('50.0 MB');
  });

  it('i KB sotto l\'uno non spariscono in zero', () => {
    expect(formatFileSize(1023)).toBe('1023 B');
    expect(formatFileSize(1500)).toBe('1 KB');
  });
});

describe('fileExt — badge tipo della riga', () => {
  it('estensione maiuscola, max 4 caratteri, dal nome visualizzato', () => {
    expect(fileExt('20261014-0930_report.md')).toBe('MD');
    expect(fileExt('20261014-0930_foto.jpeg')).toBe('JPEG');
    expect(fileExt('20261014-0930_archivio.tar.gz')).toBe('GZ');
    expect(fileExt('20261014-0930_document.docx')).toBe('DOCX');
  });

  it('vuota senza estensione o con nome nascosto', () => {
    expect(fileExt('20261014-0930_note')).toBe('');
    expect(fileExt('.hidden')).toBe('');
    expect(fileExt('')).toBe('');
  });

  it('isPreviewable: i tipi che il browser mostra in linea, gli altri no', () => {
    expect(isPreviewable('20261014-0930_foto.png')).toBe(true);
    expect(isPreviewable('20261014-0930_doc.pdf')).toBe(true);
    expect(isPreviewable('20261014-0930_note.md')).toBe(true);
    expect(isPreviewable('20261014-0930_archivio.zip')).toBe(false);
    expect(isPreviewable('20261014-0930_app.bin')).toBe(false);
    expect(isPreviewable('senza')).toBe(false);
  });
});

describe('isOpenable — tipi navigabili come documento in una scheda', () => {
  it('immagini raster, pdf e testo si aprono', () => {
    for (const n of ['foto.png', 'IMG_0001.jpg', 'clip.jpeg', 'schermo.webp', 'fattura.pdf', 'note.txt', 'report.md', 'dump.json']) {
      expect(isOpenable(`20261014-0930_${n}`)).toBe(true);
    }
  });

  it('l\'SVG non si apre come documento: si scarica, o resta nel <img> del dettaglio', () => {
    // Aperto come documento un SVG non fidato esegue script e handler; in
    // <img> no. Quindi: mai voce «Apri»/«Anteprima» che navighi un SVG.
    expect(isOpenable('20261014-0930_logo.svg')).toBe(false);
  });

  it('isPreviewable resta vera per l\'SVG: il dettaglio desktop lo mostra in <img>', () => {
    expect(isPreviewable('20261014-0930_logo.svg')).toBe(true);
  });

  it('ciò che non è anteprimabile non è nemmeno apribile', () => {
    expect(isOpenable('20261014-0930_archivio.zip')).toBe(false);
    expect(isOpenable('20261014-0930_app.bin')).toBe(false);
    expect(isOpenable('senza')).toBe(false);
  });
});

describe('isNavigableMime — il MIME effettivo del blob decide la navigazione', () => {
  it('immagini raster, pdf e testo passano', () => {
    for (const m of ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp', 'application/pdf', 'text/plain', 'text/markdown', 'application/json']) {
      expect(isNavigableMime(m)).toBe(true);
    }
  });

  it('l\'SVG non passa, quale che sia il nome del file', () => {
    expect(isNavigableMime('image/svg+xml')).toBe(false);
  });

  it('l\'HTML non passa: un blob html navigato eseguirebbe script nell\'origine dell\'app', () => {
    expect(isNavigableMime('text/html')).toBe(false);
    expect(isNavigableMime('application/xhtml+xml')).toBe(false);
  });

  it('parametri e maiuscole non contano: si guarda il tipo base, ripulito', () => {
    expect(isNavigableMime('image/PNG')).toBe(true);
    expect(isNavigableMime('text/plain;charset=utf-8')).toBe(true);
    expect(isNavigableMime('  application/json  ')).toBe(true);
    expect(isNavigableMime('image/svg+xml;charset=utf-8')).toBe(false);
  });

  it('MIME vuoto, assente o sconosciuto: chiuso (fail closed)', () => {
    expect(isNavigableMime('')).toBe(false);
    expect(isNavigableMime(undefined)).toBe(false);
    expect(isNavigableMime(null)).toBe(false);
    expect(isNavigableMime('application/octet-stream')).toBe(false);
    expect(isNavigableMime('image/tiff')).toBe(false);
  });
});

describe('formatRowTime / formatDayLabel / formatFullWhen', () => {
  const NOW = NOON(2026, 10, 14, 14, 0);

  it('oggi: solo l\'ora', () => {
    expect(formatRowTime(NOON(2026, 10, 14, 9, 30), NOW, 'it')).toBe('09:30');
    // mezzanotte resta di oggi
    expect(formatRowTime(NOON(2026, 10, 14, 0, 5), NOW, 'it')).toBe('00:05');
  });

  it('altro giorno: data breve nella lingua + ora', () => {
    expect(formatRowTime(NOON(2026, 10, 12, 9, 30), NOW, 'it')).toBe('12 ott 09:30');
    expect(formatRowTime(NOON(2026, 9, 30, 23, 59), NOW, 'it')).toBe('30 set 23:59');
    expect(formatRowTime(NOON(2026, 10, 12, 9, 30), NOW, 'en')).toBe('Oct 12 09:30');
    expect(formatRowTime(NOON(2026, 10, 12, 9, 30), NOW, 'es')).toBe('12 oct 09:30');
  });

  it('etichetta del gruppo: «Oggi · 14 ottobre» e le date successive', () => {
    expect(formatDayLabel(NOON(2026, 10, 14), NOW, 'it', 'Oggi')).toBe('Oggi · 14 ottobre');
    expect(formatDayLabel(NOON(2026, 10, 12), NOW, 'it', 'Oggi')).toBe('12 ottobre');
    expect(formatDayLabel(NOON(2025, 12, 31), NOW, 'it', 'Oggi')).toBe('31 dicembre');
  });

  it('senza parola «oggi» l\'etichetta è la sola data (composizione del chiamante)', () => {
    expect(formatDayLabel(NOON(2026, 10, 14), NOW, 'it')).toBe('14 ottobre');
    expect(formatDayLabel(NOON(2026, 10, 14), NOW, 'en')).toBe('October 14');
  });

  it('data completa del foglio: «14 ottobre 2026, 09:30»', () => {
    expect(formatFullWhen(NOON(2026, 10, 14, 9, 30), 'it')).toBe('14 ottobre 2026, 09:30');
    expect(formatFullWhen(NOON(2026, 10, 14, 9, 30), 'en')).toBe('October 14, 2026, 09:30');
  });
});

describe('groupFilesByDay — giorni recenti prima, file recenti prima', () => {
  const NOW = NOON(2026, 10, 14, 14, 0);
  const f = (name, mtimeMs) => ({ name, size: 10, mtime: mtimeMs });

  it('raggruppa per giorno con etichette e ordine giusti', () => {
    const groups = groupFilesByDay([
      f('report.md', NOON(2026, 10, 12, 8, 0).getTime()),   // mtime ieri-altro
      f('20261014-0930_note.txt', 0),                        // stamp: oggi 09:30
      f('vecchio.log', NOON(2026, 10, 10).getTime()),
    ], NOW, 'it', 'Oggi');
    expect(groups.map((g) => g.label)).toEqual(['Oggi · 14 ottobre', '12 ottobre', '10 ottobre']);
    expect(groups[0].files.map((x) => x.name)).toEqual(['20261014-0930_note.txt']);
    expect(groups[1].files.map((x) => x.name)).toEqual(['report.md']);
  });

  it('dentro il giorno i file vanno dal più recente, con tie-break sul nome', () => {
    const groups = groupFilesByDay([
      f('b.txt', NOON(2026, 10, 14, 8, 0).getTime()),
      f('a.txt', NOON(2026, 10, 14, 10, 0).getTime()),
      f('c.txt', NOON(2026, 10, 14, 10, 0).getTime()),
    ], NOON(2026, 10, 14, 12), 'it', 'Oggi');
    expect(groups).toHaveLength(1);
    expect(groups[0].files.map((x) => x.name)).toEqual(['a.txt', 'c.txt', 'b.txt']);
  });

  it('l\'ordine d\'ingresso non conta e l\'input vuoto dà nessun gruppo', () => {
    expect(groupFilesByDay([], NOW, 'it')).toEqual([]);
    expect(groupFilesByDay(undefined, NOW, 'it')).toEqual([]);
  });

  it('ogni file porta il proprio when derivato (stamp o mtime)', () => {
    const groups = groupFilesByDay([f('20261013-2200_notte.md', NOON(2026, 10, 14).getTime())], NOW, 'it', 'Oggi');
    // lo stamp (13/10 22:00) vince sull'mtime del 14: il gruppo è del 13
    expect(groups[0].label).toBe('13 ottobre');
    expect(groups[0].files[0].when.getHours()).toBe(22);
  });
});

describe('duplicateCounts — i doppi per NOME VISUALIZZATO', () => {
  const f = (name) => ({ name, size: 10, mtime: 0 });

  it('l\'epub consegnato due volte: originale e copia timbrata contano 2', () => {
    const counts = duplicateCounts([f('20261016-1317_a.epub'), f('a.epub'), f('b.md')]);
    expect(counts.get('a.epub')).toBe(2);
    expect(counts.get('b.md')).toBe(1);
  });

  it('è una Map completa: ogni nome visualizzato ha il suo conteggio', () => {
    const counts = duplicateCounts([f('20261016-1317_a.epub'), f('a.epub'), f('b.md')]);
    expect(counts.size).toBe(2);
    expect([...counts.entries()]).toEqual([['a.epub', 2], ['b.md', 1]]);
  });

  it('l\'indice di dedup del server tiene i gemelli distinti: nomi diversi', () => {
    const counts = duplicateCounts([f('1-20261014-0930_report.md'), f('20261014-0930_report.md')]);
    expect(counts.get('1-report.md')).toBe(1);
    expect(counts.get('report.md')).toBe(1);
  });

  it('il secondo prefisso data del mittente non crea falsi doppioni', () => {
    const counts = duplicateCounts([f('20261014-0930_2026-10-13_report.md'), f('20261014-0940_report.md')]);
    expect(counts.get('report.md')).toBe(2);
  });

  it('lista vuota o assente: Map vuota, nessun lancio', () => {
    expect(duplicateCounts([]).size).toBe(0);
    expect(duplicateCounts(undefined).size).toBe(0);
  });
});

describe('fileKind — filtri a pillola del desktop', () => {
  it('le immagini comuni sono immagini', () => {
    for (const n of ['foto.png', 'IMG_0001.jpg', 'clip.gif', 'schermo.webp', 'logo.svg', 'icona.ico']) {
      expect(fileKind(n)).toBe('image');
    }
  });

  it('i documenti comuni sono documenti', () => {
    for (const n of ['report.md', 'note.txt', 'dump.json', 'fattura.pdf', 'tabella.csv', 'verbale.docx', 'dati.xlsx']) {
      expect(fileKind(n)).toBe('document');
    }
  });

  it('tutto il resto è «altro»: sta solo in Tutti', () => {
    for (const n of ['archivio.zip', 'backup.tar', 'exec.bin', 'senzaestensione']) {
      expect(fileKind(n)).toBe('other');
    }
  });

  it('guarda l\'estensione del nome VISUALIZZATO, non lo stamp del server', () => {
    expect(fileKind('20261014-0930_foto.png')).toBe('image');
    expect(fileKind('20261014-0930_2026-10-13_report.md')).toBe('document');
  });

  it('il nome degenere non lancia e non è un documento', () => {
    expect(fileKind('')).toBe('other');
    expect(fileKind(undefined)).toBe('other');
  });
});
