import { useEffect, useState } from 'react';
import { loadPins, movePinIn, togglePinIn, removePinIn } from '../lib/pins.js';
import {
  loadSidebarOrders, loadSidebarViews, moveSidebarItem, saveSidebarOrders,
  saveSidebarViews, sidebarItems, sidebarOrder, sidebarView, SIDEBAR_ORDER_KEY, SIDEBAR_VIEW_KEY,
} from '../lib/sidebar-model.js';
import { appendOrderJournal } from '../lib/order-journal.js';
import { canonicalPosition, positionView, ROUTE_ALIAS_KEY } from '../lib/route-identity.js';

// Cambio di preferenze avvenuto in QUESTO documento: sidebar desktop e lista mobile restano allineate
// senza aspettare l'evento `storage` (che il browser non manda alla finestra che ha scritto).
const CHANGE_EVENT = 'nexuscrew-roster-preferences';
const WATCHED = new Set(['nc_pins', SIDEBAR_ORDER_KEY, SIDEBAR_VIEW_KEY, ROUTE_ALIAS_KEY]);
const announce = () => { try { window.dispatchEvent(new Event(CHANGE_EVENT)); } catch (_) { /* fuori dal browser */ } };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const keep = (next) => (prev) => (same(prev, next) ? prev : next);

export function useRosterPreferences() {
  const [pins, setPins] = useState(loadPins);
  const [views, setViews] = useState(loadSidebarViews);
  const [orders, setOrders] = useState(loadSidebarOrders);
  // Errore di persistenza dell'ultima rimozione (deve essere
  // SEGNALATO e RITENTABILE, non solo loggato in console). null = tutto ok.
  const [pinError, setPinError] = useState(null);
  // Riordino rifiutato perche' la lista e' parziale: {reason, position, at}. Si spegne da solo o al prossimo riordino valido.
  const [reorderBlocked, setReorderBlocked] = useState(null);
  useEffect(() => {
    if (!reorderBlocked) return undefined;
    const timer = setTimeout(() => setReorderBlocked(null), 8000);
    return () => clearTimeout(timer);
  }, [reorderBlocked]);

  // lo stato di questa istanza segue lo storage. Un'altra finestra (evento `storage`, anche con chiave
  // null dopo un clear) o un'altra istanza di questo documento (CHANGE_EVENT) ricaricano i valori correnti.
  useEffect(() => {
    const reload = (event) => {
      if (event && event.type === 'storage' && event.key && !WATCHED.has(event.key)) return;
      setPins(keep(loadPins())); setOrders(keep(loadSidebarOrders())); setViews(keep(loadSidebarViews()));
    };
    window.addEventListener('storage', reload);
    window.addEventListener(CHANGE_EVENT, reload);
    return () => { window.removeEventListener('storage', reload); window.removeEventListener(CHANGE_EVENT, reload); };
  }, []);

  // Ogni azione parte dal valore CORRENTE dello storage, mai dallo stato catturato: e' la fonte di verita'
  // (vedi removePin), e cosi' due finestre non si cancellano a vicenda.
  const togglePin = (key) => {
    const before = loadPins();
    const r = togglePinIn(before, key);
    setPins(r.next);
    appendOrderJournal({ reason: r.error ? 'pin-write-failed' : 'pin', key, before, after: r.next, note: r.error ? String(r.error.message || r.error) : undefined });
    announce();
  };

  // removePin legge dalla FONTE DI VERITA' (localStorage) al momento dell'applicazione, NON dallo stato
  // React della closure: viene chiamato dopo l'await del clear server, e in quella finestra un pin aggiunto
  // altrove (desktop o mobile) aggiornerebbe solo localStorage, non lo stato catturato.
  const removePin = (key) => {
    const before = loadPins();
    const r = removePinIn(before, key);
    setPins(r.next);
    setPinError(r.error ? { key, message: r.error.message || String(r.error) } : null);
    appendOrderJournal({ reason: r.error ? 'unpin-write-failed' : 'unpin', key, before, after: r.next });
    announce();
    return r.error;
  };

  // Ritenta l'ultima rimozione fallita; a riuscita pulisce l'errore.
  const retryPinPersist = () => {
    if (!pinError) return;
    const r = removePinIn(loadPins(), pinError.key);
    setPins(r.next);
    setPinError(r.error ? { ...pinError, message: r.error.message || String(r.error) } : null);
    announce();
  };
  const clearPinError = () => setPinError(null);

  // Le posizioni si salvano sotto id:<instanceId> (vedi route-identity); i componenti continuano a passare il nome.
  const viewFor = (key) => sidebarView(positionView(views), key);
  const updateView = (key, patch) => {
    const before = loadSidebarViews();
    const slot = canonicalPosition(key);
    const next = saveSidebarViews({ ...before, [slot]: { ...sidebarView(positionView(before), key), ...patch } });
    setViews(next);
    announce();
  };

  const canMoveRoster = (source, target) => pins.includes(source) === pins.includes(target);

  function moveRoster(position, source, target, rawItems) {
    const partial = rawItems.find((item) => item.partial)?.partial;
    if (partial) {
      setReorderBlocked({ reason: partial, position, at: Date.now() });
      appendOrderJournal({ reason: 'reorder-blocked', position: canonicalPosition(position), source, target, note: partial });
      return;
    }
    setReorderBlocked(null);
    const currentPins = loadPins();
    const sourcePinned = currentPins.includes(source); const targetPinned = currentPins.includes(target);
    if (sourcePinned !== targetPinned) return;
    if (sourcePinned) {
      const next = movePinIn(currentPins, source, target);
      setPins(next);
      appendOrderJournal({ reason: 'move-pin', source, target, before: currentPins, after: next });
      announce();
      return;
    }
    const stored = loadSidebarOrders();
    const slot = canonicalPosition(position);
    const before = positionView(stored);
    const sourceTechnical = rawItems.find((item) => item.key === source)?.technical === true;
    const available = sidebarItems(rawItems, currentPins, sourceTechnical ? 'technical' : 'all', sidebarOrder(before, position)).map((item) => item.key);
    // Parte dall'ordine visibile per questa posizione (canonico o per nome), ma scrive solo sotto la voce canonica.
    const moved = moveSidebarItem({ ...stored, [slot]: sidebarOrder(before, position) }, slot, source, target, available);
    const next = { ...stored, [slot]: moved[slot] };
    saveSidebarOrders(next);
    appendOrderJournal({ reason: 'move', position: slot, source, target, before: sidebarOrder(before, position), after: moved[slot], visible: available });
    setOrders(next);
    announce();
  }

  function stepRoster(position, source, delta, rawItems) {
    if (rawItems.some((item) => item.partial)) { moveRoster(position, source, source, rawItems); return; }
    const currentPins = loadPins(); const currentOrders = positionView(loadSidebarOrders());
    const sourceTechnical = rawItems.find((item) => item.key === source)?.technical === true;
    const sourcePinned = currentPins.includes(source);
    const available = sidebarItems(rawItems, currentPins, sourceTechnical ? 'technical' : 'all', sidebarOrder(currentOrders, position))
      .map((item) => item.key).filter((key) => currentPins.includes(key) === sourcePinned);
    const at = available.indexOf(source); const target = available[at + delta];
    if (at >= 0 && target) moveRoster(position, source, target, rawItems);
  }

  return {
    pins, views: positionView(views), orders: positionView(orders), togglePin, removePin,
    pinError, retryPinPersist, clearPinError, reorderBlocked,
    viewFor, updateView, canMoveRoster, moveRoster, stepRoster,
  };
}
