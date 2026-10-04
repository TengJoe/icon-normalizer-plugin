"""Single source of truth for every version marker shipped by the backend."""

BACKEND_VERSION = "3.1.0"
API_VERSION = 1

#: Bumped whenever the analyzer/renderer math or PNG encoding changes, so the
#: preview cache stops serving renders from a different pipeline.
CORE_VERSION = "2"
