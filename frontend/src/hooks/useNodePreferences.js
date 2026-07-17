import { useEffect, useState } from 'react';
import {
  cleanNodeAlias, loadNodeAliases, loadNodeOrder, moveNodeGroup, nodeDisplayLabel,
  nodePreferenceKey, orderNodeGroups, saveNodeAliases, saveNodeOrder, updateNodeAlias,
} from '../lib/node-preferences.js';

const CHANGE_EVENT = 'nexuscrew-node-preferences';

function announceChange() {
  try { window.dispatchEvent(new Event(CHANGE_EVENT)); } catch (_) {}
}

export function useNodePreferences() {
  const [aliases, setAliases] = useState(loadNodeAliases);
  const [order, setOrder] = useState(loadNodeOrder);

  useEffect(() => {
    const reload = () => { setAliases(loadNodeAliases()); setOrder(loadNodeOrder()); };
    window.addEventListener('storage', reload);
    window.addEventListener(CHANGE_EVENT, reload);
    return () => {
      window.removeEventListener('storage', reload);
      window.removeEventListener(CHANGE_EVENT, reload);
    };
  }, []);

  const labelFor = (node) => nodeDisplayLabel(node, aliases);
  const groupsFor = (groups) => orderNodeGroups(groups, order).map((group) => ({ ...group, label: labelFor(group) }));

  const renameNode = (node, value) => {
    if (cleanNodeAlias(value) === null || !nodePreferenceKey(node)) return false;
    setAliases((before) => {
      const next = updateNodeAlias(before, node, value);
      saveNodeAliases(next); announceChange(); return next;
    });
    return true;
  };

  const moveNode = (source, target, groups) => setOrder((before) => {
    const next = moveNodeGroup(before, source, target, groups);
    saveNodeOrder(next); announceChange(); return next;
  });

  const stepNode = (source, delta, groups) => {
    const ordered = orderNodeGroups(groups, order).map(nodePreferenceKey);
    const index = ordered.indexOf(source); const target = ordered[index + delta];
    if (index >= 0 && target) moveNode(source, target, groups);
  };

  return { aliases, order, labelFor, groupsFor, renameNode, moveNode, stepNode, nodeKey: nodePreferenceKey };
}
