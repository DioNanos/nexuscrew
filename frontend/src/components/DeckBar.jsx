import { useState } from 'react';
import { t } from '../lib/i18n.js';
import { useLang } from '../hooks/useLang.js';
import { isValidDeckName, normalizeDeckName, MAIN_DECK } from '../lib/deck-model.js';
import './DeckBar.css';

// Gestione deck (finestra principale, §5b): crea/rinomina/elimina, apri un deck
// in una nuova finestra (un monitor = una finestra). I deck sono client-side.
export default function DeckBar({
  decks = [], currentDeck = 'local:main', onCreate, onRename, onDelete, onOpenWindow, onNavigate,
  saveState = 'idle', error = '', sidebarVisible, onToggleSidebar,
}) {
  useLang();
  const [adding, setAdding] = useState(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [localErr, setLocalErr] = useState('');
  const [blockedUrl, setBlockedUrl] = useState('');
  const normalizedName = normalizeDeckName(name);
  const valid = isValidDeckName(normalizedName);
  const groups = [];
  for (const deck of decks) {
    const ownerKey = deck.local ? 'local' : deck.ownerId;
    let group = groups.find((item) => item.key === ownerKey);
    if (!group) {
      group = { key: ownerKey, label: deck.ownerLabel || (deck.local ? 'Local' : ownerKey), local: !!deck.local, decks: [] };
      groups.push(group);
    }
    group.decks.push(deck);
  }

  const submit = async () => {
    if (!valid) return;
    setBusy(true); setLocalErr('');
    try { if (onCreate) await onCreate(normalizedName, adding); setName(''); setAdding(null); }
    catch (e) { setLocalErr(String(e.message || e)); }
    setBusy(false);
  };

  const popout = (d) => {
    setBlockedUrl('');
    const ok = onOpenWindow && onOpenWindow(d.id);
    if (!ok) setBlockedUrl(d.id);
  };

  const navigate = async (d) => {
    if (d.id === currentDeck || !onNavigate || busy || d.available === false) return;
    setBusy(true); setLocalErr('');
    try { await onNavigate(d.id); }
    catch (error) { setLocalErr(String(error?.message || error)); }
    setBusy(false);
  };

  return (
    <div className="nc-deckbar">
      {onToggleSidebar && (
        <button className="nc-deck-sidebar-toggle" title={t('toggle-sidebar')} onClick={onToggleSidebar}>
          {sidebarVisible ? '◀' : '☰'}
        </button>
      )}
      <span className="nc-deckbar-label">{t('decks')}</span>
      <div className="nc-deck-chips">
        {groups.map((group) => (
          <span key={group.key} className="nc-deck-owner-group">
            <span className="nc-deck-owner">{group.local ? 'Local' : group.label}</span>
            {group.decks.map((d) => (
              <span key={d.id} className={`nc-deck-chip${d.id === currentDeck ? ' current' : ''}${d.available === false ? ' offline' : ''}`}>
                <button
                  className="nc-deck-open"
                  title={d.available === false ? `${d.ownerLabel} offline` : d.id === currentDeck ? t('deck-current') : `${d.ownerLabel} · ${d.name}`}
                  disabled={busy || d.available === false}
                  onClick={() => navigate(d)}
                >{d.name}{d.id === currentDeck ? ' •' : ''}</button>
                <button className="nc-deck-mini" disabled={d.available === false} title={t('detach-deck')} onClick={() => popout(d)}>↗</button>
                {d.name !== MAIN_DECK && (
                  <>
                    <button
                      className="nc-deck-mini"
                      disabled={d.available === false}
                      title={t('rename-deck')}
                      onClick={() => {
                        const to = (typeof window !== 'undefined' ? window.prompt(t('rename-deck'), d.name) : '') || '';
                        const v = normalizeDeckName(to);
                        if (isValidDeckName(v) && v !== d.name && onRename) onRename(d.id, v).catch((e) => setLocalErr(String(e.message || e)));
                      }}
                    >✎</button>
                    <button
                      className="nc-deck-mini nc-deck-del"
                      disabled={d.available === false}
                      title={t('delete-deck')}
                      onClick={() => {
                        if (typeof window === 'undefined'
                          || window.confirm(t('delete-deck-confirm').replace('{name}', `${d.ownerLabel} · ${d.name}`))) {
                          if (onDelete) onDelete(d.id).catch((e) => setLocalErr(String(e.message || e)));
                        }
                      }}
                    >✕</button>
                  </>
                )}
              </span>
            ))}
            {adding === group.key ? (
              <span className="nc-deck-add">
                <input
                  autoFocus
                  className={valid || !name ? '' : 'invalid'}
                  placeholder={t('deck-name')}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') { setName(''); setAdding(null); } }}
                />
                {name && valid && normalizedName !== name && <span className="nc-deck-slug">→ {normalizedName}</span>}
                <button className="nc-deck-ok" disabled={!valid || busy} onClick={submit}>{t('create')}</button>
                <button className="nc-deck-cancel" onClick={() => { setName(''); setAdding(null); }}>{t('cancel')}</button>
              </span>
            ) : (
              <button className="nc-deck-newbtn" disabled={busy || group.decks.every((deck) => deck.available === false)}
                title={`${t('new-deck')} · ${group.label}`} onClick={() => { setName(''); setAdding(group.key); }}>+ {t('new')}</button>
            )}
          </span>
        ))}
      </div>
      <span className={`nc-deck-state ${saveState}`} title={t('deck-autosave')}>
        {saveState === 'saving' ? t('saving') : saveState === 'saved' ? t('saved') : t('deck-autosave')}
      </span>
      {(localErr || error) && <span className="nc-deck-error">{localErr || error}</span>}
      {blockedUrl && <button className="nc-deck-fallback" onClick={() => onOpenWindow && onOpenWindow(blockedUrl)}>{t('popup-blocked')}</button>}
    </div>
  );
}
