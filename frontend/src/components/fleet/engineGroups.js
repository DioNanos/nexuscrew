// Divisione dei selettori di engine in due gruppi: «standard» e «altri».
// Il campo `standard` arriva gia' calcolato dal payload delle definizioni
// (CLIENT_ORDER nel backend): la UI non duplica mai la lista dei client
// standard, la legge dal flag. Engine senza flag (dati di un backup, righe
// non ancora caricate) finiscono negli «altri»: mai persi.
export function engineGroups(engines) {
  const list = Array.isArray(engines) ? engines : [];
  const standard = list.filter((e) => e && e.standard === true);
  const others = list.filter((e) => !(e && e.standard === true));
  return { standard, others };
}
