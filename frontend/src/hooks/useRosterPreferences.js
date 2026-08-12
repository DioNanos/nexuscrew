import { useState } from 'react';
import { loadPins, movePinIn, togglePinIn, removePinIn } from '../lib/pins.js';
import {
  loadSidebarOrders, loadSidebarViews, moveSidebarItem, saveSidebarOrders,
  saveSidebarViews, sidebarItems, sidebarOrder, sidebarView,
} from '../lib/sidebar-model.js';

// Controller condiviso delle preferenze del roster (pin + viste per-posizione +
// ordine manuale) per la Sidebar desktop e la home mobile SessionList. Un solo
// contratto: collapse, filter, pin e ordine vivono negli stessi key localStorage
// (nc_pins / nc_sidebar_views_v1 / nc_sidebar_order_v1) cosicche' le due shell
// restano sincronizzate. Nessuna markup qui: ogni shell renderizza la propria.
export function useRosterPreferences() {
  const [pins, setPins] = useState(loadPins);
  const [views, setViews] = useState(loadSidebarViews);
  const [orders, setOrders] = useState(loadSidebarOrders);
  // Errore di persistenza dell'ultima rimozione (contratto rev6 §2.1: deve essere
  // SEGNALATO e RITENTABILE, non solo loggato in console). null = tutto ok.
  const [pinError, setPinError] = useState(null);

  const togglePin = (key) => setPins((p) => togglePinIn(p, key).next);

  // removePin legge dalla FONTE DI VERITA' (localStorage) al momento
  // dell'applicazione, NON dallo stato React della closure: viene chiamato dopo
  // l'await del clear server, e in quella finestra un pin aggiunto altrove
  // (desktop o mobile) aggiornerebbe solo localStorage, non lo stato catturato.
  // Calcolando sui `pins` di closure quello verrebbe perso (lost update: lo
  // storage finiva vuoto). loadPins() legge il corrente.
  const removePin = (key) => {
    const r = removePinIn(loadPins(), key);
    setPins(r.next);
    setPinError(r.error ? { key, message: r.error.message || String(r.error) } : null);
    return r.error;
  };

  // Ritenta l'ultima rimozione fallita; a riuscita pulisce l'errore.
  const retryPinPersist = () => {
    if (!pinError) return;
    const r = removePinIn(loadPins(), pinError.key);
    setPins(r.next);
    setPinError(r.error ? { ...pinError, message: r.error.message || String(r.error) } : null);
  };
  const clearPinError = () => setPinError(null);

  const viewFor = (key) => sidebarView(views, key);
  const updateView = (key, patch) => setViews((before) => {
    const next = { ...before, [key]: { ...sidebarView(before, key), ...patch } };
    return saveSidebarViews(next);
  });

  const canMoveRoster = (source, target) => pins.includes(source) === pins.includes(target);

  function moveRoster(position, source, target, rawItems) {
    const sourcePinned = pins.includes(source); const targetPinned = pins.includes(target);
    if (sourcePinned !== targetPinned) return;
    if (sourcePinned) { setPins((before) => movePinIn(before, source, target)); return; }
    setOrders((before) => {
      const sourceTechnical = rawItems.find((item) => item.key === source)?.technical === true;
      const available = sidebarItems(rawItems, pins, sourceTechnical ? 'technical' : 'all', sidebarOrder(before, position)).map((item) => item.key);
      return saveSidebarOrders(moveSidebarItem(before, position, source, target, available));
    });
  }

  function stepRoster(position, source, delta, rawItems) {
    const sourceTechnical = rawItems.find((item) => item.key === source)?.technical === true;
    const sourcePinned = pins.includes(source);
    const available = sidebarItems(rawItems, pins, sourceTechnical ? 'technical' : 'all', sidebarOrder(orders, position))
      .map((item) => item.key).filter((key) => pins.includes(key) === sourcePinned);
    const at = available.indexOf(source); const target = available[at + delta];
    if (at >= 0 && target) moveRoster(position, source, target, rawItems);
  }

  return {
    pins, views, orders, togglePin, removePin,
    pinError, retryPinPersist, clearPinError,
    viewFor, updateView, canMoveRoster, moveRoster, stepRoster,
  };
}
