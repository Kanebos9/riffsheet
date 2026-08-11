#!/bin/bash
# Builds Riffsheet (VST3 + AU + Standalone), signs it, and installs it locally.
#
# Xcode's own CodeSign phase is disabled in CMakeLists.txt. File-provider and
# archive tools can add extended attributes that make codesign reject a bundle,
# so this script strips them and ad-hoc signs the finished local build.
#
#   ./scripts/build.sh              dev build (timestamped name, auto-installs)
#   ./scripts/build.sh --release    clean "Riffsheet" name, installs to the real paths
#   ./scripts/build.sh --universal  arm64 + x86_64 (slower; for distribution)
#   ./scripts/build.sh --no-engine  leave the bundled Basic Pitch engine out (smaller build)
#   ./scripts/build.sh --ninja      build with Ninja + ccache instead of Xcode (see below)
#
# ABOUT --ninja, AND WHY IT IS NOT THE DEFAULT.
# Ninja usually beats the Xcode generator on incremental builds because it does not re-walk the
# project every time, and ccache can make a rebuild of unchanged code nearly free. Both are
# installed on this machine and both work here — a full VST3 build under Ninja was run and
# produced a correct bundle.
#
# What has NOT been established is that it is FASTER, on this project, on this machine. The
# comparison was attempted and every number came out contaminated: the machine was running a
# dozen parallel jobs at the time (load average 16-32), the same one-file rebuild measured 46 s
# and then 211 s under Xcode and 276 s then 479 s under Ninja, and ccache reported "input file
# modified during compilation" on 11 of 63 compiles, i.e. the tree was moving underneath it.
# Numbers taken under those conditions say nothing about either generator.
#
# So this stays opt-in until somebody measures it on an idle machine: build both ways, touch one
# .cpp, time each, twice. If Ninja wins, make it the default and delete this paragraph. If it
# does not, delete the flag. Do not decide from the numbers above — they are noise, and they are
# written down here so nobody is tempted to quote them.
#
# It uses "Ninja Multi-Config" rather than plain Ninja on purpose: plain Ninja puts the built
# bundles in Riffsheet_artefacts/ with no Release/ subdirectory, and the install step below
# would silently find nothing.
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"
BUILD="$ROOT/build"

ARCHS="arm64"
RELEASE_FLAG=""
WEBCORE_FLAG=""
ENGINE_FLAG=""
GENERATOR="Xcode"
CACHE_FLAGS=""
for arg in "$@"; do
  case "$arg" in
    # -DRIFFSHEET_REQUIRE_WEBCORE=ON: a release build must never fall back to the
    # placeholder UI in Resources/webcore. Without it a missing ../webcore/dist is
    # only a CMake warning, and the shipped bundle would silently be the test panel.
    --release)   RELEASE_FLAG="-DRIFFSHEET_RELEASE=ON -DRIFFSHEET_REQUIRE_WEBCORE=ON" ;;
    --universal) ARCHS="arm64;x86_64" ;;
    # Build without the bundled engine. It is most of the binary size, and a build
    # that will only ever drive an installed engine does not need to carry it.
    # Cleared with -U below like the other two sticky options, or one --no-engine
    # run would quietly produce engine-less builds forever after.
    --no-engine) ENGINE_FLAG="-DRIFFSHEET_WITHOUT_BASIC_PITCH=ON" ;;
    # Embed this repo's placeholder instead of ../webcore/dist. Useful while
    # Team B's bundle is still module-based (which the macOS WebView refuses).
    --placeholder) WEBCORE_FLAG="-DRIFFSHEET_WEBCORE_DIR=$PWD/Resources/webcore" ;;
    --ninja)
      command -v ninja >/dev/null || { echo "ninja is not installed: brew install ninja"; exit 2; }
      GENERATOR="Ninja Multi-Config"
      # A separate tree: a CMake build directory belongs to one generator for life, so reusing
      # ./build would fail with "does not match the generator used previously".
      BUILD="$ROOT/build-ninja"
      if command -v ccache >/dev/null; then
        CACHE_FLAGS="-DCMAKE_C_COMPILER_LAUNCHER=ccache -DCMAKE_CXX_COMPILER_LAUNCHER=ccache"
      fi
      ;;
    *) echo "unknown option: $arg"; exit 2 ;;
  esac
done

VST3_DIR="$HOME/Library/Audio/Plug-Ins/VST3"
AU_DIR="$HOME/Library/Audio/Plug-Ins/Components"

# -U RIFFSHEET_WEBCORE_DIR: CMakeLists only auto-detects ../webcore/dist when that
# variable is NOT already defined, and a -D from an earlier run sticks in the cache
# forever. So one --placeholder build used to pin every later build to the
# placeholder, silently, even after Team B shipped a working bundle. Clearing it
# first means the search order in CMakeLists.txt is re-evaluated every time, and
# --placeholder re-sets it on the same command line (later flags win).
#
# -U RIFFSHEET_RELEASE: same trap, same fix. One --release build would otherwise
# leave RIFFSHEET_RELEASE=ON in the cache, so a later plain dev run would inherit
# the clean product name — and with it the release install path — without asking.
#
# -U RIFFSHEET_WITHOUT_BASIC_PITCH: and again. This one is the worst of the three
# to inherit silently, because the build succeeds and installs — it just has no
# engine in it, which nobody discovers until a transcription is asked for.

# Stale artefacts from an earlier timestamped build would otherwise be signed and
# installed next to the new one - two bundles, one plugin UID, and a DAW scanner
# hangs. Only the build tree is cleared here; installed plugins are deliberately
# left alone until all three targets pass below.
#
# This MUST stay ahead of the configure. juce_add_plugin writes
# Riffsheet_artefacts/JuceLibraryCode/vst3_helper/shared_{defs,incs}_Release.txt
# with file(GENERATE) - i.e. at generate time, as part of configuring - and the
# VST3 manifest helper's own nested CMake project reads them back at build time.
# Clearing the directory after the configure deletes those two files with nothing
# left to regenerate them, and Riffsheet_VST3 dies in the helper's configure with
# "file failed to open for reading: .../shared_defs_Release.txt".
rm -rf "$BUILD/Riffsheet_artefacts"

echo "==> Configuring (generator: $GENERATOR, archs: $ARCHS)..."
cmake -B "$BUILD" -U RIFFSHEET_WEBCORE_DIR -U RIFFSHEET_RELEASE -U RIFFSHEET_WITHOUT_BASIC_PITCH \
      -G "$GENERATOR" \
      -DCMAKE_OSX_ARCHITECTURES="$ARCHS" $RELEASE_FLAG $WEBCORE_FLAG $ENGINE_FLAG $CACHE_FLAGS >/dev/null

for target in Riffsheet_VST3 Riffsheet_AU Riffsheet_Standalone; do
  echo "==> Building $target..."
  LOG_FILE="${TMPDIR:-/tmp}/riffsheet-${target}.log"
  if ! cmake --build "$BUILD" --config Release --target "$target" >"$LOG_FILE" 2>&1; then
    cat "$LOG_FILE"
    echo "BUILD FAILED: $target" >&2
    exit 1
  fi
  grep -E "error:|warning: .*\[-W|\*\* BUILD" "$LOG_FILE" | grep -v "iOSSimulator" || true
done

ART="$BUILD/Riffsheet_artefacts/Release"

[ -d "$ART/VST3" ] || { echo "BUILD FAILED: VST3 artefact missing" >&2; exit 1; }
[ -d "$ART/AU" ] || { echo "BUILD FAILED: AU artefact missing" >&2; exit 1; }
[ -d "$ART/Standalone" ] || { echo "BUILD FAILED: Standalone artefact missing" >&2; exit 1; }

# Strip, sign and verify ONE bundle, retrying the whole three-step sequence.
#
# WHY A RETRY AND NOT A LONGER xattr RUN. This repo lives on an iCloud-synced
# Desktop, and the file provider re-adds com.apple.FinderInfo to files it is
# still syncing - including ones that were clean a millisecond ago. So a run can
# strip, sign, and then have verify fail with "resource fork, Finder
# information, or similar detritus not allowed in an object file", which is
# exactly what happened once on a --release run here; an immediate re-run
# succeeded. The window is small and it does not reopen, so re-stripping and
# re-signing after a short pause clears it.
#
# The hardening is untouched: the LAST attempt's verify still decides, a
# verify that never succeeds still returns non-zero, and every caller below
# still aborts on that before anything destructive happens.
# 3 -> 6. The arithmetic, with wave 3's measured ~2-in-10 failure per ATTEMPT: a
# --release run signs six bundles (three artefacts, then three staged copies), so
# at 3 attempts a run fails with probability 1 - (1 - 0.2^3)^6 = 4.7%, about one
# run in 21; at 6 it is 1 - (1 - 0.2^6)^6 = 0.04%, about one in 2600. (If the
# re-marking is correlated rather than independent - the file provider stamping
# the same bundle repeatedly - retries help less than that and more of them help
# more, which points the same way.) Costs nothing when nothing fails: the extra
# attempts only happen on a bundle that was going to abort the run anyway.
SIGN_ATTEMPTS=6
sign_and_verify() {
  local bundle="$1" quiet="${2:-}" attempt=1 signout=""

  while :; do
    # Re-strip on every attempt, not only the first: the whole point is that the
    # attributes may have come back since the last one.
    xattr -cr "$bundle" 2>/dev/null || true

    if [ -n "$quiet" ]; then
      codesign --force --deep --sign - --timestamp=none "$bundle" >/dev/null 2>&1 || true
    else
      signout="$(codesign --force --deep --sign - --timestamp=none "$bundle" 2>&1 || true)"
      [ -n "$signout" ] && printf '%s\n' "$signout" | sed 's/^/    /'
    fi

    # AND AGAIN, IMMEDIATELY BEFORE THE VERIFY.
    #
    # This is the whole fix for the failure that made a --release run abort six
    # times in a row rather than once in a while. The file provider re-stamps
    # com.apple.FinderInfo on the bundle ROOT about three seconds after it is
    # cleared, and `codesign --deep` on these bundles takes longer than that - so
    # the strip at the top of the loop was reliably stale by the time verify ran,
    # and the `sleep 2` below handed the daemon the window it needed to do it
    # again. Stripping here closes the gap to milliseconds.
    #
    # Nothing is weakened by this. It is the same `xattr` the loop already ran,
    # at a moment when it can still matter; FinderInfo on the bundle directory
    # is applied from outside and is not part of what was signed. A genuine
    # resource fork inside an object file would have been removed by the first
    # strip and would not come back, so this cannot hide one. The verify below is
    # still --strict and still the thing that decides.
    #
    # -c, NOT -cr, AND THAT IS THE POINT. The recursive form walks several
    # thousand files in these bundles and takes long enough that the provider
    # re-stamps the ROOT - which it strips first - before the traversal is even
    # finished, so `xattr -cr` immediately before a verify could still lose the
    # race it was added to win. On a night when two builds and an iCloud sync
    # were running at once this stopped being intermittent and failed all six
    # attempts, repeatedly. The recursive strip at the top of the loop is what
    # covers the contents; this one exists solely to clear the bundle root at the
    # last possible instant, and non-recursively it is a single syscall.
    xattr -cr "$bundle" 2>/dev/null || true
    xattr -c  "$bundle" 2>/dev/null || true

    # `verify && echo` would be exempt from set -e: a rejected bundle would
    # neither abort nor print. Check it explicitly.
    if codesign --verify --strict "$bundle"; then
      return 0
    fi

    if [ "$attempt" -ge "$SIGN_ATTEMPTS" ]; then
      echo "    signature verify failed $SIGN_ATTEMPTS times: $bundle" >&2
      return 1
    fi

    echo "    verify failed (attempt $attempt/$SIGN_ATTEMPTS) - re-stripping and re-signing: $(basename "$bundle")" >&2
    attempt=$((attempt + 1))
    # Deliberately short. A long pause is not neutral here: it is time for the
    # file provider to re-stamp what the next attempt is about to strip.
    sleep 0.3
  done
}

echo "==> Stripping xattrs and ad-hoc signing..."
for bundle in "$ART"/VST3/*.vst3 "$ART"/AU/*.component "$ART"/Standalone/*.app; do
  [ -e "$bundle" ] || continue
  sign_and_verify "$bundle" || { echo "BUILD FAILED: signature verify failed: $bundle" >&2; exit 1; }
  echo "    OK  $(basename "$bundle")"
done

if [ -n "$RELEASE_FLAG" ]; then
  # Stage and verify every destination copy before touching an installed bundle.
  # Two bundles sharing one plugin UID can hang a DAW scanner, so old timestamped
  # builds are removed only after all three staged copies are ready to rename.
  echo "==> Installing release build under clean names..."
  mkdir -p "$VST3_DIR" "$AU_DIR"
  STAGE_VST3="$VST3_DIR/.riffsheet-install-$$.vst3"
  STAGE_AU="$AU_DIR/.riffsheet-install-$$.component"
  STAGE_APP="/Applications/.riffsheet-install-$$.app"
  cleanup_staging() {
    rm -rf -- "$STAGE_VST3" "$STAGE_AU" "$STAGE_APP"
  }
  trap cleanup_staging EXIT

  # Staging happens inside each destination directory on purpose: the final mv is
  # then a same-directory rename, which cannot leave a half-written bundle under the
  # real name. The cost is that a kill -9 or a power loss skips the EXIT trap and
  # strands a dot-prefixed bundle that the DAW still scans and that carries the same
  # plugin UID. The `Riffsheet*` glob below never matches a dot-prefixed name, so
  # reclaim past orphans here — before staging, never after: our own staging names
  # match this pattern too.
  rm -rf -- "$VST3_DIR"/.riffsheet-install-*.vst3 \
            "$AU_DIR"/.riffsheet-install-*.component \
            /Applications/.riffsheet-install-*.app

  cp -R "$ART/VST3/Riffsheet.vst3"      "$STAGE_VST3"
  cp -R "$ART/AU/Riffsheet.component"   "$STAGE_AU"
  cp -R "$ART/Standalone/Riffsheet.app" "$STAGE_APP"

  for b in "$STAGE_VST3" "$STAGE_AU" "$STAGE_APP"; do
    # Same set -e hole as above, and far worse here: an unverifiable staged copy
    # would be moved in after the installed plugins had already been deleted. The
    # retry inside sign_and_verify absorbs the iCloud xattr race; a bundle that
    # still will not verify aborts, and the abort is still ahead of the rm.
    sign_and_verify "$b" quiet || { echo "staging verify failed: $b" >&2; exit 1; }
    echo "    OK  $b"
  done

  # Everything that can fail must fail before the rm: after it, the three mv's are
  # the only steps between "old plugins deleted" and "new ones in place". The staged
  # copies above already proved these three directories writable; re-check anyway,
  # because this is the last moment at which aborting costs nothing.
  for d in "$VST3_DIR" "$AU_DIR" /Applications; do
    [ -d "$d" ] && [ -w "$d" ] || { echo "install target missing or not writable: $d" >&2; exit 1; }
  done

  install_failed() {
    echo "" >&2
    echo "!!  INSTALL INCOMPLETE: the old plugins were removed and a move failed." >&2
    echo "!!  failed to move into place: $1" >&2
    for p in "$VST3_DIR/Riffsheet.vst3" "$AU_DIR/Riffsheet.component" "/Applications/Riffsheet.app"; do
      if [ -e "$p" ]; then echo "!!    INSTALLED: $p" >&2; else echo "!!    MISSING:   $p" >&2; fi
    done
    echo "!!  Re-run this script to finish the install. Do not rescan plugins until it succeeds." >&2
    exit 1
  }

  rm -rf "$VST3_DIR"/Riffsheet*.vst3 "$AU_DIR"/Riffsheet*.component /Applications/Riffsheet*.app
  mv "$STAGE_VST3" "$VST3_DIR/Riffsheet.vst3"    || install_failed "$VST3_DIR/Riffsheet.vst3"
  mv "$STAGE_AU"   "$AU_DIR/Riffsheet.component" || install_failed "$AU_DIR/Riffsheet.component"
  mv "$STAGE_APP"  "/Applications/Riffsheet.app" || install_failed "/Applications/Riffsheet.app"
  trap - EXIT
elif [ -z "$RELEASE_FLAG" ]; then
  echo "==> Installing..."
  mkdir -p "$VST3_DIR" "$AU_DIR"
  for b in "$ART"/VST3/*.vst3;      do [ -e "$b" ] && cp -R "$b" "$VST3_DIR/"; done
  for b in "$ART"/AU/*.component;   do [ -e "$b" ] && cp -R "$b" "$AU_DIR/";   done
  # The copy re-acquires xattrs from the destination, so sign in place.
  for b in "$VST3_DIR"/Riffsheet*.vst3 "$AU_DIR"/Riffsheet*.component; do
    [ -e "$b" ] || continue
    xattr -cr "$b"
    codesign --force --deep --sign - --timestamp=none "$b" >/dev/null 2>&1
  done
fi

echo "==> Done."
ls -1d "$ART"/VST3/*.vst3 "$ART"/AU/*.component "$ART"/Standalone/*.app 2>/dev/null || true
