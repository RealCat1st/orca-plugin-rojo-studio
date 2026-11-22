#!/usr/bin/env sh
# Checks Rojo Studio and packages it into dist/ and ~/.orca/bots/project-manager/totest/.
# Orca needs no compile step (it transpiles .ts itself); "build" = typings, typecheck, validate,
# tests, check, then copy the plugin files and make a flat zip (orca-plugin.json at its root).
# ROJO_STUDIO_E2E=1 ./build.sh also runs the end-to-end test against the real Rojo (network).
set -eu
cd "$(dirname "$0")"
BOT="$HOME/.orca/bots/project-manager"
TOOLS="$BOT/build-tools"
OP="$TOOLS/orca-plugin-sdk-1.4.268/orca-plugin"
NODE="$(ls -d "$HOME"/.orca-remote/runtimes/node-*/bin/node | head -n 1)"
ID="rojo-studio"
VERSION="$(sed -n 's/^  "version": "\(.*\)",$/\1/p' orca-plugin.json)"
NAME="$ID-$VERSION"

echo "== plugin types";    "$OP" plugin types . >/dev/null
echo "== tsc";             "$NODE" "$TOOLS/typescript-5.9.3/bin/tsc" -p .
echo "== plugin validate"; "$OP" plugin validate .
echo "== plugin test";     "$OP" plugin test .
echo "== plugin check";    "$OP" plugin check .

rm -rf dist
mkdir -p "dist/$NAME"
cp -r orca-plugin.json README.md HOWTO.md LICENSE tsconfig.json .gitignore .gitattributes assets docs src typings "dist/$NAME/"
"$OP" plugin validate "dist/$NAME" >/dev/null
# Files at the zip root (no wrapper folder): Windows "Extract All" already creates <zip name>/,
# and a wrapper folder would nest the plugin one level too deep for Orca.
(cd dist && python3 -I -c "import shutil,sys; shutil.make_archive(sys.argv[1], 'zip', sys.argv[1])" "$NAME")
python3 -I -c "import sys,zipfile; n=zipfile.ZipFile(sys.argv[1]).namelist(); sys.exit(0 if 'orca-plugin.json' in n else 'orca-plugin.json not at zip root')" "dist/$NAME.zip"

# Only the newest build of this plugin stays in totest/.
mkdir -p "$BOT/totest"
rm -rf "$BOT/totest/$ID" "$BOT/totest/$ID"-[0-9]* "$BOT/totest/$ID"*.zip
cp -r "dist/$NAME" "dist/$NAME.zip" "$BOT/totest/"
echo "packaged: $BOT/totest/$NAME (+ .zip)"
