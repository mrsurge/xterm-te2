# TE2 xterm Patch Guide

## Source Baseline

- Upstream: `https://github.com/xtermjs/xterm.js.git`
- TE2 origin: `https://github.com/mrsurge/xterm-te2.git`
- Baseline tag: `5.3.0`
- Baseline commit: `2e02c37e528c1abc200ce401f49d0d7eae330e63`
- TE2 branch: `te2-android-ime`

The TE2 framework currently pins browser xterm, `xterm-headless`, and the
serialize addon to the 5.3 release family. Keep this branch on that baseline
until all three consumers are intentionally upgraded together.

## Android IME Patch

The Android-only browser input path lives in
`src/browser/input/AndroidInputTransaction.ts`. It treats the hidden textarea
as a cumulative IME transaction and emits corrections through xterm's existing
core data event. It does not call a TE2 transport or infer terminal content
owned by the PTY.

The integration points are intentionally narrow:

- `src/browser/input/CompositionHelper.ts` selects the Android transaction.
- `src/browser/Terminal.ts` owns focus, input, reset, and disposal lifecycle.
  While Android mode is active, printable text is accepted only through the
  cumulative textarea `input` projection; upstream `keypress` processing is
  bypassed. Keydown remains authoritative for non-text keys and modified
  terminal commands. Enter and Ctrl+C reseed the guarded Android projection
  immediately after xterm's accessibility clear, and ordinary printable
  keydown restores a missing guard before yielding to native textarea input.
- `src/common/Platform.ts` detects Android from the browser user agent.
- `css/xterm.css` keeps the native textarea detached and suppresses xterm's
  visible composition projection on Android.

Desktop and screen-reader composition retain the upstream path.

## Install And Validate

The 5.3 lock contains stale Node engine declarations. On current Node, install
the exact Yarn lock without running unrelated native package scripts:

```bash
npx --yes yarn@1.22.22 install --frozen-lockfile --ignore-scripts --ignore-engines
./node_modules/.bin/tsc -b src/browser
./node_modules/.bin/eslint -c .eslintrc.json --max-warnings 0 \
  src/browser/input/AndroidInputTransaction.ts \
  src/browser/input/AndroidInputTransaction.test.ts \
  src/browser/input/CompositionHelper.ts \
  src/browser/Terminal.ts \
  src/browser/TestUtils.test.ts \
  src/browser/Types.d.ts \
  src/common/Platform.ts
```

Node 21 and newer expose a global `navigator`, which the 5.3 test harness
mistakes for a browser. Delete it before loading the focused tests:

```bash
NODE_PATH="$PWD/out" node <<'JS'
delete global.navigator;
const Mocha = require('mocha');
require('source-map-support/register');
const mocha = new Mocha({ timeout: 10000 });
mocha.addFile('out/browser/input/AndroidInputTransaction.test.js');
mocha.addFile('out/browser/input/CompositionHelper.test.js');
mocha.run(failures => process.exitCode = failures ? 1 : 0);
JS
```

## Build And Publish

The full upstream build includes addon dependency setup that TE2's browser
bundle does not need. Build the already-validated browser project and package
that output directly:

```bash
./node_modules/.bin/tsc -b src/browser
./node_modules/.bin/webpack --config webpack.config.js
cp lib/xterm.js ../../app/static/vendor/xterm/xterm.js
cp css/xterm.css ../../app/static/vendor/xterm/xterm.css
```

`lib/xterm.js`, `lib/xterm.js.map`, and `out/` are generated. Do not edit or
commit them on this branch. TE2 publishes `xterm.js` and `xterm.css`; the source
map is intentionally not copied into the framework vendor tree.

## Rebase Workflow

Keep TE2 changes as a small commit stack above the upstream tag. To move to a
new upstream baseline, fetch upstream, create a temporary branch at the target,
then replay or quilt the TE2 commits in order. Resolve behavior in the readable
TypeScript and tests first, rebuild, and only then replace TE2's generated
vendor files.
