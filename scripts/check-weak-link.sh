#!/usr/bin/env bash
# Asserts that FoundationModels.framework is weak-linked in a built app's
# executable(s). This is the regression test for DECISIONS.md D42: the
# podspec floor is iOS 16.4 (below FoundationModels' iOS 26.0), and the app
# is safe to launch below 26 only if every reference into the framework is
# LC_LOAD_WEAK_DYLIB rather than LC_LOAD_DYLIB. A strong reference would
# make dyld abort at launch on iOS 17-25 (see the podspec's `weak_frameworks`
# comment and docs/research/ios26-compat.md "The 16.4 podspec floor").
#
# Usage: scripts/check-weak-link.sh <path-to-.app-or-executable>
#
# - If given a `.app` bundle, the main executable is found via the bundle's
#   Info.plist `CFBundleExecutable` (not assumed from the bundle name).
# - If a `*.debug.dylib` sits next to the main executable (a Debug build,
#   where app code lives in the dylib rather than the main executable per
#   docs/research/ios26-compat.md), it is checked too.
# - If given a plain file, it is checked directly as a single executable.
#
# Fails unless every load command naming FoundationModels.framework is
# LC_LOAD_WEAK_DYLIB, and at least one such load command exists in at least
# one of the checked binaries.

set -euo pipefail

usage() {
  echo "Usage: $0 <path-to-.app-or-executable>" >&2
  exit 2
}

if [[ $# -ne 1 ]]; then
  usage
fi

target="$1"

if [[ ! -e "$target" ]]; then
  echo "error: no such path: $target" >&2
  exit 2
fi

# Collect the list of binaries to check.
binaries=()

if [[ -d "$target" ]]; then
  # Treat as an .app bundle: resolve the main executable from Info.plist.
  plist="$target/Info.plist"
  if [[ ! -f "$plist" ]]; then
    echo "error: $target looks like a bundle but has no Info.plist" >&2
    exit 2
  fi

  exec_name="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$plist" 2>/dev/null || true)"
  if [[ -z "$exec_name" ]]; then
    echo "error: could not read CFBundleExecutable from $plist" >&2
    exit 2
  fi

  main_bin="$target/$exec_name"
  if [[ ! -f "$main_bin" ]]; then
    echo "error: main executable not found at $main_bin (from CFBundleExecutable=$exec_name)" >&2
    exit 2
  fi
  binaries+=("$main_bin")

  # Debug builds put app code in a `*.debug.dylib` next to the main
  # executable rather than in it (docs/research/ios26-compat.md). Check it
  # too when present, so this script works for both Debug and Release.
  while IFS= read -r -d '' dylib; do
    binaries+=("$dylib")
  done < <(find "$target" -maxdepth 1 -name '*.debug.dylib' -print0)
else
  binaries+=("$target")
fi

echo "Checking FoundationModels weak-linkage in:"
for b in "${binaries[@]}"; do
  echo "  - $b"
done

overall_found=0
overall_fail=0
fail_details=()

for bin in "${binaries[@]}"; do
  # Walk otool -l's load-command blocks, each starting with a line like
  # "Load command N". For each block, track its `cmd` type and, if it names
  # FoundationModels.framework, record whether that cmd was the weak variant.
  while IFS=$'\t' read -r cmd name; do
    [[ -z "$name" ]] && continue
    if [[ "$name" == *"FoundationModels.framework"* ]]; then
      overall_found=$((overall_found + 1))
      if [[ "$cmd" != "LC_LOAD_WEAK_DYLIB" ]]; then
        overall_fail=$((overall_fail + 1))
        fail_details+=("$bin: FoundationModels loaded via $cmd (expected LC_LOAD_WEAK_DYLIB) -- name: $name")
      else
        echo "  OK: $bin -- $cmd -- $name"
      fi
    fi
  done < <(otool -l "$bin" | awk '
    /^Load command/ { cmd=""; name="" }
    /^[[:space:]]+cmd LC_/ { cmd=$2 }
    /^[[:space:]]+name / {
      # Strip the leading "         name " and any trailing "(offset N)".
      line=$0
      sub(/^[[:space:]]+name /, "", line)
      sub(/ \(offset [0-9]+\)$/, "", line)
      name=line
      if (cmd != "" && name != "") print cmd "\t" name
    }
  ')
done

if [[ $overall_found -eq 0 ]]; then
  echo "FAIL: no load command naming FoundationModels.framework was found in any checked binary." >&2
  echo "Checked: ${binaries[*]}" >&2
  exit 1
fi

if [[ $overall_fail -gt 0 ]]; then
  echo "FAIL: FoundationModels.framework is strongly linked in ${overall_fail} load command(s):" >&2
  for d in "${fail_details[@]}"; do
    echo "  - $d" >&2
  done
  echo "This would crash at launch (dyld) on iOS below 26, where FoundationModels does not exist." >&2
  echo "Fix: ensure OnDeviceLlm.podspec keeps 's.weak_frameworks = \"FoundationModels\"' and that" >&2
  echo "no source references FoundationModels outside an #available(iOS 26.0, *) guard." >&2
  exit 1
fi

echo "PASS: FoundationModels.framework is weak-linked (LC_LOAD_WEAK_DYLIB) in every checked binary (${overall_found} load command(s) found)."
