#!/usr/bin/env bash
# Stages Microsoft's ONNX Runtime library for one platform into
# src-tauri/onnxruntime/, where bundle.resources (`onnxruntime/*`) picks it up
# and ort loads it at run time (load-dynamic).
#
#   scripts/stage-onnxruntime.sh linux-x64|osx-arm64|win-x64
#
# Source: Microsoft's own NuGet package, Microsoft.ML.OnnxRuntime. Since
# 2026-11-17 the GitHub repository (github.com/microsoft/onnxruntime) and its
# release downloads answer 404, which stopped v0.5.19. The package holds the
# same CPU builds, signed by Microsoft, under runtimes/<platform>/native/, and
# names the libraries without the version (libonnxruntime.so, .dylib).
#
# One file for every platform, pinned by its SHA-256, which matches the SHA-512
# NuGet recorded when 1.24.2 was published (2026-02-19). Run from the repository
# root. Paths stay relative: on the Windows runner an absolute git-bash path
# reaches PowerShell as /d/a/... and tar reads `D:` as a remote host.
set -euo pipefail

ORT_VER=1.24.2
ORT_SHA256=782564d3d68e87269ea1812cc94710ad06fe014faf093f01a6f89d0bd58719d3

RID="${1:-}"
case "$RID" in
  linux-x64) LIBS="libonnxruntime.so libonnxruntime_providers_shared.so" ;;
  osx-arm64) LIBS="libonnxruntime.dylib" ;;
  win-x64)   LIBS="onnxruntime.dll onnxruntime_providers_shared.dll" ;;
  *) echo "usage: $0 linux-x64|osx-arm64|win-x64" >&2; exit 1 ;;
esac

work=".onnxruntime-download"
rm -rf "$work"
mkdir -p "$work"
trap 'rm -rf "$work"' EXIT

# .zip, so PowerShell's Expand-Archive accepts it on Windows.
pkg="$work/ort.zip"
curl -fSL --retry 3 -o "$pkg" \
  "https://api.nuget.org/v3-flatcontainer/microsoft.ml.onnxruntime/${ORT_VER}/microsoft.ml.onnxruntime.${ORT_VER}.nupkg"

if command -v sha256sum >/dev/null 2>&1; then
  got="$(sha256sum "$pkg" | cut -d' ' -f1)"
else
  got="$(shasum -a 256 "$pkg" | cut -d' ' -f1)"
fi
if [ "$got" != "$ORT_SHA256" ]; then
  echo "::error::ONNX Runtime ${ORT_VER} package SHA-256 is $got, expected $ORT_SHA256" >&2
  exit 1
fi

if command -v unzip >/dev/null 2>&1; then
  unzip -q "$pkg" "runtimes/${RID}/native/*" -d "$work/x"
else
  powershell -NoProfile -Command "Expand-Archive -Force -Path '$pkg' -DestinationPath '$work/x'"
fi

mkdir -p src-tauri/onnxruntime
for lib in $LIBS; do
  cp "$work/x/runtimes/${RID}/native/${lib}" "src-tauri/onnxruntime/${lib}"
done
echo "Staged ONNX Runtime ${ORT_VER} (${RID}):"
ls -la src-tauri/onnxruntime/
