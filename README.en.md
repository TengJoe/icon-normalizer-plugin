# Icon Normalizer Plugin

[简体中文](README.md)

Icon Normalizer is a GNOME Shell extension and a user-level background service
that gives third-party application icons a consistent visual size and shape.
It reads original artwork without modifying system files and keeps recovery
records for its changes in your home directory.

The current frontend is **1.1.0**, with backend **3.1.0**. This release supports GNOME 51, verified by runtime acceptance tests.
Earlier GNOME versions require separate testing before being declared supported.

## Install or upgrade

From the project directory:

```bash
python3 tools/build.py
python3 tools/install.py
```

The builder validates GSettings schemas and creates an extension ZIP, a full
release tarball, and a SHA-256 manifest in `dist/`. The installer takes a
snapshot, validates staged files, upgrades the code, probes the backend, and
restores the previous automatic-maintenance state. Failed upgrades roll back.

Profiles and theme following require companion backend 3.1.0 or newer. A ZIP-only
upgrade with an older companion shows an upgrade hint and leaves these features disabled.

Runtime dependencies are Python 3.10 or newer, Python GI with GTK 3,
Pillow, numpy, systemd, `gtk-update-icon-cache`, and `glib-compile-schemas`.
The installer reports missing dependencies before changing the installation.
The GTK 3 backend and GTK 4 preferences run in separate processes.

After upgrading, close and reopen Preferences to use the new settings UI.
GNOME Shell caches imported extension modules, so top bar code upgrades need a
logout and login after saving your work. The installer does not end your session.

## Use the extension

Open **Icon Normalizer → Preferences** from the extensions manager.

- **Rules**: adjust coverage, tolerance and inner logo coverage; choose a preset;
  save settings alone or save and apply them. Saved settings load automatically.
- **App Icons**: search applications, filter actions, and compare original and
  normalized icons at 32, 48, 64, 128 or 256 pixels. Rules can skip individual icons.
- **Maintenance**: view the backend, theme, managed icon count and automatic
  maintenance; check, apply, activate the theme, or restore original icons.

In **Maintenance → Interface language**, choose **Follow system**, **简体中文**, or
**English**. Both the top bar and preferences use the same choice. Switching
languages updates the interface immediately and preserves the selected page,
search text, and unsaved visual settings. Protocol operation names and JSON
fields remain stable technical identifiers.

Enable **Show top bar icon** to use the symbolic icon in the panel. Its menu
shows icon health, automatic maintenance, the theme and last application time,
followed by check/apply actions and a Preferences shortcut.

The minimum window is 380×420 in Chinese and 420×420 in English, allowing room
for longer labels. In narrow windows, filters wrap, action buttons
stack vertically, navigation moves to the bottom, and previews become a single
column. Use vertical scrolling to reach content below the available height.

## Automatic maintenance and recovery

Maintenance runs independently of the extension window through the user's
`icon-normalizer.path` and `icon-normalizer.timer` units. The path unit notices
new or updated application launchers; the timer provides a periodic fallback.
Closing Preferences or locking the screen does not stop maintenance.

The Standard preset uses 88% target coverage, ±2 percentage-point tolerance,
and 72% inner coverage, with nine sizes from 16 to 512 pixels. Custom settings
are preserved by frontend upgrades.

Choose **Restore originals** in Maintenance to restore managed launchers and
the previous icon theme. A confirmation is required. External edits are
preserved and reported as conflicts instead of being overwritten.

```bash
# Restore managed changes and remove the installation:
python3 tools/uninstall.py

# Remove only the extension, leaving the background service installed:
python3 tools/uninstall.py --keep-backend
```

Backups remain in `~/.local/state/icon-normalizer/backups/`.

## Validation and limits

```bash
node tests/frontend/syntax-check.mjs
node tests/frontend/stateModel.test.mjs
node tests/frontend/i18n.test.mjs
node --experimental-vm-modules tests/frontend/indicator.test.mjs
python3 tests/frontend/test_runtime.py
python3 tests/frontend/headless_shell.py
python3 -m unittest discover -s tests/installation -p 'test_*.py'
```

Runtime tests use private backend fixtures. The headless Shell acceptance test
uses a separate HOME, session bus, settings store and fake service manager, and
captures both language menus without replacing the live desktop.

Tray/AppIndicator icons and applications that draw icons directly bypass the
icon theme. Non-default `XDG_DATA_HOME` is unsupported. This release is for
local installation and is not published on extensions.gnome.org.

See `docs/CHECKLIST.md` for the full acceptance commands and recovery procedures,
`ARCHITECTURE.md` for module boundaries, and `PROTOCOL.md` for the frozen v1 wire
contract. Those technical reference documents currently use Chinese.

## Custom profiles and icon themes

Save the current visual parameters as a named profile in Rules. Use, rename or
delete up to 50 profiles. Use fills the draft; Save or Save and apply controls when
it becomes active. Profiles work across icon themes.

Follow icon theme is enabled by default in Maintenance. With automatic maintenance
on, choosing another installed icon theme retains visual settings and generates a
new DockNormalized overlay. The timer checks every minute even with preferences
closed. Changing GTK/Shell appearance keeps visual settings. Selecting the restore
source itself does not force overlay reactivation. Restore returns to the latest
selected source theme. Failed migrations roll back icons, policy and restore data.

See [submission notes](docs/SUBMISSION.md) for the separate companion service and
review boundaries. Source and issues are at [https://github.com/TengJoe/icon-normalizer-plugin](https://github.com/TengJoe/icon-normalizer-plugin). The repository must be public before an EGO submission. Source is licensed under
GPL-3.0-or-later; see [LICENSE](LICENSE).
