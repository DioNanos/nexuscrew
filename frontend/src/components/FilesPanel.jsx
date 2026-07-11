import { useEffect, useRef, useState } from 'react';
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
  const fileInput = useRef(null);

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

  async function uploadFiles(files) {
    for (const f of files) {
      setBusy(`carico ${f.name}…`);
      const fd = new FormData();
      fd.append('session', session);
      fd.append('file', f);
      try {
        const r = await apiFetch(`${base}/files/upload`, token, { method: 'POST', body: fd });
        const j = await r.json();
        setBusy(j.error ? `errore: ${j.error}` : '');
      } catch (e) { setBusy(String(e)); }
    }
    refresh();
  }

  async function download(name) {
    const r = await apiFetch(
      `${base}/files/download?session=${encodeURIComponent(session)}&box=${box}&name=${encodeURIComponent(name)}`, token,
    );
    if (!r.ok) { setBusy('errore download'); return; }
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name; a.click();
    URL.revokeObjectURL(url);
  }

  async function del(name) {
    await apiFetch(
      `${base}/files?session=${encodeURIComponent(session)}&box=${box}&name=${encodeURIComponent(name)}`, token,
      { method: 'DELETE' },
    );
    refresh();
  }

  return (
    <div className="nc-files">
      <header>
        <b>{node ? `${node}:${session}` : session}</b>
        <button onClick={onClose} title={t('close')}><Icon name="x" size={20} /></button>
      </header>
      <nav>
        <button className={box === 'outbox' ? 'on' : ''} onClick={() => setBox('outbox')}>outbox</button>
        <button className={box === 'inbox' ? 'on' : ''} onClick={() => setBox('inbox')}>inbox</button>
        <button className="up" onClick={() => fileInput.current && fileInput.current.click()}><Icon name="upload" size={18} /> {t('upload')}</button>
        <input
          type="file" multiple ref={fileInput} style={{ display: 'none' }}
          onChange={(e) => { uploadFiles(Array.from(e.target.files || [])); e.target.value = ''; }}
        />
      </nav>
      {busy && <div className="nc-busy">{busy}</div>}
      <ul>
        {data[box].map((f) => (
          <li key={f.name}>
            <span className="name" onClick={() => download(f.name)}>{f.name}</span>
            <small>{fmtSize(f.size)}</small>
            <button onClick={() => del(f.name)} title="elimina"><Icon name="trash" size={18} /></button>
          </li>
        ))}
        {data[box].length === 0 && <li className="empty">{t('empty-files')}</li>}
      </ul>
    </div>
  );
}
