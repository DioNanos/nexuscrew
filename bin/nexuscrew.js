#!/usr/bin/env node
'use strict';
// NexusCrew CLI dispatcher (portable). Subcomandi: init / serve / start / stop / status.
const { dispatch } = require('../lib/cli/commands.js');
const r = dispatch(process.argv.slice(2));
// serve tiene il processo vivo (server.listen); gli altri comandi escono.
if (!r || !r.keepAlive) process.exit((r && r.code) || 0);
