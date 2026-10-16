import { useEffect, useRef, useState } from 'react';
import { t, getLang } from '../lib/i18n.js';
import { copyText } from '../lib/clipboard.js';
import { uploadSessionFiles } from '../lib/attachments.js';
import Icon from './Icon.jsx';
import {
  fileDisplayName, fileWhen, fileExt, fileKind, formatRowTime, formatFileSize,
  formatFullWhen, groupFilesByDay, isPreviewable, isOpenable,
} from '../lib/files-display.js';
import './FilesPanel.desktop.css';

// Vista DESKTOP del pannello file (0.9.69): il drawer largo a destra con
// lista a griglia + pannello dettaglio. Tutto ciò che fa rete e tutto ciò che
// identifica un file risale al genitore FilesPanel (stesso stato, stesse
// funzioni della vista mobile): qui si legge e si sceglie, il nome ORIGINALE
// (f.name) continua a viaggiare in ogni operazione — il prefisso si toglie
// solo dove si vede. Il foglio azioni «⋯» è quello condiviso e sta nel padre.
//
// Interazioni tastiera (annunciate nel piè di pagina): `/` foca la ricerca,
// `↑`/`↓` muovono la selezione, `Invio` apre il foglio azioni del file
// selezionato — l'equivalente tastiera del «⋯», vale per ogni tipo di file.
const TEXT_PREVIEW_EXTS = new Set(['TXT', 'MD', 'JSON']);
const IMAGE_PREVIEW_EXTS = new Set(['PNG', 'JPG', 'JPEG', 'GIF', 'WEBP', 'SVG', 'BMP', 'ICO', 'AVIF']);
const PREVIEW_MAX_CHARS = 8000;

export default function FilesPanelDesktop({
  session, node, token,
  box, onBox, counts,
  rows, visible, busy, notice = '', error = '', onNotice,
  sheetFile, onSheet, onClose, onRefresh,
  fetchBlob, onDownload, onPreview, onDelete,
  query, onQuery,
}) {
  const [kind, setKind] = useState('all');   // pillola: Tutti/Documenti/Immagini
  const [selName, setSelName] = useState(''); // nome ORIGINALE del file selezionato
  const [confirming, setConfirming] = useState(false);
  const [copied, setCopied] = useState(false);
  const [preview, setPreview] = useState(null); // {kind:'text',text} | {kind:'img',url}
  const searchRef = useRef(null);
  const listRef = useRef(null);
  const uploadRef = useRef(null);

  const lang = getLang();
  const now = new Date();
  const kindVisible = kind === 'all' ? visible : visible.filter((f) => fileKind(f.name) === kind);
  const groups = groupFilesByDay(kindVisible, now, lang, t('files-today'));
  const flat = groups.flatMap((g) => g.files);
  const selFile = selName ? rows.find((f) => f.name === selName) : null;
  const selNameLive = selFile ? selFile.name : '';

  // Il file selezionato non è più nell'elenco (eliminato, rinfrescato):
  // la selezione cade da sola, il dettaglio torna al segnaposto.
  useEffect(() => {
    if (selName && !rows.some((f) => f.name === selName)) setSelName('');
  }, [rows, selName]);

  // File diverso = dettaglio nuovo: conferma e feedback copia non sopravvivono.
  useEffect(() => { setConfirming(false); setCopied(false); }, [selNameLive]);

  // Anteprima del dettaglio: stesso blob della route di download (nessuna
  // superficie server nuova). Testo per i tipi testuali (primi 8 KB), miniatura
  // per le immagini (object URL revocato a cambio file e allo smontaggio).
  // fetchBlob è ricreata a ogni render del padre: non sta nei deps per non
  // rifare la richiesta a ogni render — session/node/box coprono le sue chiusure.
  useEffect(() => {
    setPreview(null);
    if (!selNameLive || !isPreviewable(selNameLive)) return undefined;
    let alive = true;
    let objectUrl = '';
    (async () => {
      const blob = await fetchBlob(selNameLive);
      if (!alive || !blob) return;
      const ext = fileExt(selNameLive);
      if (TEXT_PREVIEW_EXTS.has(ext)) {
        const text = await blob.text();
        if (alive) setPreview({ kind: 'text', text: text.slice(0, PREVIEW_MAX_CHARS) });
      } else if (IMAGE_PREVIEW_EXTS.has(ext)) {
        // Solo le immagini hanno miniatura inline: un pdf non è né testo né
        // <img> — per quello c'è «Apri» in una scheda nuova.
        objectUrl = URL.createObjectURL(blob);
        if (alive) setPreview({ kind: 'img', url: objectUrl });
      }
    })();
    return () => { alive = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selNameLive, box, session, node]);

  // La riga selezionata da tastiera entra in vista (scrollIntoView può
  // mancare in jsdom: chiamata guardata).
  useEffect(() => {
    if (!selName) return;
    const row = listRef.current ? listRef.current.querySelector('[data-sel="1"]') : null;
    if (row && typeof row.scrollIntoView === 'function') row.scrollIntoView({ block: 'nearest' });
  }, [selName]);

  // Scorciatoie del pannello. Ignorate quando il focus è su un elemento
  // interattivo (il tasto appartiene a quello: Invio su un bottone lo preme,
  // la «/» si scrive nel campo) e quando il foglio azioni è aperto (il foglio
  // gestisce i suoi tasti, Escape chiude).
  useEffect(() => {
    const onKey = (event) => {
      if (sheetFile) return;
      const el = event.target;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT'
        || el.tagName === 'BUTTON' || el.tagName === 'A' || el.isContentEditable)) return;
      if (event.key === '/') {
        event.preventDefault();
        if (searchRef.current) searchRef.current.focus();
        return;
      }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        if (!flat.length) return;
        const names = flat.map((f) => f.name);
        const i = selName ? names.indexOf(selName) : -1;
        const next = i < 0
          ? (event.key === 'ArrowDown' ? 0 : names.length - 1)
          : Math.min(names.length - 1, Math.max(0, i + (event.key === 'ArrowDown' ? 1 : -1)));
        setSelName(names[next]);
        return;
      }
      if (event.key === 'Enter' && selFile) {
        event.preventDefault();
        onSheet(selFile.name);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });

  // «Carica file»: il caricamento già esistente della PWA (stessa route
  // POST /files/upload degli allegati del composer, paste=false: il file va
  // nella inbox della cella, nessun testo nel terminale).
  async function onUploadPick(event) {
    const files = Array.from(event.target.files || []);
    event.target.value = ''; // ripescare lo stesso file deve riattivarlo
    if (!files.length) return;
    const { errors } = await uploadSessionFiles({ files, token, session, node, paste: false });
    if (errors && errors.length) {
      const first = errors[0] || {};
      onNotice(t('files-upload-failed').replace('{e}', String(first.message || first.error || '')));
    }
    onRefresh();
  }

  async function copiaNome() {
    setCopied(await copyText(selFile ? selFile.name : ''));
  }

  const display = selFile ? fileDisplayName(selFile.name) : '';
  const when = selFile ? fileWhen(selFile.name, selFile.mtime) : null;
  const noMatchQ = query.trim() || t(kind === 'image' ? 'files-filter-images' : 'files-filter-docs');
  const totalBytes = kindVisible.reduce((sum, f) => sum + (Number(f.size) || 0), 0);
  const gridLabel = node ? `${node}:${session}` : session;

  return (
    <>
      <header className="nc-filesd-head">
        <div className="nc-filesd-titolo">
          <b>{t('files-of').replace('{session}', gridLabel)}</b>
          <span className="nc-filesd-percorso">{node ? `${node} · ` : ''}~/NexusFiles/{session}/{box}</span>
        </div>
        <button type="button" className="nc-filesd-upload" onClick={() => uploadRef.current && uploadRef.current.click()}>
          <Icon name="upload" size={16} /><span>{t('files-upload')}</span>
        </button>
        <input
          ref={uploadRef} type="file" multiple className="nc-filesd-upload-input"
          tabIndex={-1} aria-hidden="true" onChange={onUploadPick}
        />
        <button type="button" className="nc-ntf-x" onClick={onClose} title={t('close')} aria-label={t('close')}><Icon name="x" size={16} /></button>
      </header>

      <div className="nc-filesd-bar">
        {/* Schede a segmenti col conteggio: «Outbox · N» / «Inbox · N». */}
        <nav className="nc-filesd-seg">
          <button type="button" className={box === 'outbox' ? 'on' : ''} onClick={() => onBox('outbox')}>
            {t('files-outbox').replace('{n}', String(counts.outbox))}
          </button>
          <button type="button" className={box === 'inbox' ? 'on' : ''} onClick={() => onBox('inbox')}>
            {t('files-inbox').replace('{n}', String(counts.inbox))}
          </button>
        </nav>
        {/* Ricerca client-side (scorciatoia «/») + filtri a pillola sul tipo. */}
        <div className="nc-filesd-search">
          <Icon name="search" size={16} />
          <input
            ref={searchRef} type="search" value={query} onChange={(e) => onQuery(e.target.value)}
            placeholder={t('files-search-ph')} aria-label={t('files-search')} enterKeyHint="search"
            data-testid="files-search-input"
          />
          <kbd className="nc-filesd-kbd" aria-hidden="true">/</kbd>
        </div>
        <div className="nc-filesd-filtri">
          <button type="button" className={kind === 'all' ? 'on' : ''} aria-pressed={kind === 'all'} onClick={() => setKind('all')}>{t('files-filter-all')}</button>
          <button type="button" className={kind === 'document' ? 'on' : ''} aria-pressed={kind === 'document'} onClick={() => setKind('document')}>{t('files-filter-docs')}</button>
          <button type="button" className={kind === 'image' ? 'on' : ''} aria-pressed={kind === 'image'} onClick={() => setKind('image')}>{t('files-filter-images')}</button>
        </div>
      </div>

      <div className="nc-filesd-main">
        <div className="nc-filesd-list" ref={listRef}>
          {groups.map((g) => (
            <section key={g.key} className="nc-filesd-daygroup">
              <h3 className="nc-filesd-day">{g.label}</h3>
              <div className="nc-filesd-rows" role="grid" aria-label={g.label}>
                {g.files.map((f) => {
                  const disp = fileDisplayName(f.name);
                  const sel = f.name === selName;
                  return (
                    // Riga della griglia: selezionabile al click (il dettaglio
                    // a destra la segue), con le sue due azioni in fondo.
                    // NOME mai troncato: a capo ovunque, nessuna riga massima.
                    <div
                      key={f.name} role="row" aria-selected={sel}
                      data-sel={sel ? '1' : undefined}
                      className={sel ? 'nc-filesd-row sel' : 'nc-filesd-row'}
                      onClick={() => setSelName(f.name)}
                    >
                      <span className="nc-files-type" aria-hidden="true">{fileExt(f.name) || <Icon name="file" size={18} />}</span>
                      <span className="nc-filesd-name">{disp}</span>
                      <span className="nc-filesd-quando">{formatRowTime(fileWhen(f.name, f.mtime), now, lang)}</span>
                      <span className="nc-filesd-dim">{formatFileSize(f.size)}</span>
                      <span className="nc-filesd-cella">
                        <button type="button" className="nc-filesd-dl" onClick={() => onDownload(f.name)}
                          title={t('files-download')} aria-label={`${t('files-download')} ${disp}`}>
                          <Icon name="download" size={18} />
                        </button>
                      </span>
                      <span className="nc-filesd-cella">
                        <button type="button" className="nc-filesd-more" onClick={() => onSheet(f.name)}
                          title={t('files-actions')} aria-label={`${t('files-actions')} ${disp}`}>
                          <Icon name="more" size={18} />
                        </button>
                      </span>
                    </div>
                  );
                })}
              </div>
            </section>
          ))}
          {rows.length === 0 && <div className="nc-files-empty">{t('empty-files')}</div>}
          {rows.length > 0 && kindVisible.length === 0 && (
            <div className="nc-files-empty">{t('files-no-match').replace('{q}', noMatchQ)}</div>
          )}
        </div>

        <aside className="nc-filesd-detail">
          {!selFile ? (
            <div className="nc-filesd-detail-none">{t('files-detail-none')}</div>
          ) : (
            <>
              {preview && preview.kind === 'text' && (
                <pre className="nc-filesd-prev-text" data-testid="files-detail-text">{preview.text}</pre>
              )}
              {preview && preview.kind === 'img' && (
                <img className="nc-filesd-prev-img" data-testid="files-detail-img" src={preview.url} alt={display} />
              )}
              <b className="nc-filesd-nome">{display}</b>
              <div className="nc-filesd-originale">
                <span className="nc-filesd-label">{t('files-original-name')}</span>
                <code className="nc-filesd-mono">{selFile.name}</code>
              </div>
              <dl className="nc-filesd-meta">
                <div><dt>{t('files-meta-date')}</dt><dd>{formatFullWhen(when, lang)}</dd></div>
                <div><dt>{t('files-meta-size')}</dt><dd>{formatFileSize(selFile.size)}</dd></div>
                <div><dt>{t('files-meta-folder')}</dt><dd>{box === 'outbox' ? 'Outbox' : 'Inbox'} · {gridLabel}</dd></div>
                <div><dt>{t('files-meta-type')}</dt><dd>{fileExt(selFile.name) || '—'}</dd></div>
              </dl>
              <div className="nc-filesd-azioni">
                <button type="button" className="primario" onClick={() => onDownload(selFile.name)}>
                  <Icon name="download" size={16} /><span>{t('files-download-action')}</span>
                </button>
                {isOpenable(selFile.name) && (
                  <button type="button" onClick={() => onPreview(selFile.name)}>
                    <Icon name="eye" size={16} /><span>{t('files-open')}</span>
                  </button>
                )}
                <button type="button" onClick={copiaNome} aria-live="polite">
                  <Icon name="copy" size={16} /><span>{copied ? t('files-copied-name') : t('files-copy-name')}</span>
                </button>
                <button type="button" className="danger" onClick={() => setConfirming(true)}>
                  <Icon name="trash" size={16} /><span>{t('files-delete-ellipsis')}</span>
                </button>
              </div>
              {confirming && (
                <div className="nc-filesd-conferma" data-testid="files-detail-confirm">
                  <b className="nc-filesd-conferma-titolo">{t('files-delete-confirm').replace('{name}', display)}</b>
                  <small className="nc-filesd-conferma-aiuto">{t('files-delete-confirm-help')}</small>
                  <div className="nc-filesd-conferma-azioni">
                    <button type="button" onClick={() => setConfirming(false)} disabled={!!busy}>{t('cancel')}</button>
                    <button
                      type="button" className="danger" disabled={!!busy}
                      data-fileaction="delete-confirm" onClick={() => onDelete(selFile.name)}
                    >{t('delete')}</button>
                  </div>
                </div>
              )}
            </>
          )}
        </aside>
      </div>

      {(error || notice) && !sheetFile && <div className="nc-busy" role="status">{error || notice}</div>}

      <footer className="nc-filesd-foot">
        <span>{t('files-footer-count').replace('{n}', String(kindVisible.length)).replace('{size}', formatFileSize(totalBytes))}</span>
        <span
          className="nc-filesd-tasti"
          title={t('files-kbd-hint').replace('{enter}', t('files-kbd-enter'))}
        >
          <kbd>↑↓</kbd><kbd>{t('files-kbd-enter')}</kbd><kbd>/</kbd>
        </span>
      </footer>
    </>
  );
}
