// "POWER UP!" flourish shown for 3s when Kobbfiguration is enabled: big pixel
// text with a 3D extrusion, a faint-out ("svenimento") animation, and a
// synthesized coin chime (Web Audio, no external/copyrighted asset).
import { useEffect, useRef } from 'react';
import './PowerUp.css';

// Two ascending square-wave notes — a generic coin chime (not a sample).
function playCoin() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    const now = ctx.currentTime;
    const notes = [987.56, 1318.51]; // B5, E6
    notes.forEach((freq, i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'square';
      o.frequency.value = freq;
      const start = now + i * 0.09;
      g.gain.setValueAtTime(0.0001, start);
      g.gain.exponentialRampToValueAtTime(0.18, start + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, start + 0.32);
      o.connect(g).connect(ctx.destination);
      o.start(start);
      o.stop(start + 0.34);
    });
    setTimeout(() => ctx.close(), 600);
  } catch (_) { /* audio not available */ }
}

export default function PowerUp() {
  const elRef = useRef(null);
  useEffect(() => {
    playCoin();
    const id = setTimeout(() => elRef.current?.remove(), 3000);
    return () => clearTimeout(id);
  }, []);
  return (
    <div ref={elRef} className="nc-powerup" aria-hidden="true">
      <span className="nc-powerup-text">POWER UP!</span>
    </div>
  );
}