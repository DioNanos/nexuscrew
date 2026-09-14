#!/bin/sh
':' //; d=$(dirname "$0"); if [ -x "$d/node" ]; then exec "$d/node" "$0" "$@"; fi; n=$(command -v node) || { echo "nexuscrew: node not found next to the launcher or in PATH" >&2; exit 127; }; exec "$n" "$0" "$@"
//: <<'0;'
'use strict';
// This file is TWO languages at once, and it has to be: the shebang `#!/bin/sh`
// exists on Android as well, while `#!/usr/bin/env node` only resolves when the
// Termux extension that rewrites /usr/bin/env happens to be loaded (a boot
// script or a tmux session started elsewhere does not load it — measured:
// "/bin/sh: .../usr/bin/nexuscrew: No such file or directory").
//
// Line 2 is the trick: `':'` is the sh no-op and a JavaScript string, and the
// rest of the line is a sh statement inside a JavaScript comment. It execs the
// same file with node, so the rest of this file is ordinary JavaScript and
// `bin/nexuscrew.js` stays the single entrypoint npm links and Windows shims.
//
// node is resolved where it actually lives next to a launcher: `$PREFIX/bin`
// on Termux and `.../bin` under nvm both keep `node` and `nexuscrew` in the
// same directory, which is the node the launcher was installed with. PATH is
// the fallback, and `$0` is used as given — `dirname` of a symlink is already
// the right directory, and `readlink -f` is not portable.
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
0;
