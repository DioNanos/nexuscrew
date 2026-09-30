import { useEffect, useState } from 'react';
import { apiFetch, seenKey } from '../lib/api.js';
import {t} from '../lib/i18n.js';
import { useLang } from '../hooks/useLang.js';
import Icon from './Icon.jsx';
import './FilesPanel.css';

const fmtSize = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)}M` : n > 1024 ? `${(n / 1024).toFixed(0)}K` : `${n}B`);

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

  async function download(name) {
    const r = await apiFetch(
      `${base}/files/download?session=${encodeURIComponent(session)}&box=${box}&name=${encodeURIComponent(name)}`, token,
    );
    if (!r.ok) {
      // R27 #7: come l'upload — il body porta la causa vera (401/404/5xx),
      // non un generico 'errore download' che manda a cercare un guasto
      // di rete inesistente.
      const j = await r.json().catch(() => ({}));
      setBusy(j.error ? `errore: ${j.error}` : 'errore download');
      return;
    }
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name; a.click();
    URL.revokeObjectURL(url);
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
    refresh();
  }

  return (
    <div className="nc-files">
      <header>
        <b>{node ? `${node}:${session}` : session}</b>
        <button onClick={onClose} title={t('close')}><Icon name="x" size={20} /></button>
      </header>
      {/* Una riga sola: scatola attiva e scatola spenta. Il caricamento non sta
          qui — il file entra nella cella dal menu allegati del composer
          (voce «Inbox»), che usa la stessa route POST /files/upload. */}
      <nav>
        <button className={box === 'outbox' ? 'on' : ''} onClick={() => setBox('outbox')}>outbox</button>
        <button className={box === 'inbox' ? 'on' : ''} onClick={() => setBox('inbox')}>inbox</button>
      </nav>
      {busy && <div className="nc-busy">{busy}</div>}
      <ul>
        {data[box].map((f) => (
          <li key={f.name}>
            {/* Il nome e' testo: leggibile e selezionabile, mai un comando. */}
            <span className="name">{f.name}</span>
            <small>{fmtSize(f.size)}</small>
            <button type="button" onClick={() => download(f.name)} title={t('files-download')}
              aria-label={`${t('files-download')} ${f.name}`}><Icon name="download" size={18} /></button>
            <button onClick={() => del(f.name)} title={t('delete')}><Icon name="trash" size={18} /></button>
          </li>
        ))}
        {data[box].length === 0 && <li className="empty">{t('empty-files')}</li>}
      </ul>
    </div>
  );
}
