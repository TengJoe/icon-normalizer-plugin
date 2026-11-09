"""The Python write path must yield to the in-process (GJS) engine."""
import json
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

from harness import Sandbox, make_desktop, BACKEND_DIR
sys.path.insert(0, str(BACKEND_DIR))
from icon_normalizer import renderer_owner
from icon_normalizer.errors import ProtocolError


class RendererOwnership(unittest.TestCase):
    def setUp(self):
        self.box = Sandbox()
        self.addCleanup(self.box.close)
        self.box.base_icon("fixture-owned", 200)
        make_desktop(self.box.system_apps / "one.desktop", "Owned", "fixture-owned")

    def call(self, op, args=None):
        rc, response = self.box.call_cli(op, args)
        return rc, response

    def revision(self):
        rc, response = self.call("status")
        self.assertEqual(rc, 0, response)
        return response["result"]["revision"]

    def apply(self):
        return self.call("apply", {"expected_revision": self.revision(), "activate": False})

    def test_scan_still_works_while_owned(self) -> None:
        renderer_owner.claim(self.box.state, renderer_owner.GJS_OWNER)
        rc, response = self.call("scan")
        self.assertEqual(rc, 0, response)

    def test_apply_is_refused_while_owned(self) -> None:
        renderer_owner.claim(self.box.state, renderer_owner.GJS_OWNER)
        rc, response = self.apply()
        self.assertNotEqual(rc, 0)
        self.assertEqual(response["error"]["code"], "RENDERER_OWNED")
        self.assertEqual(response["error"]["details"]["owner"], "gjs")
        self.assertFalse(response["error"]["retryable"])

    def test_apply_is_refused_for_revert_too(self) -> None:
        renderer_owner.claim(self.box.state, renderer_owner.GJS_OWNER)
        rc, response = self.call("revert")
        self.assertNotEqual(rc, 0)
        self.assertEqual(response["error"]["code"], "RENDERER_OWNED")

    def test_override_allows_a_deliberate_repair(self) -> None:
        renderer_owner.claim(self.box.state, renderer_owner.GJS_OWNER)
        # The CLI runs in a child process, so the override has to be in the
        # environment the sandbox hands to it, not in os.environ.
        base = self.box.env
        self.box.env = lambda: {**base(), renderer_owner.ALLOW_ENV: "1"}
        rc, response = self.apply()
        self.assertEqual(rc, 0, response)

    def test_python_owned_state_is_unaffected(self) -> None:
        renderer_owner.claim(self.box.state, "python")
        rc, response = self.apply()
        self.assertEqual(rc, 0, response)

    def test_marker_round_trips(self) -> None:
        self.assertIsNone(renderer_owner.owner(self.box.state))
        renderer_owner.claim(self.box.state, renderer_owner.GJS_OWNER)
        self.assertEqual(renderer_owner.owner(self.box.state), "gjs")
        document = json.loads((Path(self.box.state) / renderer_owner.MARKER_NAME).read_text())
        self.assertEqual(document["schema_version"], 1)


if __name__ == "__main__":
    unittest.main()
