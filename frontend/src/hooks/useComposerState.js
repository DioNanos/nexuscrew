import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  COMPOSER_STORAGE_KEY,
  COMPOSER_RESET_EVENT,
  clearComposerDraft,
  clearComposerHistory,
  composerCellKey,
  loadComposerCell,
  pushComposerHistory,
  saveComposerDraft,
  saveComposerExpanded,
} from '../lib/composer-model.js';

const WRITE_DELAY_MS = 300;

function browserStorage() {
  try { return typeof localStorage !== 'undefined' ? localStorage : null; }
  catch (_) { return null; }
}

// Per-cell composer controller. Writes are debounced, but pagehide/blur and a
// cell identity change synchronously flush the current draft.
export function useComposerState({ ownerId, node, session, storage = browserStorage() }) {
  const cellKey = useMemo(() => composerCellKey({ ownerId, node, session }), [ownerId, node, session]);
  const first = useMemo(() => loadComposerCell(cellKey, storage), []); // component identity owns the initial load
  const [text, setTextState] = useState(first.draft);
  const [expanded, setExpandedState] = useState(first.expanded);
  const [history, setHistory] = useState(first.history);
  const [historyCursor, setHistoryCursor] = useState(-1);
  const keyRef = useRef(cellKey);
  const textRef = useRef(first.draft);
  const timerRef = useRef(null);
  const editAtRef = useRef(first.updatedAt || 0);
  const scratchRef = useRef(first.draft);

  const cancelWrite = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);

  const flush = useCallback(() => {
    cancelWrite();
    saveComposerDraft(keyRef.current, textRef.current, storage);
  }, [cancelWrite, storage]);

  const scheduleWrite = useCallback(() => {
    cancelWrite();
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      saveComposerDraft(keyRef.current, textRef.current, storage);
    }, WRITE_DELAY_MS);
  }, [cancelWrite, storage]);

  const setText = useCallback((next) => {
    const value = String(typeof next === 'function' ? next(textRef.current) : next || '');
    textRef.current = value;
    editAtRef.current = Date.now();
    scratchRef.current = value;
    setHistoryCursor(-1);
    setTextState(value);
    scheduleWrite();
  }, [scheduleWrite]);

  const applyRecall = useCallback((value, cursor) => {
    cancelWrite();
    textRef.current = value;
    editAtRef.current = Date.now();
    setTextState(value);
    setHistoryCursor(cursor);
    scheduleWrite();
  }, [cancelWrite, scheduleWrite]);

  const recallPrevious = useCallback(() => {
    if (!history.length) return false;
    const next = Math.min(historyCursor + 1, history.length - 1);
    if (historyCursor < 0) scratchRef.current = textRef.current;
    applyRecall(history[next].text, next);
    return true;
  }, [applyRecall, history, historyCursor]);

  const recallNext = useCallback(() => {
    if (historyCursor < 0) return false;
    const next = historyCursor - 1;
    applyRecall(next < 0 ? scratchRef.current : history[next].text, next);
    return true;
  }, [applyRecall, history, historyCursor]);

  const selectHistory = useCallback((value) => {
    scratchRef.current = textRef.current;
    const index = history.findIndex((item) => item.text === value);
    applyRecall(String(value || ''), index);
  }, [applyRecall, history]);

  const toggleExpanded = useCallback(() => {
    setExpandedState((current) => {
      const next = !current;
      saveComposerExpanded(keyRef.current, next, storage);
      return next;
    });
  }, [storage]);

  const confirmSubmitted = useCallback((submittedKey, submittedDraft, submittedValue) => {
    if (!submittedKey) return;
    pushComposerHistory(submittedKey, submittedValue, storage);
    const sameCell = keyRef.current === submittedKey;
    if (!sameCell) {
      const saved = loadComposerCell(submittedKey, storage);
      if (saved.draft === submittedDraft) clearComposerDraft(submittedKey, storage);
      return;
    }
    setHistory(loadComposerCell(submittedKey, storage).history);
    scratchRef.current = '';
    setHistoryCursor(-1);
    if (textRef.current === submittedDraft) {
      cancelWrite();
      textRef.current = '';
      editAtRef.current = Date.now();
      setTextState('');
      clearComposerDraft(submittedKey, storage);
    } else {
      scheduleWrite();
    }
  }, [cancelWrite, scheduleWrite, storage]);

  const clearHistory = useCallback(() => {
    clearComposerHistory(keyRef.current, storage);
    setHistory([]);
    setHistoryCursor(-1);
    scratchRef.current = textRef.current;
  }, [storage]);

  // A mounted composer can change identity in SingleView without a full page
  // reload. Flush the old key before loading the new owner/session record.
  useEffect(() => {
    if (keyRef.current === cellKey) return;
    flush();
    keyRef.current = cellKey;
    const next = loadComposerCell(cellKey, storage);
    textRef.current = next.draft;
    editAtRef.current = next.updatedAt || 0;
    scratchRef.current = next.draft;
    setTextState(next.draft);
    setExpandedState(next.expanded);
    setHistory(next.history);
    setHistoryCursor(-1);
  }, [cellKey, flush, storage]);

  useEffect(() => {
    const onPageHide = () => flush();
    const onVisibility = () => { if (document.visibilityState === 'hidden') flush(); };
    window.addEventListener('pagehide', onPageHide);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pagehide', onPageHide);
      document.removeEventListener('visibilitychange', onVisibility);
      flush();
    };
  }, [flush]);

  // Cross-tab last-writer-wins. A newer persisted edit replaces the local
  // value; an older storage event cannot clobber typing that has not flushed.
  useEffect(() => {
    const reset = () => {
      cancelWrite();
      textRef.current = '';
      editAtRef.current = 0;
      scratchRef.current = '';
      setTextState('');
      setExpandedState(false);
      setHistory([]);
      setHistoryCursor(-1);
    };
    const onStorage = (event) => {
      if (event.key !== COMPOSER_STORAGE_KEY) return;
      if (event.newValue == null) { reset(); return; }
      const next = loadComposerCell(keyRef.current, storage);
      if (next.updatedAt < editAtRef.current) return;
      cancelWrite();
      textRef.current = next.draft;
      editAtRef.current = next.updatedAt;
      scratchRef.current = next.draft;
      setTextState(next.draft);
      setExpandedState(next.expanded);
      setHistory(next.history);
      setHistoryCursor(-1);
    };
    const onReset = () => reset();
    window.addEventListener('storage', onStorage);
    window.addEventListener(COMPOSER_RESET_EVENT, onReset);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener(COMPOSER_RESET_EVENT, onReset);
    };
  }, [cancelWrite, storage]);

  return {
    cellKey,
    text,
    setText,
    expanded,
    toggleExpanded,
    history,
    historyCursor,
    recallPrevious,
    recallNext,
    selectHistory,
    confirmSubmitted,
    clearHistory,
    flush,
  };
}
