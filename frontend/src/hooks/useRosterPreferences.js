import { useState } from 'react';
import { loadPins, movePinIn, togglePinIn } from '../lib/pins.js';
import {
  loadSidebarOrders, loadSidebarViews, moveSidebarItem, saveSidebarOrders,
  saveSidebarViews, sidebarItems, sidebarOrder, sidebarView,
} from '../lib/sidebar-model.js';

// Controller condiviso delle preferenze del roster (pin + viste per-posizione +
// ordine manuale) per la Sidebar desktop e la home mobile SessionList. Un solo
// contratto: collapse, filter, pin e ordine vivono negli stessi key localStorage
// (nc_pins / nc_sidebar_views_v1 / nc_sidebar_order_v1) cosicche' le due shell
// restano sincronizzate. Le mosse (drag handle / frecce) rispettano il confine
// pin/non-pinned e il filtro technical, come facevano le copie inline.
//
// Nessuna markup qui: ogni shell renderizza la propria. Il hook espone solo lo
// stato e le mutazioni. sidebarItems/sidebarOrder restano chiamate della shell
// (sono pure, in sidebar-model): il hook possiede solo lo stato persistente.
export function useRosterPreferences() {
  const [pins, setPins] = useState(loadPins);
  const [views, setViews] = useState(loadSidebarViews);
  const [orders, setOrders] = useState(loadSidebarOrders);

  const togglePin = (key) => setPins((p) => togglePinIn(p, key));
  const viewFor = (key) => sidebarView(views, key);
  const updateView = (key, patch) => setViews((before) => {
    const next = { ...before, [key]: { ...sidebarView(before, key), ...patch } };
    return saveSidebarViews(next);
  });

  const canMoveRoster = (source, target) => pins.includes(source) === pins.includes(target);

  // Sposta source verso target. Pinnati si riordinano solo tra pinnati (pin
  // order); i non-pinnati usano l'ordine manuale per-posizione. Mai mescolare i
  // due confini. Il filtro "technical" determina l'insieme disponibile quando si
  // riordina una sessione tecnica ( resta nel suo blocco).
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

  // Step da tastiera (ArrowUp/Down): stesso insieme disponibile di moveRoster,
  // ma ristretto al blocco pin/non-pinned del source, poi commit via moveRoster.
  function stepRoster(position, source, delta, rawItems) {
    const sourceTechnical = rawItems.find((item) => item.key === source)?.technical === true;
    const sourcePinned = pins.includes(source);
    const available = sidebarItems(rawItems, pins, sourceTechnical ? 'technical' : 'all', sidebarOrder(orders, position))
      .map((item) => item.key).filter((key) => pins.includes(key) === sourcePinned);
    const at = available.indexOf(source); const target = available[at + delta];
    if (at >= 0 && target) moveRoster(position, source, target, rawItems);
  }

  return { pins, views, orders, togglePin, viewFor, updateView, canMoveRoster, moveRoster, stepRoster };
}
