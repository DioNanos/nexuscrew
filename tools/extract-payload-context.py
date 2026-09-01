#!/usr/bin/env python3
"""Estrae contesti di sanificazione dal payload pubblicabile.

La decisione NEUTRALIZZA usa le stesse grammatiche JSON della guardia Node.
I commenti JavaScript a inizio riga restano raggruppati in blocchi; ogni riga
con trigger non coperta da quei blocchi viene comunque emessa come contesto
inline/codice. Nei file non JavaScript soltanto CHANGELOG.md e' cronologia di
release per costruzione; gli altri contesti non vietati diventano REVISIONA.

Uso dalla radice del repository:
    python3 tools/extract-payload-context.py [ROOT]

Le righe dati sono TSV fisiche a sette colonne. Tab, newline e backslash nel
testo sono escapati, quindi nessun record occupa piu' righe fisiche.
"""

import json
from pathlib import Path
import re
import sys


REPO_ROOT = Path(__file__).resolve().parents[1]
RULES_PATH = REPO_ROOT / 'tests' / 'published-tree-clean-rules.json'
ROOT = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else Path.cwd().resolve()

TRIGGER = re.compile(
    r'[0-9a-fA-F]{7,40}'
    r'|\d{4}-\d{2}-\d{2}'
    r'|\b\d{1,2}/\d{1,2}/\d{2,4}\b'
    r'|revisione|rilievo|giro|audit|auditor|verifica|revision|audited'
    r'|da revisione',
    re.I,
)
LEADING_COMMENT_RE = re.compile(r'^\s*(?:\*|/\*|//|#|<!--)')
MATCH_GENERICA = re.compile(r'da revisione', re.I)
MATCH_PRODOTTO = re.compile(r'no-audit|audit log|auditMode|auditEnabled', re.I)
JAVASCRIPT_SUFFIXES = ('.js', '.mjs', '.cjs')
PUBLIC_RELEASE_FILES = {'CHANGELOG.md'}


def load_rules():
    raw = json.loads(RULES_PATH.read_text(encoding='utf8'))

    def compile_group(name):
        compiled = []
        for item in raw[name]:
            flags = re.I if 'i' in item.get('flags', '') else 0
            compiled.append((re.compile(item['source'], flags), item['reason']))
        return compiled

    return compile_group('payloadStructural'), compile_group('payloadIds')


STRUCTURAL_RULES, ID_RULES = load_rules()


def payload_hits(text, rel):
    """Stessa decisione payload della guardia: strutturali sempre, ID non-dist."""
    rules = list(STRUCTURAL_RULES)
    if 'frontend/dist' not in rel:
        rules.extend(ID_RULES)
    hits = []
    for regex, reason in rules:
        match = regex.search(text)
        if match:
            hits.append((reason, match.group(0)))
    return hits


def published():
    pkg = json.loads((ROOT / 'package.json').read_text(encoding='utf8'))
    out = [ROOT / 'package.json']
    for entry in pkg.get('files', []):
        path = ROOT / entry
        if not path.exists():
            continue
        if path.is_dir():
            out.extend(p for p in path.rglob('*') if p.is_file())
        else:
            out.append(path)
    return sorted(out)


def blocks(lines):
    """Blocchi massimali di commenti a inizio riga, con vuoti interni."""
    index = 0
    while index < len(lines):
        if LEADING_COMMENT_RE.match(lines[index]):
            end = index
            while end + 1 < len(lines) and (
                    LEADING_COMMENT_RE.match(lines[end + 1])
                    or lines[end + 1].strip() == ''):
                end += 1
            yield index, end
            index = end + 1
        else:
            index += 1


def classify(text, rel, *, non_js=False):
    hits = payload_hits(text, rel)
    if hits:
        reasons = '; '.join(sorted({reason for reason, _match in hits}))
        return 'provenienza-interna', 'NEUTRALIZZA', reasons
    if MATCH_GENERICA.search(text) and not MATCH_PRODOTTO.search(text):
        return 'attribuzione-generica', 'TIENI', 'revisione generica senza data, id o giro'
    if MATCH_PRODOTTO.search(text):
        return 'funzione-di-prodotto', 'TIENI', 'audit log o configurazione di prodotto'
    if non_js:
        if rel in PUBLIC_RELEASE_FILES:
            return 'release-pubblica', 'TIENI', 'file di cronologia pubblica dichiarato'
        return 'contesto-non-js', 'REVISIONA', 'file non JavaScript: nessuna assunzione di release'
    return 'uso-legittimo', 'TIENI', 'testo tecnico o prosa di prodotto'


rows = []
for path in published():
    rel = path.relative_to(ROOT).as_posix()
    try:
        text = path.read_text(encoding='utf8', errors='replace')
    except OSError:
        continue

    if rel.startswith('frontend/dist'):
        for match in TRIGGER.finditer(text):
            start = max(0, match.start() - 100)
            end = min(len(text), match.end() + 100)
            context = text[start:end].replace('\n', ' ')
            cls, verdict, why = classify(context, rel)
            if verdict == 'NEUTRALIZZA':
                cls = 'dist-provenienza'
            else:
                cls = 'dist-bundle'
                verdict = 'TIENI'
                why = 'colore CSS o testo di bundle senza grammatica vietata'
            rows.append((rel, match.start(), match.start(), cls, verdict, why, context))
        continue

    lines = text.splitlines()
    if rel.endswith(JAVASCRIPT_SUFFIXES):
        covered = set()
        for start, end in blocks(lines):
            covered.update(range(start, end + 1))
            blob = '\n'.join(lines[start:end + 1])
            if not TRIGGER.search(blob):
                continue
            cls, verdict, why = classify(blob, rel)
            rows.append((rel, start + 1, end + 1, cls, verdict, why, blob))
        for index, line in enumerate(lines):
            if index in covered or not TRIGGER.search(line):
                continue
            cls, verdict, why = classify(line, rel)
            rows.append((rel, index + 1, index + 1, cls, verdict, why, line))
    else:
        for number, line in enumerate(lines, 1):
            if not TRIGGER.search(line):
                continue
            cls, verdict, why = classify(line, rel, non_js=True)
            rows.append((rel, number, number, cls, verdict, why, line.strip()))


def escape_field(value):
    return (str(value)
            .replace('\\', '\\\\')
            .replace('\t', '\\t')
            .replace('\r', '\\r')
            .replace('\n', '\\n'))


counts = {}
for row in rows:
    key = (row[3], row[4])
    counts[key] = counts.get(key, 0) + 1

print('# comando: python3 tools/extract-payload-context.py <radice-worktree>')
print('# regole: tests/published-tree-clean-rules.json (condivise con la guardia Node)')
print('# policy: inline inclusi; non-JS non vietato = REVISIONA salvo CHANGELOG.md')
for (cls, verdict), count in sorted(counts.items()):
    print(f'# conteggio classe={cls} verdetto={verdict} n={count}')
print(f'# conteggio totale={len(rows)}')
print('file\triga_inizio\triga_fine\tclasse\tverdetto\tmotivo\ttesto')
for row in rows:
    print('\t'.join(escape_field(value) for value in row))
