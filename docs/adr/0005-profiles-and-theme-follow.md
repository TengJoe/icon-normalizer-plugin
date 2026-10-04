# ADR-0005 — Named profiles and source-theme migration

Status: accepted for frontend 1.1 / backend 3.1, 2026-10-04.

Profiles hold only three visual parameters. Selecting a profile fills the draft;
explicit Save controls active policy. A separate catalog hash provides optimistic
concurrency control without changing the policy revision. Backend-only writes,
private permissions, validated names and a 50-profile limit bound persistence.

Theme following is a backend preference, default on. It requires automatic
maintenance for background migration. A newly selected, installed icon theme
becomes the source; existing visual parameters and per-icon rules survive.
Choosing the restore source itself is treated as an explicit deactivation.

Migration commits icons, config, baseline and manifest in one journaled
transaction. The baseline tracks the latest selected source so Restore follows
the user's latest theme choice. Rendering may take time, so activation checks the
current theme and writes a guarded activation log. A newer selection is never
replaced by a stale activation. The scheduled worker rechecks changes and works
without the preferences window or panel; a debounced Shell listener accelerates it.

The v1 envelope and the original nine operations stay compatible. Five new
operations and one optional status field are additive. The normalization math,
size ladder and CORE_VERSION remain unchanged.
