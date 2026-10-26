'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const section = require('../lib/fleet/vl-claim-section.js');

test('uncertain release does not leave the next claim free', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-reserve-'));
  const claims = path.join(dir, 'claims');
  fs.mkdirSync(claims);
  const req = {
    v: 1, op: 'claim', requestId: '11'.repeat(8), root: path.join(dir, 'root'),
    launchId: '22'.repeat(8), ownerInstanceId: 'owner', cellId: 'cell',
    claimsDir: claims, sectionBudgetMs: 4000,
  };
  assert.equal(section.eseguiSezione(req).outcome, 'claimed');
  const sync = fs.fsyncSync;
  const link = fs.linkSync;
  let rel;
  try {
    fs.fsyncSync = (fd) => {
      if (fs.fstatSync(fd).isDirectory()) {
        const err = new Error('synthetic directory sync failure');
        err.code = 'EIO';
        throw err;
      }
      return sync(fd);
    };
    fs.linkSync = (src, dst) => {
      if (String(dst).endsWith('.reserve')) {
        const err = new Error('synthetic reserve link failure');
        err.code = 'EIO';
        throw err;
      }
      return link(src, dst);
    };
    rel = section.eseguiSezione({ ...req, op: 'release' });
  } finally {
    fs.fsyncSync = sync;
    fs.linkSync = link;
  }
  const next = section.eseguiSezione({ ...req, launchId: '33'.repeat(8) });
  assert.equal(rel.outcome, 'uncertain');
  assert.notEqual(next.outcome, 'claimed');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('final directory sync failure during release retains a reservation', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-finalsync-'));
  const claims = path.join(dir, 'claims');
  fs.mkdirSync(claims);
  const req = {
    v: 1, op: 'claim', requestId: '11'.repeat(8), root: path.join(dir, 'root'),
    launchId: '22'.repeat(8), ownerInstanceId: 'owner', cellId: 'cell',
    claimsDir: claims, sectionBudgetMs: 4000,
  };
  assert.equal(section.eseguiSezione(req).outcome, 'claimed');
  const sync = fs.fsyncSync;
  let dirs = 0;
  let release;
  try {
    fs.fsyncSync = (fd) => {
      if (fs.fstatSync(fd).isDirectory() && ++dirs === 4) {
        throw Object.assign(new Error('final directory sync EIO'), { code: 'EIO' });
      }
      return sync(fd);
    };
    release = section.eseguiSezione({ ...req, op: 'release' });
  } finally {
    fs.fsyncSync = sync;
  }
  const files = fs.readdirSync(claims);
  const next = section.eseguiSezione({ ...req, launchId: '33'.repeat(8) });
  assert.equal(release.outcome, 'uncertain');
  assert.notEqual(next.outcome, 'claimed');
  assert.ok(files.some((f) => f.endsWith('.reserve')), 'reserve record retained on disk');
  fs.rmSync(dir, { recursive: true, force: true });
});
