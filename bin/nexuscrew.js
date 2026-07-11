#!/usr/bin/env node
'use strict';
// The normal product surface is the PWA. `nexuscrew` starts it in background;
// `nexuscrew show` starts it when needed and opens it.
const { dispatch } = require('../lib/cli/commands.js');
Promise.resolve(dispatch(process.argv.slice(2)))
  .then((r) => {
    if (!r || !r.keepAlive) process.exitCode = (r && r.code) || 0;
  })
  .catch((e) => {
    process.stderr.write(`nexuscrew: ${String((e && e.message) || e)}\n`);
    process.exitCode = 1;
  });
