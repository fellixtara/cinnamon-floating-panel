#!/bin/sh
# Builds dist/<uuid>-<version>.zip from the committed files (HEAD), with the
# extension inside a folder named after its uuid, ready to unzip into
# ~/.local/share/cinnamon/extensions/. Files marked export-ignore in
# .gitattributes are left out.
set -e
cd "$(dirname "$0")/.."
uuid=$(python3 -c "import json; print(json.load(open('metadata.json'))['uuid'])")
version=$(python3 -c "import json; print(json.load(open('metadata.json'))['version'])")
mkdir -p dist
out="dist/$uuid-$version.zip"
git archive --format=zip --prefix="$uuid/" -o "$out" HEAD
echo "$out"
