import { useState } from 'react';
import { t } from '../lib/i18n.js';
import { useLang } from '../hooks/useLang.js';
import { isValidDeckName, normalizeDeckName, MAIN_DECK } from '../lib/deck-model.js';
import './DeckBar.css';

// Gestione deck (finestra principale, §5b): crea/rinomina/elimina, apri un deck
// in una nuova finestra (un monitor = una finestra). I deck sono client-side.
export default function DeckBar({
  decks = [], currentDeck = MAIN_DECK, onCreate, onRename, onDelete, onOpenWindow, onNavigate,
  saveState = 'idle', error = '',
}) {
  useLang();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [localErr, setLocalErr] = useState('');
  const [blockedUrl, setBlockedUrl] = useState('');
  const normalizedName = normalizeDeckName(name);
  const valid = isValidDeckName(normalizedName);

  const submit = async () => {
    if (!valid) return;
    setBusy(true); setLocalErr('');
    try { if (onCreate) await onCreate(normalizedName); setName(''); setAdding(false); }
    catch (e) { setLocalErr(String(e.message || e)); }
    setBusy(false);
  };

  const popout = (d) => {
    setBlockedUrl('');
    const ok = onOpenWindow && onOpenWindow(d);
    if (!ok) setBlockedUrl(d);
  };

  return (
    <div className="nc-deckbar">
      <span className="nc-deckbar-label">{t('decks')}</span>
      <div className="nc-deck-chips">
        {decks.map((d) => (
          <span key={d} className={`nc-deck-chip${d === currentDeck ? ' current' : ''}`}>
            <button
              className="nc-deck-open"
              title={d === currentDeck ? t('deck-current') : d}
              onClick={() => d !== currentDeck && onNavigate && onNavigate(d)}
            >{d}{d === currentDeck ? ' •' : ''}</button>
            <button className="nc-deck-mini" title={t('open-deck-window')} onClick={() => popout(d)}>↗</button>
            {d !== MAIN_DECK && (
              <>
                <button
                  className="nc-deck-mini"
                  title={t('rename-deck')}
                  onClick={() => {
                    const to = (typeof window !== 'undefined' ? window.prompt(t('rename-deck'), d) : '') || '';
                    const v = to.trim();
                    if (v && v !== d && onRename) onRename(d, v).catch((e) => setLocalErr(String(e.message || e)));
                  }}
                >✎</button>
                <button
                  className="nc-deck-mini nc-deck-del"
                  title={t('delete-deck')}
                  onClick={() => {
                    if (typeof window === 'undefined'
                      || window.confirm(t('delete-deck-confirm').replace('{name}', d))) {
                      if (onDelete) onDelete(d).catch((e) => setLocalErr(String(e.message || e)));
                    }
                  }}
                >✕</button>
              </>
            )}
          </span>
        ))}
      </div>

      {adding ? (
        <span className="nc-deck-add">
          <input
            autoFocus
            className={valid || !name ? '' : 'invalid'}
            placeholder={t('deck-name')}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') { setName(''); setAdding(false); } }}
          />
          {name && valid && normalizedName !== name && <span className="nc-deck-slug">→ {normalizedName}</span>}
          <button className="nc-deck-ok" disabled={!valid || busy} onClick={submit}>{t('create')}</button>
          <button className="nc-deck-cancel" onClick={() => { setName(''); setAdding(false); }}>{t('cancel')}</button>
        </span>
      ) : (
        <button className="nc-deck-newbtn" title={t('new-deck')} onClick={() => setAdding(true)}>+ {t('new-deck')}</button>
      )}
      <span className={`nc-deck-state ${saveState}`} title={t('deck-autosave')}>
        {saveState === 'saving' ? t('saving') : saveState === 'saved' ? t('saved') : t('deck-autosave')}
      </span>
      {(localErr || error) && <span className="nc-deck-error">{localErr || error}</span>}
      {blockedUrl && <a className="nc-deck-fallback" href={`/deck/${encodeURIComponent(blockedUrl)}`} target="_blank" rel="noreferrer">{t('popup-blocked')}</a>}
    </div>
  );
}
