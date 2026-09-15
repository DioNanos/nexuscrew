import { t } from '../lib/i18n.js';
import { applyCellStar, cellStarView } from '../lib/cell-star.js';

// The star of one roster row, rendered by every surface that lists cells: the
// home, the desktop sidebar and the compact selector. The glyph and the labels
// are defined once, here. The tap toggles the PIN only: the host state is shown
// (colour and title) but changing the host is a separate, explicit command.
//
// `baseClassName` carries the per-surface class (`nc-act pin`, `nc-pin`,
// `nc-cell-switcher-star`); the state suffix (`on`, `designated`,
// `thread-active`, ...) is added here, once, for every surface.
export default function CellStar({
  item, pins, hostByRoute, route = [], cellName,
  togglePin, removePin, onOutcome, baseClassName = '',
}) {
  const view = cellStarView({ item, pins, hostByRoute, route });
  const label = `${t(view.titleKey)} ${cellName}`;
  const className = `${baseClassName}${view.live ? ` ${view.state}` : ''}${view.favorite ? ' on' : ''}`;

  const onClick = (event) => {
    // Tapping the star is not selecting the row under it: whatever the row does
    // on click, it does not happen from here.
    event.stopPropagation();
    Promise.resolve(applyCellStar({
      view, itemKey: item.key, togglePin, removePin,
    })).then((outcome) => { if (onOutcome) onOutcome(outcome); });
  };

  return (
    <button type="button" className={className} data-cell-star={view.state}
      title={t(view.titleKey)} aria-label={label} onClick={onClick}>
      {view.filled ? '\u2605' : '\u2606'}
    </button>
  );
}
