import { useEffect, useRef, useState } from 'react';
import QrScanner from 'qr-scanner';
import { t } from '../lib/i18n.js';
import { normalizeScanResult } from '../lib/pairing-flow.js';
import './PairingCard.css';

// Scanner QR LIVE (camera) con diagnosi precisa: permesso negato, nessuna
// camera, API non supportate, QR non valido. Fallback upload/foto sempre
// disponibile nel modale. Cleanup rigoroso: stop()+destroy() su successo,
// annulla e unmount (mai lasciare la camera accesa).
// Il risultato NON viene mai navigato: l'URL 127.0.0.1 del creatore è solo il
// contenitore del payload #pair e qui non sarebbe raggiungibile — va sempre al
// controller condiviso del pairing (onResult).
export default function QrScanModal({ onResult, onClose }) {
  const videoRef = useRef(null);
  const scannerRef = useRef(null);
  const doneRef = useRef(false);
  const [scanErr, setScanErr] = useState('');

  useEffect(() => {
    let disposed = false;
    // Keep the actual element in the effect closure: React may clear the ref
    // before running cleanup during unmount.
    const videoElement = videoRef.current;
    const finish = (value) => {
      if (disposed || doneRef.current) return;
      doneRef.current = true;
      onResult(value); // il genitore chiude il modale -> unmount -> cleanup
    };
    (async () => {
      if (typeof navigator === 'undefined' || !navigator.mediaDevices
        || typeof navigator.mediaDevices.getUserMedia !== 'function') {
        setScanErr(t('qr-unsupported'));
        return;
      }
      let hasCamera = false;
      try { hasCamera = await QrScanner.hasCamera(); } catch (_) { hasCamera = false; }
      if (!hasCamera) { setScanErr(t('qr-no-camera')); return; }
      if (disposed || !videoElement) return;
      const scanner = new QrScanner(videoElement, (res) => {
        const value = normalizeScanResult(res);
        if (value) finish(value);
      }, {
        returnDetailedScanResult: true,
        preferredCamera: 'environment',
        // The library default scans only the central 2/3 square. A QR that
        // naturally fills a phone preview is therefore cropped and can never
        // decode. Keep a square region, but cover 92% of the short edge.
        calculateScanRegion: (video) => {
          const width = video.videoWidth || 640;
          const height = video.videoHeight || 480;
          const size = Math.max(1, Math.round(Math.min(width, height) * 0.92));
          return {
            x: Math.round((width - size) / 2),
            y: Math.round((height - size) / 2),
            width: size, height: size,
            downScaledWidth: 600, downScaledHeight: 600,
          };
        },
        highlightScanRegion: true,
        highlightCodeOutline: true,
      });
      scannerRef.current = scanner;
      try {
        await scanner.start();
      } catch (e) {
        if (disposed) return;
        const name = (e && e.name) || '';
        if (name === 'NotAllowedError' || name === 'SecurityError') setScanErr(t('qr-permission'));
        else if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'NotReadableError') setScanErr(t('qr-no-camera'));
        else setScanErr(t('qr-unsupported'));
      }
    })();
    return () => {
      disposed = true;
      const s = scannerRef.current;
      if (s) {
        try { s.stop(); } catch (_) { /* best-effort */ }
        try { s.destroy(); } catch (_) { /* best-effort */ }
        scannerRef.current = null;
      }
      // QrScanner.stop() releases tracks after a short pause. Explicitly stop
      // them here as well so closing the modal turns the camera off immediately.
      const video = videoElement;
      const stream = video && video.srcObject;
      if (stream && typeof stream.getTracks === 'function') {
        for (const track of stream.getTracks()) { try { track.stop(); } catch (_) { /* best-effort */ } }
        try { video.srcObject = null; } catch (_) { /* best-effort */ }
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Fallback: foto/immagine del QR (utile senza permesso camera o su desktop).
  const onFile = async (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try {
      const res = await QrScanner.scanImage(f, { returnDetailedScanResult: true });
      const value = normalizeScanResult(res);
      if (!value) throw new Error('empty');
      if (!doneRef.current) { doneRef.current = true; onResult(value); }
    } catch (_) { setScanErr(t('pairing-qr-invalid')); }
  };

  return (
    <div className="nc-sheet-overlay nc-qr-overlay" onClick={onClose}>
      <div className="nc-sheet nc-qr-modal" onClick={(e) => e.stopPropagation()}>
        <div className="nc-sheet-head"><b>{t('scan-qr')}</b></div>
        {/* playsInline: iOS non deve andare fullscreen; muted per l'autoplay */}
        <video ref={videoRef} className="nc-qr-video" playsInline muted />
        {scanErr && <div className="nc-err" role="alert">{scanErr}</div>}
        <div className="nc-sheet-actions">
          <label className="nc-btn ghost nc-qr-upload">
            {t('qr-upload')}
            <input type="file" accept="image/*" hidden onChange={onFile} />
          </label>
          <button type="button" className="nc-btn ghost" onClick={onClose}>{t('cancel')}</button>
        </div>
      </div>
    </div>
  );
}
