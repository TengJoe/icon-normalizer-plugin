# GNOME Extensions submission preparation

Candidate: frontend 1.1.1, companion backend 3.1.0. Runtime support in this
candidate is GNOME Shell 51 only. Earlier versions need their own acceptance run.

## Review boundary and installation

The extension ZIP contains readable GJS, symbolic SVG, CSS, metadata, GPLv3
license, GSettings schemas, and two maintainer-authorized payment-code images.
It contains no Python code, executables, shared
libraries, package installers, downloads, telemetry or clipboard integration.

The extension controls a **separately installed user-level companion backend**.
The complete release tarball includes backend source and installer. A ZIP-only
installation displays the missing-backend message until the companion is
installed manually. On a supported system, install the full release with:

```sh
python3 tools/build.py
python3 tools/install.py
```

Python 3.10+, Python GI/GTK 3/GdkPixbuf, Pillow, numpy, systemd user services,
gtk-update-icon-cache and glib-compile-schemas are needed. GTK 4 and Libadwaita
belong only to preferences. Runtime/backend installation uses the current user;
installing missing distribution packages is a separate administrator action.
The extension never invokes sudo or installs dependencies itself.

External processes are necessary to isolate GTK 3/Python image rendering from
GTK 4 preferences and the Shell. Commands use fixed argv and JSON stdin. Read
requests can be cancelled; interrupted writes are allowed to finish safely and
are reaped, while extension timers and UI callbacks are detached on disable.
Background timer/path units were explicitly installed and remain independent of
panel enable/disable. Their state and controls are visible in Maintenance.

This companion architecture must be explained to the reviewer. It is **not a
guarantee of approval**: external processes are discouraged by the published
review rules and exceptions are considered by reviewers.

## Submission gates

```sh
python3 tools/release_audit.py --archive dist/icon-normalizer@joeydeng.local.zip
python3 tools/release_audit.py --submission --archive dist/icon-normalizer@joeydeng.local.zip
```

Local gates cover entry-point toolkit isolation, source-only ZIP contents,
source/archive equality, SPDX-compatible license, version, schemas and the tested
Shell declaration. The builder runs local source gates before making artifacts.

Source and issue tracker: [https://github.com/TengJoe/icon-normalizer-plugin](https://github.com/TengJoe/icon-normalizer-plugin).
`metadata.json` contains this project URL. The repository must be publicly
accessible before an EGO submission; a private staging repository does not meet
that requirement. Rebuild, rerun acceptance and the submission gate after changes.
Publish the full source and companion release there. Do not upload the full tarball
as the GNOME extension ZIP. No store submission has been made.

The EGO service assigns its own numeric extension version. Preserve version-name
as the release's human-readable version, and keep the current UUID for upgrades.
Shell caches ESM modules: user-session top bar updates still need logout/login;
preferences can be closed and reopened. No installer ends the user's session.

## Final manual checks

- Fresh GNOME 51 session: panel icon, menu, disable/enable, lock/unlock.
- Install ZIP without companion: readable missing-backend state.
- Both languages, narrow and wide windows, profile save/use/rename/delete.
- With follow and automatic maintenance on, switch an installed icon theme;
  confirm retained parameters and the latest source in Maintenance.
- Turn automatic maintenance or theme follow off; confirm no background migration.
- Restore in a disposable acceptance account and confirm the latest source theme.

Local test reports distinguish isolated real Shell/GTK checks from observations
in the user's existing session. Lock/unlock and an EGO reviewer decision must not
be marked passed based on mocks or compilation alone.

References: [official review guidelines](https://gjs.guide/extensions/review-guidelines/review-guidelines.html)
and [metadata/extension anatomy](https://gjs.guide/extensions/overview/anatomy.html).
