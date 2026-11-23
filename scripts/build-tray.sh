#!/bin/sh
# Builds bin/tau-tray.exe from native/tray at the checked-out commit and checks that the exe carries that commit,
# so a release never ships a tray older than its sources (ompweb-dev/ompweb#530). Runs on Linux too: tray.csproj sets
# EnableWindowsTargeting. publish.yml runs it before npm publish; verify-pr.yml runs it on every PR.
set -eu
sha=$(git rev-parse HEAD)
out=$(mktemp -d)
dotnet publish native/tray/tray.csproj -c Release -r win-x64 -p:SourceRevisionId="$sha" -o "$out"
grep -qa "+$sha" "$out/tau-tray.exe" || { echo "tau-tray.exe does not carry commit $sha" >&2; exit 1; }
cp "$out/tau-tray.exe" bin/tau-tray.exe
rm -rf "$out"
echo "bin/tau-tray.exe built from $sha"
