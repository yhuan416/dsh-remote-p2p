#!/usr/bin/env bash
# Install dsh-remote-p2p into a dsh profile as a profile dependency + selected bundle.
# One package covers both halves: the node publishes its identity for peers, and proxies any paired peers it is configured with.
# Usage: ./scripts/install.sh [profile]        (default: web)
#
# Migrating from dsh-remote-hub and/or dsh-remote-agent: run this once per profile; it removes the old dependencies, bundle
# selections and node_modules links, and keeps remote-hosts.json / remote-agent.json, so configured remotes and tokens carry over.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROFILE="${1:-web}"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE_DIR="$DSH_HOME/profiles/$PROFILE"
MANIFEST="$PROFILE_DIR/package.json"
PATCH="$PROFILE_DIR/cordis.patch.yml"
PACKAGE="dsh-remote-p2p"
LEGACY=("dsh-remote-hub" "dsh-remote-agent")

[ -f "$ROOT/lib/index.js" ] || { echo "error: lib/index.js missing; run this from the repository" >&2; exit 1; }
[ -f "$MANIFEST" ] || { echo "error: profile '$PROFILE' not found at $PROFILE_DIR (run dsh web once to create it)" >&2; exit 1; }

mkdir -p "$DSH_HOME/profiles/node_modules" "$PROFILE_DIR/node_modules"
ln -sfn "$ROOT" "$PROFILE_DIR/node_modules/$PACKAGE"
ln -sfn "$ROOT" "$DSH_HOME/profiles/node_modules/$PACKAGE"
echo "linked: $PROFILE_DIR/node_modules/$PACKAGE -> $ROOT"
for old in "${LEGACY[@]}"; do
  rm -f "$PROFILE_DIR/node_modules/$old" "$DSH_HOME/profiles/node_modules/$old"
done

cp "$MANIFEST" "$MANIFEST.bak-$(date +%Y%m%d-%H%M%S)"
node - "$MANIFEST" "$ROOT" "$PACKAGE" "${LEGACY[@]}" <<'NODE'
const fs = require('fs')
const [manifestPath, root, pkg, ...legacy] = process.argv.slice(2)
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
manifest.dependencies = Object.assign({}, manifest.dependencies || {})
manifest.dependencies[pkg] = 'file:' + root
for (const old of legacy) delete manifest.dependencies[old]
const dsh = manifest.dsh = manifest.dsh || {}
const profile = dsh.profile = dsh.profile || {}
const bundles = profile.bundles = Array.isArray(profile.bundles) ? profile.bundles : []
for (const old of legacy) {
  const at = bundles.indexOf(old)
  if (at >= 0) bundles.splice(at, 1)
}
if (!bundles.includes(pkg)) bundles.push(pkg)
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
console.log('manifest: ' + pkg + ' dependency + bundle recorded; legacy entries removed')
NODE

# Drop manual patch rows left by older installs (the bundle patch supplies the row now).
if [ -f "$PATCH" ]; then
  if grep -qE '^\s*-?\s*id: (remote-hub|remote-agent)$|id: (remote-hub|remote-agent)$' "$PATCH"; then
    cp "$PATCH" "$PATCH.bak-$(date +%Y%m%d-%H%M%S)"
    node - "$PATCH" <<'NODE'
const fs = require('fs')
const patchPath = process.argv.slice(2)[0]
const lines = fs.readFileSync(patchPath, 'utf8').split('\n')
const kept = []
let skipping = false
for (const line of lines) {
  if (/^\s*-?\s*id: (remote-hub|remote-agent)\s*$/.test(line) || /^# dsh-remote-(hub|agent):/.test(line)) {
    skipping = true
    // drop the block this row started; neighboring keys belong to it
    continue
  }
  if (skipping) {
    if (/^\s{6,}\S/.test(line) || line.trim() === '') continue
    skipping = false
  }
  kept.push(line)
}
fs.writeFileSync(patchPath, kept.join('\n').replace(/\s+$/, '') + '\n')
console.log('patch: removed legacy remote-hub/remote-agent rows')
NODE
  fi
fi

echo
echo "next:"
echo "  1. restart dsh web / this node (the bundle selection is composed at startup)"
echo "  2. Settings -> Plugins -> dsh-remote-p2p"
echo "  3. manage peers in the '远端链路' section; switch nodes from the top bar"
echo "  4. curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3080/remotes/   # 401 = plugin loaded"
