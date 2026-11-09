#!/usr/bin/env bash
# Run every documented quality gate (Q1-Q13). Exit non-zero on the first failure.
# Usage: tools/verify.sh [--quick]   (--quick skips the display-dependent gates)
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 2

QUICK=0
[ "${1:-}" = "--quick" ] && QUICK=1

# Display-dependent gates need the session bus and a compositor.
if [ -z "${XDG_RUNTIME_DIR:-}" ]; then export XDG_RUNTIME_DIR="/run/user/$(id -u)"; fi
if [ -z "${WAYLAND_DISPLAY:-}" ] && [ -S "$XDG_RUNTIME_DIR/wayland-0" ]; then export WAYLAND_DISPLAY=wayland-0; fi
if [ -z "${DISPLAY:-}" ] && [ -S /tmp/.X11-unix/X0 ]; then export DISPLAY=:0; fi

PASS=0; FAIL=0; SKIP=0
run() {
    local id="$1" name="$2"; shift 2
    printf "  %-4s %-38s " "$id" "$name"
    if "$@" >/tmp/verify-step.log 2>&1; then
        printf "PASS\n"; PASS=$((PASS+1))
    else
        printf "FAIL\n"; FAIL=$((FAIL+1)); sed "s/^/       /" /tmp/verify-step.log | tail -12
        # A fullscreen or maximised window on top of the session stops Wayland
        # from sending frame callbacks to the fixture window, which looks like a
        # regression but is not one. Say so instead of leaving a bare FAIL.
        if grep -q "did not complete the requested allocation" /tmp/verify-step.log; then
            printf "       hint: the GTK fixture window could not paint.\n"
            printf "       hint: keep the desktop visible (no fullscreen window on top)\n"
            printf "       hint: or run bash tools/verify.sh --quick to skip this gate.\n"
        fi
    fi
}

skip() { printf "  %-4s %-38s SKIP (%s)\n" "$1" "$2" "$3"; SKIP=$((SKIP+1)); }

echo "Icon Normalizer — quality gates"
echo

run Q1  "mypy strict"        python3 -m mypy
run Q2  "backend tests"      bash -c "cd backend && python3 -m unittest discover -s ../tests/backend -t ../tests/backend -q"
run Q3  "frontend syntax"    node tests/frontend/syntax-check.mjs
run Q4  "frontend logic"     bash -c "npm run lint --silent && npm run test:logic --silent"
run Q5  "installation tests" python3 -m unittest discover -s tests/installation -p "test_*.py" -q
run Q6  "build"              python3 tools/build.py
run Q7  "protocol tests"     bash -c "cd backend && python3 -m unittest discover -s ../tests/backend -t ../tests/backend -p \"test_protocol.py\" -q"

if [ "$QUICK" = "1" ]; then
    skip Q8  "GTK runtime"            "--quick"
    skip Q10 "isolated GNOME Shell"   "--quick"
else
    run Q8  "GTK runtime"        python3 tests/frontend/test_runtime.py
    run Q10 "isolated GNOME Shell" python3 tests/frontend/headless_shell.py
fi

run Q9  "indicator regression" node --experimental-vm-modules tests/frontend/indicator.test.mjs

run Q11 "i18n catalogue"     node --experimental-vm-modules tests/frontend/i18n.test.mjs
run Q12 "backend client"     node --experimental-vm-modules tests/frontend/backendClient.test.mjs
run Q13 "release + privacy"  bash -c "python3 tools/release_audit.py --submission >/dev/null && python3 tools/privacy_audit.py >/dev/null"

# Q14 keeps the installed tree honest: a code change that is never installed
# leaves the desktop running older code under the same version number.
if [ -d "$HOME/.local/libexec/icon-normalizer/icon_normalizer" ]; then
    check_drift() {
        local rc=0
        while IFS= read -r rel; do
            if ! cmp -s "backend/icon_normalizer/$rel" \
                    "$HOME/.local/libexec/icon-normalizer/icon_normalizer/$rel"; then
                echo "drift: backend/icon_normalizer/$rel differs from the installed copy"
                rc=1
            fi
        done < <(cd backend/icon_normalizer && find . -name '*.py' | sed 's|^\./||' | sort)
        return $rc
    }
    run Q14 "installed tree matches repo" check_drift

    # The extension tree is copied verbatim except for the version string and
    # the compiled schema that gnome-extensions generates on install.
    check_extension_drift() {
        local inst="$HOME/.local/share/gnome-shell/extensions/icon-normalizer@joeydeng.local"
        local out
        out=$(diff -r -x metadata.json -x gschemas.compiled extension/ "$inst/" 2>&1)
        if [ -n "$out" ]; then
            echo "$out" | head -6
            return 1
        fi
        return 0
    }
    run Q15 "installed extension matches repo" check_extension_drift
else
    skip Q14 "installed tree matches repo" "not installed"
    skip Q15 "installed extension matches repo" "not installed"
fi


# Q16 catches the "docs still claim an older version" drift.
check_doc_versions() {
    local ver rc=0
    ver=$(python3 -c "import json;print(json.load(open('extension/metadata.json'))['version-name'])")
    for doc in docs/HANDOVER.md docs/CHECKLIST.md docs/REVIEWER-NOTE.md; do
        [ -f "$doc" ] || continue
        if ! head -6 "$doc" | grep -q "\b$ver\b"; then
            echo "$doc does not mention the current version $ver in its header"
            rc=1
        fi
    done
    # The documentation index must point its "latest release" row at this version.
    if ! grep -q "RELEASE-$ver.md" docs/README.md; then
        echo "docs/README.md does not link RELEASE-$ver.md"
        rc=1
    fi
    # Both READMEs are the project's front page: their download links must
    # resolve to the current release, otherwise visitors install an old build.
    for f in README.md README.en.md; do
        [ -f "$f" ] || continue
        if ! grep -q "releases/tag/v$ver" "$f"; then
            echo "$f does not link releases/tag/v$ver"
            rc=1
        fi
        if grep -q "releases/download/v[0-9]" "$f" && ! grep -q "releases/download/v$ver/" "$f"; then
            echo "$f still downloads from an older release"
            rc=1
        fi
        # The badge label and the link must agree, or the front page advertises
        # one version while pointing at another.
        if grep -q "img.shields.io/badge/release-" "$f" \
                && ! grep -q "img.shields.io/badge/release-$ver-" "$f"; then
            echo "$f badge label is not $ver"
            rc=1
        fi
    done
    return $rc
}
run Q16 "docs match the current version" check_doc_versions

# Q17 machine-checks CONTRIBUTING.md line 30: documentation maintenance must not
# mint a new version. A PATCH bump has to come with a real code change in the same
# commit; MINOR and MAJOR bumps are deliberate releases and may stand alone.
check_version_bump_discipline() {
    if ! git rev-parse --git-dir >/dev/null 2>&1 || ! git rev-parse HEAD~1 >/dev/null 2>&1; then
        return 0
    fi
    local prev_ver now_ver touched
    prev_ver=$(git show HEAD~1:extension/metadata.json 2>/dev/null \
        | python3 -c "import json,sys;print(json.load(sys.stdin).get('version-name',''))" 2>/dev/null)
    now_ver=$(python3 -c "import json;print(json.load(open('extension/metadata.json'))['version-name'])")
    [ -z "$prev_ver" ] && return 0
    [ "$prev_ver" = "$now_ver" ] && return 0          # no bump at all: fine
    [ "${prev_ver%.*}" != "${now_ver%.*}" ] && return 0  # minor/major: deliberate release
    touched=$(git diff --name-only HEAD~1..HEAD -- extension backend \
        | grep -vE '^(extension/metadata\.json|backend/icon_normalizer/version\.py)$' \
        | wc -l)
    if [ "$touched" -eq 0 ]; then
        echo "patch bump $prev_ver -> $now_ver without any code change in the same commit"
        echo "documentation, tests and tooling must not mint a version (see docs/RELEASING.md)"
        return 1
    fi
    return 0
}
run Q17 "no patch bump without code" check_version_bump_discipline

# Q18 runs the in-process GJS engine unit tests.
check_gjs_units() {
    local f
    for f in analyze render desktop transaction resolver classification variants engine control uicontract; do
        if ! gjs -m "tests/gjs/${f}.test.js" >/dev/null; then
            echo "GJS unit test failed: tests/gjs/${f}.test.js"
            return 1
        fi
    done
    return 0
}
run Q18 "GJS engine unit tests" check_gjs_units

# Q19 verifies exact parity between GJS engine outputs and Python reference.
check_gjs_parity() {
    python3 tools/parity.py analyze >/dev/null && python3 tools/parity.py render >/dev/null \
        && python3 tools/parity.py fingerprint >/dev/null
}
run Q19 "GJS vs Python parity" check_gjs_parity

# Q20 keeps the UI and the engine honest about each other: every operation the
# interface invokes must have a contract case in tests/gjs/uicontract.test.js,
# written with the exact payload the UI constructs (the 1.3.0 review found a
# whole test suite passing while the rules page saved nothing, because the
# test was written from the implementation instead of the interface).
check_ui_contract() {
    gjs -m tests/gjs/uicontract.test.js >/dev/null 2>&1 || {
        echo "UI payload contract test failed: tests/gjs/uicontract.test.js"
        return 1
    }
    local ui_ops covered op missing=""
    ui_ops=$( { grep -rhoE "(call|read)\([^,]*,\s*'[a-z.]+'" \
            extension/prefs extension/shared extension/shell extension/extension.js \
            2>/dev/null
        grep -rhoE "_mutate\('[a-z.]+'" extension/prefs 2>/dev/null; } \
        | grep -oE "'[a-z.]+'" | tr -d "'" | sort -u)
    covered=$(grep -hoE "control.handle\('[a-z.]+'" tests/gjs/uicontract.test.js \
        | grep -oE "'[a-z.]+'" | tr -d "'" | sort -u)
    for op in $ui_ops; do
        # Exact whole-line match via awk: a shell grep alias/wrapper must
        # never be able to weaken this gate.
        awk -v op="$op" '$0==op{f=1} END{exit f?0:1}' <<<"$covered" || missing="$missing $op"
    done
    if [ -n "$missing" ]; then
        echo "UI invokes operations with no contract case:$missing"
        return 1
    fi
    return 0
}
run Q20 "UI payload contract" check_ui_contract

echo
echo "  passed: $PASS   failed: $FAIL   skipped: $SKIP"
[ "$FAIL" -eq 0 ] || exit 1