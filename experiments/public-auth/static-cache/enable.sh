#!/bin/sh
# Enable the static-cache plugin in one DSH profile. Run inside the container.
#
# Steps are idempotent: the package is copied into the profile's node_modules,
# recorded as a profile dependency, and inserted into the profile's patch layer
# only when the row is absent.
set -eu

PROFILE=${DSH_PROFILE_DIR:-/var/lib/dsh/profiles/web}
PACKAGE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
NAME='@perhydrol/dsh-static-cache'
TARGET="$PROFILE/node_modules/@perhydrol/dsh-static-cache"

[ -f "$PROFILE/package.json" ] || {
  echo "enable-static-cache: profile not found: $PROFILE" >&2
  exit 1
}
[ -f "$PACKAGE/dist/index.js" ] && [ -f "$PACKAGE/dist/service-worker.js" ] || {
  echo "enable-static-cache: package is not built: $PACKAGE/dist" >&2
  exit 1
}

mkdir -p "$TARGET"
cp "$PACKAGE/package.json" "$TARGET/package.json"
mkdir -p "$TARGET/dist"
cp -R "$PACKAGE/dist/." "$TARGET/dist/"
rm -f "$TARGET/dist/.tsbuildinfo-"*

node - "$PROFILE" "$NAME" "$PACKAGE" <<'NODE'
const fs = require('node:fs')
const path = require('node:path')
const [profile, name, packageDir] = process.argv.slice(2)

const manifestPath = path.join(profile, 'package.json')
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
manifest.dependencies = { ...manifest.dependencies, [name]: `file:${packageDir}` }
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

const patchPath = path.join(profile, 'cordis.patch.yml')
let patch = fs.existsSync(patchPath) ? fs.readFileSync(patchPath, 'utf8') : ''
const existing = new RegExp(`^\\s*name:\\s*['"]${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]\\s*(?:#.*)?$`, 'm')
if (!existing.test(patch)) {
  const row = [
    '- insert:',
    '    - id: static-cache',
    `      name: '${name}'`,
    '      config:',
    '        route: /__dsh-static-cache/sw.js',
    '        prime: true',
  ].join('\n')
  const stripped = patch.replace(/^\s*#.*$/gm, '').trim()
  patch = stripped === '[]'
    ? patch.replace(/^\[\][ \t]*$/m, row)
    : `${patch.replace(/\s*$/, '')}\n${row}\n`
  if (!patch.endsWith('\n')) patch += '\n'
  fs.writeFileSync(patchPath, patch)
}
console.log(`static-cache: enabled in ${profile}`)
NODE

echo 'static-cache: restart the harness container to load the plugin'
