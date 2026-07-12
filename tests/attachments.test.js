'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { File } = require('node:buffer');

const mod = () => import('../frontend/src/lib/attachments.js');

test('attachments: distingue file da testo e ricava clipboard items', async () => {
  const { hasFilePayload, filesFromTransfer, attachmentName } = await mod();
  const image = new File([Buffer.from('png')], '', { type: 'image/png' });
  const transfer = { types: ['Files'], files: [], items: [{ kind: 'file', getAsFile: () => image }] };
  assert.equal(hasFilePayload(transfer), true);
  assert.deepEqual(filesFromTransfer(transfer), [image]);
  assert.equal(hasFilePayload({ types: ['text/plain'], files: [], items: [] }), false);
  assert.equal(attachmentName(image, 0, 123), 'clipboard-123-1.png');
});

test('attachments: upload federato sequenziale continua dopo un errore', async () => {
  const { uploadSessionFiles } = await mod();
  const files = [
    new File(['a'], 'one.txt', { type: 'text/plain' }),
    new File(['b'], 'two.txt', { type: 'text/plain' }),
    new File(['c'], 'three.txt', { type: 'text/plain' }),
  ];
  const calls = [];
  const fetchImpl = async (url, token, opts) => {
    const file = opts.body.get('file');
    calls.push({ url, token, session: opts.body.get('session'), paste: opts.body.get('paste'), name: file.name });
    if (file.name === 'two.txt') return { ok: false, status: 500, json: async () => ({ error: 'boom' }) };
    return { ok: true, status: 200, json: async () => ({ path: `/inbox/${file.name}` }) };
  };
  const result = await uploadSessionFiles({ files, token: 'TOKEN', session: 'cloud-Dev', node: 'relay/mac', paste: true, fetchImpl });
  assert.equal(calls.length, 3, 'un errore non tronca il batch');
  assert.equal(calls[0].url, '/api/route/relay/mac/_/files/upload');
  assert.equal(calls[0].paste, 'true');
  assert.deepEqual(result.paths, ['/inbox/one.txt', '/inbox/three.txt']);
  assert.deepEqual(result.errors, [{ name: 'two.txt', message: 'boom' }]);
});
