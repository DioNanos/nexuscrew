import { t } from '../../lib/i18n.js';
import { engineGroups } from './engineGroups.js';

// Opzioni dei selettori di engine divise in due gruppi, «standard» e «altri».
// Va usato DENTRO un <select>: rende due <optgroup> dai flag `standard` del
// payload delle definizioni. I gruppi vuoti non si rendono (nessuna etichetta
// orfana); il valore selezionato non cambia, e' solo presentazione.
export default function EngineOptions({ engines }) {
  const { standard, others } = engineGroups(engines);
  return <>
    {standard.length > 0 && <optgroup label={t('fleet-engine-group-standard')}>
      {standard.map((e) => <option key={e.id} value={e.id}>{e.label || e.id}</option>)}
    </optgroup>}
    {others.length > 0 && <optgroup label={t('fleet-engine-group-other')}>
      {others.map((e) => <option key={e.id} value={e.id}>{e.label || e.id}</option>)}
    </optgroup>}
  </>;
}
