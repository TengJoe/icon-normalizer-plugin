# GNOME Extensions submission notes

Current local candidate: extension **1.1.7**, companion backend **3.1.5**, verified **GNOME Shell 51**. These notes describe the review boundary and preparation steps. GitHub publication does not determine the status of an existing GNOME Extensions submission or claim approval.

[Published release v1.1.5](https://github.com/TengJoe/icon-normalizer-plugin/releases/tag/v1.1.5) · [Contribution guide](../CONTRIBUTING.md) · [Release checklist](CHECKLIST.md)

## Package boundary

The extension ZIP contains readable GJS, symbolic SVG, CSS, metadata, the GPLv3 license, GSettings schema XML,. It intentionally omits the compiled `schemas/gschemas.compiled` (review rule EGO-P-006); the extensions website compiles the schema during upload, and `tools/install.py` compiles it for local source installs. It contains no Python code, executables, shared libraries, package installers, downloads, telemetry, or clipboard integration.

The extension controls a **separately installed user-level companion backend**. The complete release tarball contains the backend source and installer. A ZIP-only installation shows a missing-backend message until the companion is installed manually.

For the published release, follow the [installation guide](../README.en.md). When preparing a candidate from source, run from the project root:

```bash
python3 tools/build.py
python3 tools/install.py
```

The Python backend requires Python 3.10 or newer, Python GI, GTK 3, GdkPixbuf, Pillow, NumPy, systemd user services, `gtk-update-icon-cache`, and `glib-compile-schemas`. Preferences use GTK 4 and Libadwaita in a separate GJS process. Installation runs as the current user; missing distribution packages are installed separately. The extension does not invoke `sudo` or install dependencies.

## Processes and lifecycle

External processes isolate GTK 3/Python image processing from the Shell and GTK 4 preferences. Commands use fixed argument arrays and JSON on standard input. Read requests can be cancelled. Interrupted writes finish safely and are reaped; disabling the extension removes its timers, listeners, and UI callbacks.

The companion's timer and path units are explicitly installed and operate independently of the panel. Their state and controls are shown in Maintenance. Preferences and the top bar button can be closed without stopping automatic maintenance.

Explain this companion architecture to the reviewer. The [official review guidelines](https://gjs.guide/extensions/review-guidelines/review-guidelines.html) discourage external processes; reviewers assess whether an exception is appropriate.

## Maintainership

This project uses AI-assisted code generation and refactoring. These checks do not establish the submitter's ability to explain, debug, and maintain JavaScript. The maintainer must personally review the code and satisfy EGO's maintainership requirements before a new submission. The independently installed Python companion remains subject to reviewer assessment. No approval is claimed.

## Submission checks

Build the candidate, complete the relevant [acceptance checks](CHECKLIST.md), then run:

```bash
python3 tools/privacy_audit.py
python3 tools/release_audit.py --archive dist/icon-normalizer@joeydeng.local.zip
python3 tools/release_audit.py --submission --archive dist/icon-normalizer@joeydeng.local.zip
```

Local checks cover entry-point toolkit isolation, source-only ZIP contents, source/archive equality, license, versions, schemas, and the tested Shell declaration. The builder runs local source checks before creating artifacts. The public URL must also be verified separately: a URL-format check does not prove accessibility.

Source and issues are available at the [GitHub repository](https://github.com/TengJoe/icon-normalizer-plugin). The complete companion package is available in [Published release v1.1.5](https://github.com/TengJoe/icon-normalizer-plugin/releases/tag/v1.1.5). Submit the extension ZIP to GNOME Extensions; the full tarball is a separate companion distribution.

GNOME Extensions assigns its own numeric extension version. Keep `version-name` as the human-readable release version and preserve the UUID for upgrades. GNOME Shell caches ESM modules, so panel updates require a new login session; Preferences can be closed and reopened. The installer does not end the session.

## Manual acceptance

- Check the panel icon, menu, disable/enable, and lock/unlock in a fresh GNOME Shell 51 session.
- Install the ZIP without the companion and verify the missing-backend message.
- Check both languages, narrow and wide windows, and profile save/use/rename/delete.
- With theme following and automatic maintenance enabled, select another installed icon theme and verify retained settings and the new source theme.
- Disable automatic maintenance or theme following and verify that background theme migration stops.
- Restore in a disposable acceptance account and verify the latest selected source theme.
- Check author attribution, project and issue links; no donations or payment images are included.

Record isolated Shell/GTK checks separately from observations in the user's desktop. Compilation and mocks cannot establish lock/unlock behavior or a reviewer decision.

See the official [extension anatomy](https://gjs.guide/extensions/overview/anatomy.html) for metadata details.
