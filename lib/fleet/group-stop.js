'use strict';
// Fase di stop del gruppo.
//
// Il coordinatore e' un membro vivo del proprio gruppo. Su {op:'stop'} congela
// i respawn, chiude la delivery, e solo dopo segnala con kill(0, signal): il
// kernel sceglie il gruppo del chiamante. Nessun pid e nessun killpg.
// Il TERM durante la grazia e' un handler vuoto in questo processo, non una
// maschera: un figlio nato dopo continua a ricevere SIGTERM.
// pidfd non e' in questo strato: i conteggi vengono dagli exit e, in
// produzione, da una lettura limitata di /proc. Senza traccia completa la
// qualita' resta ignoti e l'esito non diventa pulito.

const crypto = require('node:crypto');
const fs = require('node:fs');
const { creaDedup } = require('./control-protocol.js');

const CAP_SCAN = 256;

function killGruppoCorrente(signal) {
  process.kill(0, signal);
}

function leggiPgrp(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fine = stat.lastIndexOf(')');
    if (fine < 0) return null;
    const campi = stat.slice(fine + 2).trim().split(/\s+/);
    const pgrp = Number(campi[2]);
    if (!Number.isSafeInteger(pgrp) || pgrp <= 0) return null;
    return pgrp;
  } catch (e) {
    if (e && e.code === 'ENOENT') return 0;
    return null;
  }
}

function osservaProduzione(noti) {
  const mio = leggiPgrp(process.pid);
  if (!mio) return { inGruppo: 0, fuoriGruppo: 0, qualita: 'ignoti' };
  let inGruppo = 0;
  let fuoriGruppo = 0;
  let ignoti = 0;
  const visti = new Set([process.pid]);
  const lista = Array.isArray(noti) ? noti : [];
  for (const membro of lista) {
    if (!membro || !membro.pid || membro.exited) continue;
    visti.add(membro.pid);
    const gruppo = leggiPgrp(membro.pid);
    if (gruppo === 0) continue;
    if (gruppo == null) { ignoti += 1; continue; }
    if (gruppo === mio) inGruppo += 1;
    else fuoriGruppo += 1;
  }
  let nomi;
  try { nomi = fs.readdirSync('/proc'); } catch (_) {
    return { inGruppo, fuoriGruppo, qualita: 'ignoti' };
  }
  let letti = 0;
  for (const nome of nomi) {
    if (letti >= CAP_SCAN) return { inGruppo, fuoriGruppo, qualita: 'almeno' };
    if (!/^[0-9]+$/.test(nome)) continue;
    letti += 1;
    const pid = Number(nome);
    if (visti.has(pid)) continue;
    const gruppo = leggiPgrp(pid);
    if (gruppo === 0) continue;
    if (gruppo == null) { ignoti += 1; continue; }
    if (gruppo === mio) { inGruppo += 1; visti.add(pid); }
  }
  if (ignoti > 0) return { inGruppo, fuoriGruppo, qualita: 'ignoti' };
  return { inGruppo, fuoriGruppo, qualita: 'noti' };
}

function idRichiesta() {
  return crypto.randomBytes(8).toString('hex');
}

function deadlineMsDi(payload) {
  const n = payload && payload.deadlineMs;
  if (!Number.isSafeInteger(n) || n < 1 || n > 60000) return 2000;
  return n;
}

function normalizzaConti(conti) {
  if (!conti || typeof conti !== 'object' || Array.isArray(conti)) return null;
  const intero = (n) => Number.isSafeInteger(n) && n >= 0 && n <= 100000;
  if (!intero(conti.inGruppo) || !intero(conti.fuoriGruppo)) return null;
  if (conti.qualita !== 'noti' && conti.qualita !== 'almeno' && conti.qualita !== 'ignoti') return null;
  return { inGruppo: conti.inGruppo, fuoriGruppo: conti.fuoriGruppo, qualita: conti.qualita };
}

function gruppoVuoto(foto) {
  return !!foto && foto.inGruppo === 0 && foto.qualita === 'noti';
}

function esitoGruppoPulito(outcome) {
  return outcome === 'killed-clean' || outcome === 'killed-after-escalation';
}

function osservazioneDopoUscita(v) {
  if (!v || v.uscito !== true) return null;
  return normalizzaConti(v.dopo);
}

function classificaEsito(v) {
  const report = v && v.report;
  if (report && report.code === 'eperm') {
    return { outcome: 'eperm', conti: normalizzaConti(report.conti) };
  }
  const dopo = osservazioneDopoUscita(v);
  if (v && v.ready) {
    if (dopo && dopo.inGruppo === 0 && dopo.qualita === 'noti') {
      return { outcome: 'killed-clean', conti: dopo };
    }
    return { outcome: 'stop-unknown', conti: normalizzaConti(v.ready.conti) };
  }
  if (v && v.commit) {
    if (dopo && dopo.inGruppo === 0 && dopo.qualita === 'noti') {
      return { outcome: 'killed-after-escalation', conti: dopo };
    }
    if (dopo && dopo.inGruppo > 0) return { outcome: 'stop-incomplete', conti: dopo };
    return { outcome: 'stop-unknown', conti: normalizzaConti(v.commit.conti) };
  }
  return { outcome: 'stop-unknown', conti: null };
}

function codiceEsito(outcome) {
  if (outcome === 'identity-lost') return 'IDENTITY_LOST';
  if (outcome === 'eperm') return 'EPERM';
  if (outcome === 'stop-incomplete') return 'STOP_INCOMPLETE';
  return 'STOP_UNKNOWN';
}

async function eseguiFaseStop(ctx) {
  const frame = ctx.frame;
  const monoNow = ctx.monoNow;
  const sleep = ctx.sleep;
  const killGruppo = ctx.killGruppo || killGruppoCorrente;
  const osserva = ctx.osserva;
  const invia = ctx.invia;
  const svuota = ctx.svuota || (async () => true);
  const limite = monoNow() + deadlineMsDi(frame.payload);
  const basePayload = {
    tokenHash: ctx.tokenHash,
    stopRequestId: frame.requestId,
  };
  if (typeof ctx.scriviLog === 'function') ctx.scriviLog('pidfd-hardening-absent');
  invia({
    op: 'stop-ack', requestId: idRichiesta(), launchId: ctx.launchId, epoch: frame.epoch,
    payload: basePayload,
  });
  if (typeof ctx.cancellaDelivery === 'function') {
    try { await ctx.cancellaDelivery(); } catch (_) { /* la segnalazione aspetta comunque il settled */ }
  }
  if (monoNow() >= limite) {
    return { code: 1, outcome: 'stop-unknown', conti: typeof osserva === 'function' ? osserva() : null };
  }
  let rifiuto = null;
  try { killGruppo('SIGTERM'); } catch (e) { rifiuto = e; }
  if (rifiuto && rifiuto.code === 'EPERM') {
    const conti = osserva();
    invia({
      op: 'stop-report', requestId: idRichiesta(), launchId: ctx.launchId, epoch: frame.epoch,
      payload: { ...basePayload, code: 'eperm', conti },
    });
    await svuota();
    return { code: 1, outcome: 'eperm', conti };
  }
  let foto = osserva();
  while (monoNow() < limite && !gruppoVuoto(foto)) {
    const resta = limite - monoNow();
    if (resta <= 0) break;
    await sleep(Math.min(50, resta));
    foto = osserva();
  }
  if (gruppoVuoto(foto)) {
    invia({
      op: 'ready-to-exit', requestId: idRichiesta(), launchId: ctx.launchId, epoch: frame.epoch,
      payload: { ...basePayload, conti: foto },
    });
    await svuota();
    return { code: 0, outcome: 'ready-to-exit', conti: foto };
  }
  invia({
    op: 'escalate-commit', requestId: idRichiesta(), launchId: ctx.launchId, epoch: frame.epoch,
    payload: { ...basePayload, conti: foto },
  });
  await svuota();
  try { killGruppo('SIGKILL'); } catch (_) { /* nessun frame dopo il KILL */ }
  return { code: 137, outcome: 'escalate-commit', conti: foto };
}

function creaCoordinatore(opts) {
  let fase = null;
  let preparato = false;
  let ultimaEpoca = 0;
  const dedup = creaDedup();
  let stopRichiesto = false;
  let risolve = () => {};
  const tokenHash = crypto.createHash('sha256').update(opts.token, 'utf8').digest('hex');

  function attendiSveglia() {
    if (stopRichiesto) return Promise.resolve();
    return new Promise((resolve) => { risolve = resolve; });
  }

  function onFrame(frame) {
    if (!frame) return;
    if (frame.op === 'prepare') {
      if (frame.launchId !== opts.launchId) return;
      if (!Number.isSafeInteger(frame.epoch) || frame.epoch < 1) return;
      if (frame.epoch < ultimaEpoca) return;
      if (fase || preparato) return;
      if (!dedup.nuovo(frame.requestId)) return;
      ultimaEpoca = frame.epoch;
      preparato = true;
      opts.dichiaraStopping();
      opts.disarmaLegacy();
      const fatto = (async () => {
        if (typeof opts.cancellaDelivery === 'function') {
          try { await opts.cancellaDelivery(); } catch (_) { /* settled comunque */ }
        }
        opts.invia({
          op: 'prepare-ack', requestId: idRichiesta(), launchId: opts.launchId, epoch: frame.epoch,
          payload: { stopRequestId: frame.requestId },
        });
        return { outcome: 'prepared' };
      })();
      stopRichiesto = true;
      risolve();
      return fatto;
    }
    if (frame.op !== 'stop') return;
    if (frame.launchId !== opts.launchId) return;
    if (!Number.isSafeInteger(frame.epoch) || frame.epoch < 1) return;
    if (frame.epoch < ultimaEpoca) return;
    ultimaEpoca = frame.epoch;
    if (fase) return;
    if (!dedup.nuovo(frame.requestId)) return;
    opts.dichiaraStopping();
    opts.disarmaLegacy();
    opts.installaIgnoraTerm();
    stopRichiesto = true;
    fase = eseguiFaseStop({
      frame,
      tokenHash,
      launchId: opts.launchId,
      monoNow: opts.monoNow,
      sleep: opts.sleep,
      killGruppo: opts.killGruppo,
      osserva: opts.osserva,
      invia: opts.invia,
      svuota: opts.svuota,
      cancellaDelivery: opts.cancellaDelivery,
      scriviLog: opts.scriviLog,
    }).catch(() => ({ code: 1, outcome: 'stop-unknown' }));
    risolve();
  }

  return {
    onFrame,
    attiva: () => fase,
    attendiSveglia,
  };
}

function attendiPreparazione({
  leaseManager, cellId, launchId, monoNow, deadlineAt,
}) {
  if (!leaseManager
    || typeof leaseManager.controlConnesso !== 'function'
    || typeof leaseManager.sendControl !== 'function'
    || typeof leaseManager.ascoltaControl !== 'function'
    || !leaseManager.controlConnesso(cellId)) {
    return Promise.resolve({ outcome: 'identity-lost' });
  }
  const residuo = deadlineAt - monoNow();
  if (!Number.isSafeInteger(residuo) || residuo < 1) {
    return Promise.resolve({ outcome: 'stop-unknown' });
  }
  const requestId = idRichiesta();
  let ack = false;
  let chiuso = false;
  let fine;
  const done = new Promise((resolve) => { fine = resolve; });
  let offFrame = () => {};
  let timer = null;
  const chiudi = () => {
    if (chiuso) return;
    chiuso = true;
    try { offFrame(); } catch (_) {}
    if (timer) clearTimeout(timer);
    fine();
  };
  offFrame = leaseManager.ascoltaControl((id, frame) => {
    if (id !== cellId || !frame) return;
    const rif = frame.payload && frame.payload.stopRequestId;
    if (frame.op === 'prepare-ack' && (rif === requestId || frame.requestId === requestId)) {
      ack = true;
      chiudi();
    }
  });
  timer = setTimeout(chiudi, Math.max(1, residuo));
  const spedito = leaseManager.sendControl(cellId, {
    op: 'prepare', requestId, launchId, payload: {},
  });
  if (!spedito) {
    chiudi();
    return Promise.resolve({ outcome: 'identity-lost' });
  }
  return done.then(() => (ack ? { outcome: 'prepared' } : { outcome: 'stop-unknown' }));
}

function attendiFermataGruppo({
  leaseManager, cellId, launchId, monoNow, deadlineAt, graziaMs,
}) {
  if (!leaseManager
    || typeof leaseManager.controlConnesso !== 'function'
    || typeof leaseManager.sendControl !== 'function'
    || typeof leaseManager.ascoltaControl !== 'function'
    || !leaseManager.controlConnesso(cellId)) {
    return Promise.resolve({ outcome: 'identity-lost', conti: null });
  }
  const residuo = deadlineAt - monoNow();
  if (!Number.isSafeInteger(residuo) || residuo < 1) {
    return Promise.resolve({ outcome: 'stop-unknown', conti: null });
  }
  const grazia = Math.min(Math.max(1, graziaMs), residuo);
  const requestId = idRichiesta();
  const visto = { ack: false, ready: null, commit: null, report: null, eof: false };
  let chiuso = false;
  let fine;
  const done = new Promise((resolve) => { fine = resolve; });
  let offFrame = () => {};
  let offClose = () => {};
  let timer = null;
  const chiudi = () => {
    if (chiuso) return;
    chiuso = true;
    try { offFrame(); } catch (_) {}
    try { offClose(); } catch (_) {}
    if (timer) clearTimeout(timer);
    fine();
  };
  const considera = () => {
    if (visto.report && visto.report.code === 'eperm') chiudi();
    else if (visto.ready && visto.eof) chiudi();
    else if (visto.commit && visto.eof) chiudi();
    else if (visto.eof && !visto.ready && !visto.commit) chiudi();
  };
  offFrame = leaseManager.ascoltaControl((id, frame) => {
    if (id !== cellId || !frame || !frame.payload) return;
    const rif = frame.payload.stopRequestId;
    if (rif !== requestId && frame.requestId !== requestId) return;
    if (frame.op === 'stop-ack') visto.ack = true;
    else if (frame.op === 'ready-to-exit') visto.ready = frame.payload;
    else if (frame.op === 'escalate-commit') visto.commit = frame.payload;
    else if (frame.op === 'stop-report') visto.report = frame.payload;
    considera();
  });
  if (typeof leaseManager.suChiusuraControl === 'function') {
    offClose = leaseManager.suChiusuraControl(cellId, () => {
      visto.eof = true;
      considera();
    });
  }
  const attesa = deadlineAt - monoNow();
  timer = setTimeout(chiudi, Math.max(1, attesa));
  const spedito = leaseManager.sendControl(cellId, {
    op: 'stop', requestId, launchId, payload: { deadlineMs: grazia },
  });
  if (!spedito) {
    chiudi();
    return Promise.resolve({ outcome: 'identity-lost', conti: null });
  }
  return done.then(() => classificaEsito(visto));
}

module.exports = {
  killGruppoCorrente,
  osservaProduzione,
  normalizzaConti,
  classificaEsito,
  codiceEsito,
  esitoGruppoPulito,
  eseguiFaseStop,
  creaCoordinatore,
  attendiFermataGruppo,
  attendiPreparazione,
};
