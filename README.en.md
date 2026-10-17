<div align="center">

<img src="extension/icons/icon-normalizer-symbolic.svg" alt="Icon Normalizer project mark" width="56" height="56">

# Icon Normalizer

**Consistent icon coverage. Original design preserved.**

Icon normalization, custom profiles, and automatic maintenance for GNOME.

[![Release 1.1.4](https://img.shields.io/badge/release-1.1.4-3584e4?style=flat-square)](https://github.com/TengJoe/icon-normalizer-plugin/releases/tag/v1.1.4)
[![Verified GNOME Shell 51](https://img.shields.io/badge/GNOME_Shell-51-4a86cf?style=flat-square)](#compatibility-and-dependencies)
[![Chinese / English](https://img.shields.io/badge/UI-Chinese%20%2F%20English-2ec27e?style=flat-square)](README.md)
[![GPL-3.0-or-later](https://img.shields.io/badge/license-GPL--3.0--or--later-77767b?style=flat-square)](LICENSE)

[Download complete package](https://github.com/TengJoe/icon-normalizer-plugin/releases/download/v1.1.4/icon-normalizer-plugin-1.1.4.tar.gz) · [简体中文](README.md) · [Report an issue](https://github.com/TengJoe/icon-normalizer-plugin/issues) · [Support development](docs/SUPPORT.md)

</div>

---

[Preview](#preview) · [Features](#features) · [Quick start](#quick-start) · [Usage](#usage) · [Recovery and removal](#recovery-and-removal) · [Developer documentation](#developer-documentation)

## Preview

Icon Normalizer combines a GNOME Shell extension with a user-level Python backend. It adjusts application icon coverage, adds backplates to suitable bare glyphs, and maintains generated artwork when applications or icon themes change. Original system artwork stays read-only; generated files and recovery records live in your home directory.

![Actual Icon Normalizer previews: ChatGPT, Cursor, Discord, Telegram, Chrome, and Firefox on equal-sized canvases, plus four common features](docs/assets/icon-normalizer-overview-actual.png)

*Actual backend PNGs, without AI redrawing. Shown with the Standard preset: 88% target coverage, ±2 percentage points of tolerance, and 72% inner logo coverage.*

<details>
<summary>Why can circular and square icons still look different in size?</summary>

The current algorithm normalizes the **longest visible core edge relative to the canvas**. It does not guarantee equal perceptual area or visual weight across shapes. Internal padding in existing icon tiles is also preserved.

Both rows use equal-sized canvases. ChatGPT and Cursor grow; Discord and Firefox shrink. Telegram and Chrome are already within tolerance and stay unchanged. Application icons and trademarks belong to their respective owners; their inclusion does not imply endorsement.

</details>

## Features

<table>
<tr>
<td width="50%" valign="top"><strong>Icon normalization</strong><br>Adjust coverage, add backplates where appropriate, and generate nine sizes from 16 to 512 px.</td>
<td width="50%" valign="top"><strong>Custom profiles</strong><br>Tune target, tolerance, and inner logo settings; save up to 50 named profiles.</td>
</tr>
<tr>
<td valign="top"><strong>Per-app management</strong><br>Search, filter, compare previews, and skip individual icons.</td>
<td valign="top"><strong>Maintenance and theme following</strong><br>Detect launcher changes and retain settings and per-icon rules when changing source themes.</td>
</tr>
<tr>
<td valign="top"><strong>Adaptive bilingual interface</strong><br>Use wide or narrow windows and switch languages while keeping your page, search, and unsaved draft.</td>
<td valign="top"><strong>Health diagnostics and safe recovery</strong><br>Show backend faults with bilingual details; restore managed changes and stop before overwriting external edits.</td>
</tr>
</table>

## Quick start

**Use the complete package for a first installation.** The separate extension ZIP does not include the Python backend.

1. Confirm that you use **GNOME Shell 51**, and prepare the [runtime dependencies](#compatibility-and-dependencies) listed below.
2. Download the [complete package](https://github.com/TengJoe/icon-normalizer-plugin/releases/download/v1.1.4/icon-normalizer-plugin-1.1.4.tar.gz) and [SHA256SUMS](https://github.com/TengJoe/icon-normalizer-plugin/releases/download/v1.1.4/SHA256SUMS) into the same directory.
3. Run as your normal user. Confirm that verification reports `OK` before extracting and installing.

```bash
sha256sum --ignore-missing -c SHA256SUMS
# Confirm that verification above reports OK, then continue:
tar -xzf icon-normalizer-plugin-1.1.4.tar.gz
cd icon-normalizer-plugin
python3 tools/install.py
```

The installer checks dependencies, takes a snapshot, stages and validates files, replaces the code, and checks the backend. Failed upgrades restore the snapshot. Open **Icon Normalizer → Preferences** from your extensions manager to get started.

> Current public release: extension **1.1.4**, backend **3.1.3**. `main` may contain unreleased changes; see the [changelog](CHANGELOG.md) for version scope.

The local source candidate is extension **1.1.5** / backend **3.1.4**, with Yaru accent, GTK and explicit light-preference synchronization. It has not been published; see the [candidate notes](docs/RELEASE-1.1.5.md).

<details>
<summary>Install from source</summary>

```bash
git clone https://github.com/TengJoe/icon-normalizer-plugin.git
cd icon-normalizer-plugin
python3 tools/build.py
python3 tools/install.py
```

Build outputs live in `dist/`: the extension ZIP, complete source package, and `DIST_MANIFEST.json`. Development checks are in the [contribution guide](CONTRIBUTING.md).

</details>

<details>
<summary>Update only the extension frontend when the backend is already installed</summary>

The release asset `icon-normalizer@joeydeng.local.zip` contains only the frontend. Custom profiles and theme following require backend **3.1.0 or newer**; older backends display an upgrade hint.

The complete dark/light variant pairing, dependency diagnostics, conflict receipts, and health records in 1.1.4 require backend **3.1.3**. Use the complete package to upgrade both components.

ZIPs built from the current source omit `schemas/gschemas.compiled`. After manually installing a ZIP with `gnome-extensions install`, run:

```bash
glib-compile-schemas ~/.local/share/gnome-shell/extensions/icon-normalizer@joeydeng.local/schemas
```

The complete-package and source installers compile the schema automatically; this extra step is unnecessary with those installers.

</details>

After a top bar code upgrade, save your work and log out and back in to refresh GNOME Shell's module cache. Closing and reopening Preferences loads its updates. The installer does not end your desktop session.

## Usage

| Page | Common actions |
| --- | --- |
| **Rules** | Adjust settings, choose a preset or named profile, then use **Save only** or **Save and apply** |
| **App Icons** | Search, filter, compare original and proposed artwork, and manage per-icon skip rules |
| **Maintenance** | View status, check or apply icons, activate the theme, and configure maintenance, theme following, language, and the top bar button |

**Suggested flow: preview → adjust settings → save and apply.** The Standard preset is **88% / ±2 percentage points / 72%**, with output sizes of `16 / 24 / 32 / 48 / 64 / 96 / 128 / 256 / 512 px`.

<details>
<summary>When do custom profiles take effect?</summary>

**Save as custom profile** stores the current parameters. **Use profile** only fills the draft. **Save only** or **Save and apply** makes those parameters active. Named profiles are independent of the icon theme.

</details>

<details>
<summary>What happens when I change themes, install apps, or close Preferences?</summary>

**Maintenance → Follow icon theme** is enabled by default. With automatic maintenance also enabled, selecting another installed source theme regenerates `DockNormalized` while keeping settings and per-icon rules. The latest source theme becomes the restore target. Failed migrations restore the previous icons, configuration, and recovery records.

Changing the GTK or GNOME Shell appearance theme keeps your visual settings. Selecting the current source theme does not force overlay activation; choose **Apply and activate** to enable the normalized theme again.

User-level `path` monitoring detects launcher changes; a `timer` checks every minute as a fallback. Completion time depends on the events and number of icons. Closing Preferences or locking the screen does not stop maintenance.

</details>

<details>
<summary>Where are language settings and the top bar entry?</summary>

In **Maintenance → Interface language**, choose **Follow system**, **简体中文**, or **English**. The top bar and Preferences share this setting and update immediately.

The top bar button is disabled by default. Enable **Maintenance → Show top bar icon** to view status, check or apply icons, and open Preferences through the symbolic panel icon.

</details>

## Compatibility and dependencies

Support is declared only for **GNOME Shell 51**, verified by runtime acceptance tests. Other versions need separate validation. The installer checks dependencies; install missing distribution packages separately.

| Purpose | Dependencies |
| --- | --- |
| Preferences | GJS, GTK 4, Libadwaita, and their GI typelibs |
| Image processing | Python 3.10+, Python GI, GTK 3, GdkPixbuf, Pillow, NumPy |
| Installation and maintenance | A systemd user session, `gtk-update-icon-cache`, `glib-compile-schemas` |

The GTK 3 backend and GTK 4 preferences run in separate processes.

- Tray and AppIndicator icons, and window icons drawn directly by apps or loaded from files, may bypass icon themes.
- Non-default `XDG_DATA_HOME` is currently unsupported and is rejected during installation checks.
- GitHub availability and local installation do not imply GNOME store approval; see the [submission scope](docs/SUBMISSION.md).

## Recovery and removal

In **Maintenance → Restore desktop icons**, select **Restore** and confirm to restore managed changes and the latest source theme. Managed launchers without external edits are restored byte for byte. Conflicts preserve external edits and report failure.

Run from the complete package or source directory:

```bash
# Restore managed changes, then remove the extension and backend.
python3 tools/uninstall.py

# Remove only the extension, keeping the backend and maintenance.
python3 tools/uninstall.py --keep-backend
```

Backups remain in `~/.local/state/icon-normalizer/backups/`. If recovery fails, retain state files and managed directories, then follow the [acceptance and recovery guide](docs/CHECKLIST.md).

## Developer documentation

| Document | Contents |
| --- | --- |
| [Contribution guide](CONTRIBUTING.md) | Development checks, issue reporting, and bilingual writing conventions |
| [Architecture](ARCHITECTURE.md) | Modules, process isolation, transactions, and data flow |
| [Protocol](PROTOCOL.md) | JSON requests, error codes, and concurrency control |
| [Release checklist](docs/CHECKLIST.md) | Automated checks, desktop acceptance, and recovery procedures |
| [Changelog](CHANGELOG.md) | Unreleased changes and version history; [v1.1.4 notes](docs/RELEASE-1.1.4.md) |

See the [documentation index](docs/README.md) for more references. When reporting a problem, include system and component versions and reproduction steps, and remove private information from logs and screenshots first. Technical references currently use Chinese; installation and usage guides are available in both languages.

## Author and support

Developed by **[TengJoe](https://github.com/TengJoe)** under [GPL-3.0-or-later](LICENSE). All features are free to use; supporting development is voluntary.

[Report a problem](https://github.com/TengJoe/icon-normalizer-plugin/issues) · [Contribute](CONTRIBUTING.md) · [Support development](docs/SUPPORT.md)

<details>
<summary>WeChat Pay and Alipay support</summary>

Find the codes through the repository's Sponsor button, the [support page](docs/SUPPORT.md), or **Maintenance → About and support**.

**WeChat Pay**

<img src="extension/assets/support/wechat.png" alt="WeChat Pay support code" width="240">

**Alipay**

<img src="extension/assets/support/alipay.jpg" alt="Alipay support code" width="240">

Scan with the corresponding payment app and verify the recipient and amount there. Payments are handled by WeChat Pay or Alipay; the extension does not read or verify transactions.

</details>
