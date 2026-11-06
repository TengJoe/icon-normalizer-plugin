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
    return $rc
}
run Q16 "docs match the current version" check_doc_versions

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

echo
echo "  passed: $PASS   failed: $FAIL   skipped: $SKIP"
[ "$FAIL" -eq 0 ] || exit 1