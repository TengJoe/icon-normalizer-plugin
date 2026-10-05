# Icon Normalizer

[简体中文](README.md) · [Download v1.1.1](https://github.com/TengJoe/icon-normalizer-plugin/releases/tag/v1.1.1) · [Report an issue](https://github.com/TengJoe/icon-normalizer-plugin/issues) · [Support development](docs/SUPPORT.md)

Icon Normalizer gives GNOME application icons a consistent visual size and tile style. It combines a GNOME Shell extension with a user-level Python backend. Original system artwork stays read-only; generated icons and recovery records are stored in your home directory.

| Component | Current public release |
| --- | --- |
| Extension | 1.1.1 |
| Companion backend | 3.1.0 |
| Verified support | GNOME Shell 51 |
| Author | [TengJoe](https://github.com/TengJoe) |
| License | [GPL-3.0-or-later](LICENSE) |

## Features

- **Icon normalization**: adjust visual coverage, add tiles where appropriate, and generate nine icon sizes from 16 to 512 px.
- **Rules and custom profiles**: adjust target coverage, tolerance, and inner logo coverage; save, use, rename, or delete up to 50 named profiles.
- **Application icon management**: search and filter icons, compare original and normalized artwork, and skip individual icons.
- **Automatic maintenance and theme following**: detect application-launcher changes and retain visual parameters and per-icon rules when changing icon themes.
- **Adaptive Chinese and English interface**: stack action buttons, wrap filters, and show previews in one column in narrow windows; preserve the page, search text, and unsaved settings when switching languages.
- **Recovery**: restore managed launchers and the icon theme; preserve external edits and report conflicts.

## Installation and upgrades

### Requirements

This release declares support for **GNOME Shell 51**, verified by runtime acceptance tests. Other versions need separate validation.

| Purpose | Dependencies |
| --- | --- |
| Preferences | GJS, GTK 4, Libadwaita, and their GI typelibs |
| Image-processing backend | Python 3.10 or newer, Python GI, GTK 3, GdkPixbuf, Pillow, NumPy |
| Installation and maintenance | A systemd user session, `gtk-update-icon-cache`, `glib-compile-schemas` |

The GTK 3 backend and GTK 4 preferences run in separate processes. The installer checks backend and installation-tool dependencies. Install any missing distribution packages separately, following your distribution's instructions.

### Install the complete release

Download `icon-normalizer-plugin-1.1.1.tar.gz` and `SHA256SUMS` from [Release v1.1.1](https://github.com/TengJoe/icon-normalizer-plugin/releases/tag/v1.1.1). Put both files in the same directory and run as your normal user:

```bash
sha256sum --ignore-missing -c SHA256SUMS
tar -xzf icon-normalizer-plugin-1.1.1.tar.gz
cd icon-normalizer-plugin
python3 tools/install.py
```

Confirm that the checksum output is `OK` before installing. The complete release contains the extension, backend, and installer for a first installation or a full upgrade. The installer takes a snapshot, stages and validates files, replaces the code, and checks the backend. Failed upgrades restore the snapshot.

The separate `icon-normalizer@joeydeng.local.zip` contains only the extension frontend. Use it to update the frontend when the companion is already installed. Custom profiles and theme following require backend 3.1.0 or newer; older backends display an upgrade hint.

Per the GNOME review rule EGO-P-006 this ZIP **omits the compiled `schemas/gschemas.compiled`**; the extensions website compiles it during upload. If you install the ZIP manually with `gnome-extensions install`, run one extra command or the settings schema will not resolve:

```bash
glib-compile-schemas ~/.local/share/gnome-shell/extensions/icon-normalizer@joeydeng.local/schemas
```

Installing with `python3 tools/install.py` from source or from the complete release does not need this step; the installer compiles the schema itself.

### Install from source

Run from the project root:

```bash
python3 tools/build.py
python3 tools/install.py
```

The builder creates an extension ZIP, a complete release tarball, and `DIST_MANIFEST.json` in `dist/`. See the [contribution guide](CONTRIBUTING.md) for development checks and tests.

After upgrading, close and reopen Preferences to load the updated settings interface. GNOME Shell caches imported modules, so top bar code upgrades require saving your work and logging out and back in. The installer does not end your session.

## Usage

Open **Icon Normalizer → Preferences** from your extensions manager.

| Page | Common actions |
| --- | --- |
| Rules | Adjust visual settings, choose a preset or custom profile, then select **Save only** or **Save and apply** |
| App Icons | Search and filter icons, open comparison previews, and set per-icon skip rules |
| Maintenance | View status; use **Check now**, **Apply now**, or **Apply and activate**; configure automatic maintenance, theme following, and interface language |

The **Standard** preset uses **88%** target coverage, **±2 percentage points** of tolerance, and **72%** inner logo coverage. The nine output sizes are `16 / 24 / 32 / 48 / 64 / 96 / 128 / 256 / 512 px`.

### Custom profiles and theme following

**Save as custom profile** stores the current parameters. **Use profile** only fills the draft; **Save only** or **Save and apply** makes those parameters active. Profiles are independent of the icon theme.

**Maintenance → Follow icon theme** is enabled by default. With automatic maintenance also enabled, selecting another installed icon theme regenerates `DockNormalized` while preserving visual parameters and per-icon rules. The latest selected source theme becomes the restore target. Failed migrations restore the previous icons, configuration, and recovery records.

Changing the GTK or GNOME Shell appearance theme keeps your visual parameters. Selecting the current source theme does not force overlay activation; choose **Apply and activate** to enable the normalized theme again.

### Automatic maintenance, language, and the top bar

The user-level `icon-normalizer.path` unit detects application-launcher changes, while `icon-normalizer.timer` checks every minute as a fallback. Completion time depends on event detection and the number of icons. Closing Preferences or locking the screen does not stop background maintenance.

In **Maintenance → Interface language**, choose **Follow system**, **简体中文**, or **English**. The top bar and Preferences share this setting and update immediately.

The top bar button is disabled by default. Enable **Maintenance → Show top bar icon** to view status, check or apply icons, and open Preferences through the symbolic panel icon.

## Recovery and removal

In **Maintenance → Restore desktop icons**, select **Restore** and confirm to restore managed changes and the latest selected source theme. Managed launchers without external edits are restored byte for byte. Conflicts preserve external edits and report a failure.

Run from the complete release or source directory:

```bash
# Restore managed changes, then remove the extension and backend.
python3 tools/uninstall.py

# Remove only the extension, retaining the backend and maintenance services.
python3 tools/uninstall.py --keep-backend
```

Backups remain in `~/.local/state/icon-normalizer/backups/`. If recovery fails, keep the state files and managed directories, then follow the [acceptance and recovery guide](docs/CHECKLIST.md).

## Supported scope

- Tray and AppIndicator icons, and window icons drawn directly by applications or loaded from files, may bypass icon themes and cannot be normalized.
- Non-default `XDG_DATA_HOME` is currently unsupported and is rejected during installation checks.
- This release is available on GitHub for local installation and has not been submitted to GNOME Extensions. A GitHub release does not imply GNOME review approval.

## Documentation and contributions

The [documentation index](docs/README.md) organizes references by usage, development, and release tasks. Use [Issues](https://github.com/TengJoe/icon-normalizer-plugin/issues) to report problems or suggest improvements.

| Document | Contents |
| --- | --- |
| [Contribution guide](CONTRIBUTING.md) | Development checks, issue reports, and Chinese/English writing conventions |
| [Architecture](ARCHITECTURE.md) | Module responsibilities, process isolation, transactions, and data flow |
| [Protocol](PROTOCOL.md) | JSON requests, error codes, concurrency control, and wait budgets |
| [Release checklist](docs/CHECKLIST.md) | Automated checks, manual acceptance, and recovery procedures |
| [Changelog](CHANGELOG.md) | Version history; [v1.1.1 notes](docs/RELEASE-1.1.1.md) describe the first public release |

Technical references currently use Chinese; installation and usage guides are available in both languages.

## Author and support

Author: **[TengJoe](https://github.com/TengJoe)**. All features are available for free. Supporting development is voluntary, with no required amount.

Find the WeChat Pay and Alipay codes through the repository's **Sponsor** entry, the [support page](docs/SUPPORT.md), or **Maintenance → About and support**.

<details>
<summary>View WeChat Pay and Alipay payment codes</summary>

### WeChat Pay

<img src="extension/assets/support/wechat.png" alt="WeChat Pay payment QR code" width="280">

### Alipay

<img src="extension/assets/support/alipay.jpg" alt="Alipay payment QR code" width="280">

Scan with the corresponding payment app and verify the recipient and amount there. Payments are handled by WeChat Pay or Alipay; the extension does not read or verify transactions.

</details>
