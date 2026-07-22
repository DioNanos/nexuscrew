import { useState } from 'react';
import { t } from '../lib/i18n.js';
import { useLang } from '../hooks/useLang.js';
import { isValidDeckName, normalizeDeckName, MAIN_DECK } from '../lib/deck-model.js';
import { useDeckBarCollapse } from '../hooks/useDeckBarCollapse.js';
import { useDeckPresence } from '../hooks/useDeckPresence.js';
import DeckHandle from './DeckHandle.jsx';
import './DeckBar.css';

// Gestione deck (finestra principale, §5b): crea/rinomina/elimina, apri un deck
// in una nuova finestra (un monitor = una finestra). I deck sono client-side.
// Ogni gruppo owner/nodo e' comprimibile (button accessibile): i nuovi owner
// partono compressi; la preferenza e' owner-qualified, persistita per-client e
// sincronizzata cross-window. Ogni deck ha un dot di presenza (client-side).
export default function DeckBar({
  decks = [], currentDeck = 'local:main', onCreate, onRename, onDelete, onReorder, onOpenWindow, onNavigate,
  saveState = 'idle', error = '', sidebarVisible, onToggleSidebar,
}) {
  useLang();
  const { isCollapsed, toggle } = useDeckBarCollapse();
  const { dotFor } = useDeckPresence(currentDeck);
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

  const stepDeck = (group, deck, delta) => {
    const at = group.decks.findIndex((item) => item.id === deck.id);
    const target = group.decks[at + delta];
    if (at >= 0 && target && onReorder && !busy) onReorder(deck.id, target.id);
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
        {groups.map((group) => {
          const collapsed = isCollapsed(group.key);
          const contentId = `nc-deck-content-${group.key}`;
          const ownerName = group.local ? 'Local' : group.label;
          const hasCurrent = group.decks.some((d) => d.id === currentDeck);
          const currentName = (group.decks.find((d) => d.id === currentDeck) || {}).name;
          const countTitle = t(group.decks.length === 1 ? 'owner-deck-count-one' : 'owner-deck-count-many')
            .replace('{count}', group.decks.length);
          return (
            <span key={group.key} className={`nc-deck-owner-group${collapsed ? ' collapsed' : ''}`}
              data-owner-key={group.key} data-collapsed={collapsed ? '1' : '0'}>
              <button
                type="button"
                className="nc-deck-owner-toggle"
                aria-expanded={!collapsed}
                aria-controls={contentId}
                title={(collapsed ? t('expand-owner') : t('collapse-owner')).replace('{owner}', ownerName)}
                onClick={() => {
                  // Se il form "+ new" e' aperto, comprimere il gruppo lo
                  // annulla esplicitamente: nessun draft/focus resta nascosto.
                  if (!collapsed && adding === group.key) { setName(''); setAdding(null); }
                  toggle(group.key);
                }}
              >
                <span className="nc-deck-owner-caret" aria-hidden="true">{collapsed ? '▸' : '▾'}</span>
                <span className="nc-deck-owner">{ownerName}</span>
              </button>
              {collapsed && (
                <span className="nc-deck-summary" title={countTitle}>
                  <span className="nc-deck-summary-count">{group.decks.length}</span>
                  {hasCurrent && <span className="nc-deck-summary-current">• {currentName}</span>}
                </span>
              )}
              <span id={contentId} className="nc-deck-owner-content" hidden={collapsed}>
                    {group.decks.map((d) => {
                      const dot = dotFor(d.id, d.available === false);
                      return (
                        <span key={d.id} data-deck-id={d.id} data-owner-key={group.key}
                          className={`nc-deck-chip${d.id === currentDeck ? ' current' : ''}${d.available === false ? ' offline' : ''}`}>
                          {dot && <DeckDot state={dot} />}
                          <DeckHandle ownerKey={group.key} deckId={d.id} label={`${group.label} · ${d.name}`}
                            onMove={(source, target) => { if (onReorder && !busy) onReorder(source, target); }}
                            onStep={(delta) => stepDeck(group, d, delta)} />
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
                      );
                    })}
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
            </span>
          );
        })}
      </div>
      <span className={`nc-deck-state ${saveState}`} title={t('deck-autosave')}>
        {saveState === 'saving' ? t('saving') : saveState === 'saved' ? t('saved') : t('deck-autosave')}
      </span>
      {(localErr || error) && <span className="nc-deck-error">{localErr || error}</span>}
      {blockedUrl && <button className="nc-deck-fallback" onClick={() => onOpenWindow && onOpenWindow(blockedUrl)}>{t('popup-blocked')}</button>}
    </div>
  );
}

// Dot di presenza client-side di un deck. working=finestra attiva, on=aperta
// in background, neutral=non aperta, warn=owner offline.
function DeckDot({ state }) {
  if (!state) return null;
  const label = t(`dot-${state}`);
  return <span className={`nc-deck-dot ${state}`} role="img" aria-label={label} title={label} />;
}
