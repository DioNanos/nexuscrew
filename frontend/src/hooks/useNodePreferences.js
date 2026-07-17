import { useEffect, useState } from 'react';
import {
  loadNodeOrder, moveNodeGroup, nodePreferenceKey, orderNodeGroups, saveNodeOrder,
} from '../lib/node-preferences.js';

const CHANGE_EVENT = 'nexuscrew-node-preferences';

function announceChange() {
  try { window.dispatchEvent(new Event(CHANGE_EVENT)); } catch (_) {}
}

export function useNodePreferences() {
  const [order, setOrder] = useState(loadNodeOrder);

  useEffect(() => {
    const reload = () => setOrder(loadNodeOrder());
    window.addEventListener('storage', reload);
    window.addEventListener(CHANGE_EVENT, reload);
    return () => {
      window.removeEventListener('storage', reload);
      window.removeEventListener(CHANGE_EVENT, reload);
    };
  }, []);

  const groupsFor = (groups) => orderNodeGroups(groups, order);

  const moveNode = (source, target, groups) => setOrder((before) => {
    const next = moveNodeGroup(before, source, target, groups);
    saveNodeOrder(next); announceChange(); return next;
  });

  const stepNode = (source, delta, groups) => {
    const ordered = orderNodeGroups(groups, order).map(nodePreferenceKey);
    const index = ordered.indexOf(source); const target = ordered[index + delta];
    if (index >= 0 && target) moveNode(source, target, groups);
  };

  return { order, groupsFor, moveNode, stepNode, nodeKey: nodePreferenceKey };
}
