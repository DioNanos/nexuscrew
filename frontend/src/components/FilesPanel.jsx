import { useEffect, useState } from 'react';
import { apiFetch, seenKey } from '../lib/api.js';
import { t, getLang } from '../lib/i18n.js';
import { useLang } from '../hooks/useLang.js';
import { useDesktop } from '../lib/desktop.js';
import Icon from './Icon.jsx';
import FileActionsSheet from './FileActionsSheet.jsx';
import FilesPanelDesktop from './FilesPanelDesktop.jsx';
import {
  fileDisplayName, fileWhen, fileExt, formatRowTime, formatFileSize,
  groupFilesByDay, isPreviewable, isOpenable, isNavigableMime,
} from '../lib/files-display.js';
import './FilesPanel.css';

// Quanto lasciar vivere l'object URL dell'anteprima dopo l'apertura: la
// nuova scheda consuma il blob alla navigazione, e un ritardo prudente
// copre anche i dispositivi lenti senza trattenere il blob per la vita
// della PWA.
const PREVIEW_URL_TTL_MS = 60_000;

// node (opzionale): file exchange di un nodo remoto — stesse route, prefissate
// dal proxy /node/<name> (B1). Il marker "visto" resta scopato per nodo per non
// pestare una sessione locale omonima.
export default function FilesPanel({ session, node, token, filesEvent, onClose }) {
  useLang();
  const base = node ? `/api/route/${String(node).split('/').map(encodeURIComponent).join('/')}/_` : '/api';
  const seen = node ? `${node}:${session}` : session;
  const [box, setBox] = useState('outbox');
  const [data, setData] = useState({ inbox: [], outbox: [] });
  const [busy, setBusy] = useState('');
  const [query, setQuery] = useState('');
  // nome ORIGINALE del file col foglio azioni aperto: è la chiave su disco,
  // sopravvive al refresh finché il file resta nell'elenco.
  const [sheetName, setSheetName] = useState('');
  // 0.9.69 desktop: stesso criterio condiviso dell'app (R34, schermo largo E
  // puntatore fine). Stato e azioni restano UNO solo: cambia la vista.
  const desktop = useDesktop();

  async function refresh() {
    try {
      const r = await apiFetch(`${base}/files?session=${encodeURIComponent(session)}`, token);
      const j = await r.json();
      if (j.error) { setBusy(j.error); return; }
      setData(j);
      const latest = j.outbox[0] ? j.outbox[0].mtime : 0;
      localStorage.setItem(seenKey(seen), String(latest));
    } catch (e) { setBusy(String(e)); }
  }
  useEffect(() => { refresh(); }, [session, node]);
  useEffect(() => { if (filesEvent && filesEvent.session === session) refresh(); }, [filesEvent]);

  // Tutte le operazioni viaggiano col nome ORIGINALE (f.name): il prefisso
  // dello stamp si toglie SOLO dove si legge. 0.9.69.
  async function fetchFileBlob(name) {
    const r = await apiFetch(
      `${base}/files/download?session=${encodeURIComponent(session)}&box=${box}&name=${encodeURIComponent(name)}`, token,
    );
    if (!r.ok) {
      // R27 #7: come l'upload — il body porta la causa vera (401/404/5xx),
      // non un generico 'errore download' che manda a cercare un guasto
      // di rete inesistente.
      const j = await r.json().catch(() => ({}));
      setBusy(j.error ? `errore: ${j.error}` : 'errore download');
      return null;
    }
    return r.blob();
  }

  async function download(name) {
    const blob = await fetchFileBlob(name);
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name; a.click();
    URL.revokeObjectURL(url);
  }

  // Anteprima dei tipi navigabili come documento: stesso blob della route di
  // download, aperto in una scheda invece che salvato. Due gate, entrambi
  // devono passare: il nome (isOpenable: la voce non esiste per l'SVG) e il
  // MIME effettivo del blob (isNavigableMime). Un blob SVG o HTML navigato
  // come documento eseguirebbe i propri script nell'origine dell'app; con
  // MIME assente o insolito si resta chiusi: si scarica e basta.
  async function preview(name) {
    const blob = await fetchFileBlob(name);
    if (!blob) return;
    if (!isNavigableMime(blob.type)) {
      setBusy(t('files-preview-blocked'));
      return;
    }
    const url = URL.createObjectURL(blob);
    try {
      // Con «noopener» window.open torna SEMPRE null, anche quando la scheda
      // si apre davvero: il valore di ritorno non dice nulla e non si usa
      // per scegliere il ramo. L'unica certezza di fallimento qui è
      // l'eccezione lanciata dalla chiamata stessa.
      window.open(url, '_blank', 'noopener');
    } catch (e) {
      // fallimento certo: nessun consumatore, l'object URL si revoca subito
      URL.revokeObjectURL(url);
      setBusy(t('files-preview-failed'));
      return;
    }
    // La revoca è SEMPRE ritardata: il caricamento della nuova scheda è
    // asincrono e il null di noopener non lascia nulla da distinguere.
    setTimeout(() => URL.revokeObjectURL(url), PREVIEW_URL_TTL_MS);
  }

  async function del(name) {
    const r = await apiFetch(
      `${base}/files?session=${encodeURIComponent(session)}&box=${box}&name=${encodeURIComponent(name)}`, token,
      { method: 'DELETE' },
    );
    if (!r.ok) {
      // R27 #7: prima il delete taceva e dopo refresh() il file ricompariva
      // senza spiegazione. Ora si legge il body e si dice cosa e' fallito.
      const j = await r.json().catch(() => ({}));
      setBusy(j.error ? `errore: ${j.error}` : 'errore delete');
      return;
    }
    if (sheetName === name) setSheetName('');
    refresh();
  }

  const lang = getLang();
  const now = new Date();
  const rows = data[box] || [];
  const needle = query.trim().toLowerCase();
  const visible = needle ? rows.filter((f) => String(f.name || '').toLowerCase().includes(needle)) : rows;
  const groups = groupFilesByDay(visible, now, lang, t('files-today'));
  const sheetFile = sheetName ? rows.find((f) => f.name === sheetName) : null;

  // Il foglio azioni «⋯» è uno solo per entrambe le viste (mobile e desktop).
  const sheet = sheetFile ? (
    <FileActionsSheet
      file={sheetFile} box={box} session={node ? `${node}:${session}` : session}
      previewable={isOpenable(sheetFile.name)}
      notice={busy} busy={!!busy}
      onClose={() => setSheetName('')}
      onDownload={(f) => { setSheetName(''); download(f.name); }}
      onPreview={(f) => preview(f.name)}
      onDelete={(f) => del(f.name)}
    />
  ) : null;

  // Vista desktop: drawer largo con lista a griglia e pannello dettaglio.
  // Tutto ciò che fa rete resta qui (stesse funzioni della vista mobile),
  // il nome ORIGINALE continua a viaggiare in ogni operazione.
  if (desktop) {
    return (
      <div className="nc-files nc-files-d">
        <FilesPanelDesktop
          session={session} node={node} token={token}
          box={box} onBox={setBox}
          counts={{ outbox: (data.outbox || []).length, inbox: (data.inbox || []).length }}
          rows={rows} visible={visible} busy={busy} onNotice={setBusy}
          sheetFile={sheetFile} onSheet={setSheetName}
          onClose={onClose} onRefresh={refresh}
          fetchBlob={fetchFileBlob} onDownload={download} onPreview={preview} onDelete={del}
          query={query} onQuery={setQuery}
        />
        {sheet}
      </div>
    );
  }

  return (
    <div className="nc-files">
      <header>
        <b>{node ? `${node}:${session}` : session}</b>
        {/* La X usa la classe condivisa nc-ntf-x (toast e pannello ASK)
            con i token colore dell'app, non lo stile nativo del browser che
            la rendeva grigia e grossa. */}
        <button type="button" className="nc-ntf-x" onClick={onClose} title={t('close')} aria-label={t('close')}><Icon name="x" size={16} /></button>
      </header>
      {/* Schede con il conteggio: «Outbox · N» / «Inbox · N», una accesa.
          Il caricamento non sta qui — il file entra nella cella dal menu
          allegati del composer (voce «Inbox»), stessa route POST /files/upload. */}
      <nav>
        <button className={box === 'outbox' ? 'on' : ''} onClick={() => setBox('outbox')}>
          {t('files-outbox').replace('{n}', String((data.outbox || []).length))}
        </button>
        <button className={box === 'inbox' ? 'on' : ''} onClick={() => setBox('inbox')}>
          {t('files-inbox').replace('{n}', String((data.inbox || []).length))}
        </button>
      </nav>
      {/* Ricerca client-side sull'elenco già caricato: nessuna richiesta. */}
      <div className="nc-files-search">
        <Icon name="search" size={16} />
        <input
          type="search" value={query} onChange={(e) => setQuery(e.target.value)}
          placeholder={t('files-search-ph')} aria-label={t('files-search')}
          enterKeyHint="search"
        />
      </div>
      {busy && !sheetFile && <div className="nc-busy" role="status">{busy}</div>}
      <div className="nc-files-list">
        {groups.map((g) => (
          <section key={g.key} className="nc-files-daygroup">
            <h3 className="nc-files-day">{g.label}</h3>
            <ul>
              {g.files.map((f) => {
                const display = fileDisplayName(f.name);
                return (
                  <li key={f.name}>
                    {/* Badge-tipo: l'estensione del nome visualizzato, 40×40.
                        aria-hidden: il nome accanto dice già tutto. */}
                    <span className="nc-files-type" aria-hidden="true">
                      {fileExt(f.name) || <Icon name="file" size={18} />}
                    </span>
                    <span className="nc-files-info">
                      {/* Il nome è testo, leggibile e selezionabile, mai un
                          comando: due righe al massimo, a capo ovunque. */}
                      <span className="nc-files-name">{display}</span>
                      <small className="nc-files-meta">
                        {formatRowTime(fileWhen(f.name, f.mtime), now, lang)} · {formatFileSize(f.size)}
                      </small>
                    </span>
                    <button type="button" className="nc-files-dl" onClick={() => download(f.name)}
                      title={t('files-download')} aria-label={`${t('files-download')} ${display}`}>
                      <Icon name="download" size={20} />
                    </button>
                    <button type="button" className="nc-files-more" onClick={() => setSheetName(f.name)}
                      title={t('files-actions')} aria-label={`${t('files-actions')} ${display}`}>
                      <Icon name="more" size={20} />
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
        {rows.length === 0 && <div className="nc-files-empty">{t('empty-files')}</div>}
        {rows.length > 0 && visible.length === 0 && (
          <div className="nc-files-empty">{t('files-no-match').replace('{q}', query.trim())}</div>
        )}
      </div>
      {sheet}
    </div>
  );
}
