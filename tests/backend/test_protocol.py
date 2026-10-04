"""v1 wire protocol parsing and envelope tests."""
from __future__ import annotations

import io
import json
import sys
import unittest
from contextlib import redirect_stdout
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "backend"))

from icon_normalizer import protocol as P  # noqa: E402
from icon_normalizer.errors import ProtocolError  # noqa: E402

HEX = "a" * 64


def envelope_for(operation: str, arguments: dict) -> dict:
    return {
        "api_version": 1,
        "request_id": "test-proto",
        "operation": operation,
        "arguments": arguments,
    }


class TestRequestParsing(unittest.TestCase):
    def _err(self, payload: object) -> ProtocolError:
        raw = json.dumps(payload).encode() if not isinstance(payload, bytes) else payload
        with self.assertRaises(ProtocolError) as ctx:
            P.parse_request(raw)
        return ctx.exception

    def test_unknown_field_rejected(self) -> None:
        err = self._err({**envelope_for("scan", {}), "extra": 1})
        self.assertEqual(err.code, "INVALID_REQUEST")
        self.assertEqual(err.exit_code, 2)

    def test_unknown_argument_field_rejected(self) -> None:
        with self.assertRaises(ProtocolError) as ctx:
            P.validate("scan", {"bogus": 1})
        self.assertEqual(ctx.exception.code, "INVALID_REQUEST")
        err = self._err({**envelope_for("scan", {}), "extra": 1})
        self.assertEqual(err.code, "INVALID_REQUEST")

    def test_bool_and_nonfinite_rejected(self) -> None:
        with self.assertRaises(ProtocolError):
            P.parse_patch({"target": True})
        with self.assertRaises(ProtocolError) as ctx:
            P.parse_request(b'{"api_version":1,"request_id":"x","operation":"configure",'
                            b'"arguments":{"expected_revision":"' + HEX.encode() +
                            b'","patch":{"target":NaN}}}')
        self.assertIn("non-finite", ctx.exception.message)

    def test_infinity_rejected(self) -> None:
        with self.assertRaises(ProtocolError):
            P.parse_request(b'{"api_version":1,"request_id":"x","operation":"configure",'
                            b'"arguments":{"expected_revision":"' + HEX.encode() +
                            b'","patch":{"target":Infinity}}}')

    def test_cross_constraint(self) -> None:
        with self.assertRaises(ProtocolError) as ctx:
            P.parse_patch({"target": 0.6, "deadband": 0.5})
        self.assertEqual(ctx.exception.code, "INVALID_CONFIG")

    def test_unknown_version(self) -> None:
        err = self._err({**envelope_for("scan", {}), "api_version": 99})
        self.assertEqual(err.code, "UNSUPPORTED_VERSION")

    def test_trailing_garbage(self) -> None:
        err = self._err(json.dumps(envelope_for("scan", {})).encode() + b" garbage")
        self.assertEqual(err.code, "INVALID_REQUEST")

    def test_request_id_rules(self) -> None:
        bad = {**envelope_for("scan", {}), "request_id": "bad id!"}
        self.assertEqual(self._err(bad).code, "INVALID_REQUEST")
        ok = P.parse_request(json.dumps(envelope_for("scan", {})).encode())
        self.assertEqual(ok[1], "test-proto")

    def test_request_too_large(self) -> None:
        err = self._err(b'{"pad":"' + b"x" * (P.MAX_STDIN + 10) + b'"}')
        self.assertEqual(err.code, "INVALID_REQUEST")
        self.assertIn("64 KiB", err.message)

    def test_patch_min_fields(self) -> None:
        with self.assertRaises(ProtocolError):
            P.parse_patch({})
        self.assertEqual(P.parse_patch({"inner": 0.8}), {"inner": 0.8})

    def test_rules_shape(self) -> None:
        parsed = P.parse_rules({
            "expected_revision": HEX, "icon_id": HEX,
            "rule": {"skip": True, "classification": "auto"},
        })
        self.assertEqual(parsed["rule"]["classification"], "auto")
        with self.assertRaises(ProtocolError):
            P.parse_rules({
                "expected_revision": HEX, "icon_id": HEX,
                "rule": {"skip": True, "classification": "auto", "source_sha256": HEX},
            })
        with self.assertRaises(ProtocolError):
            P.parse_rules({
                "expected_revision": HEX, "icon_id": HEX,
                "rule": {"skip": True, "classification": "glyph"},
            })
        parsed = P.parse_rules({
            "expected_revision": HEX, "icon_id": HEX,
            "rule": {"skip": False, "classification": "glyph", "source_sha256": HEX},
        })
        self.assertEqual(parsed["rule"]["source_sha256"], HEX)
        parsed = P.parse_rules({"expected_revision": HEX, "icon_id": HEX, "rule": {"reset": True}})
        self.assertEqual(parsed["rule"], {"reset": True})

    def test_preview_size_enum(self) -> None:
        with self.assertRaises(ProtocolError):
            P.parse_preview({"icon_id": HEX, "source_sha256": HEX, "size": 100})
        parsed = P.parse_preview({"icon_id": HEX, "source_sha256": HEX, "size": 48})
        self.assertEqual(parsed["size"], 48)

    def test_validate_empty_ops(self) -> None:
        for op in ("status", "doctor", "scan", "revert"):
            self.assertEqual(P.validate(op, {}), {})
            with self.assertRaises(ProtocolError):
                P.validate(op, {"x": 1})

    def test_envelope_shape(self) -> None:
        ok = P.response_ok("rid", "scan", {"k": 1})
        self.assertEqual(ok["warnings"], [])
        self.assertTrue(ok["ok"])
        err = P.response_err(ProtocolError("BUSY", "m", request_id="rid", operation="scan"))
        self.assertFalse(err["ok"])
        self.assertTrue(err["error"]["retryable"])
        self.assertEqual(err["error"]["code"], "BUSY")

    def test_emit_enforces_limit(self) -> None:
        old = P.MAX_STDOUT
        P.MAX_STDOUT = 10
        try:
            buf = io.StringIO()
            with redirect_stdout(buf):
                P.emit(P.response_ok("rid", "scan", {"big": "x" * 100}))
            payload = json.loads(buf.getvalue())
            self.assertEqual(payload["error"]["code"], "IO_ERROR")
        finally:
            P.MAX_STDOUT = old

    def test_exit_code_mapping(self) -> None:
        from icon_normalizer.errors import exit_code_for

        self.assertEqual(exit_code_for("BUSY"), 3)
        self.assertEqual(exit_code_for("REVISION_CONFLICT"), 3)
        self.assertEqual(exit_code_for("INVALID_REQUEST"), 2)
        self.assertEqual(exit_code_for("NOT_INSTALLED"), 4)
        self.assertEqual(exit_code_for("RECOVERY_REQUIRED"), 5)
        self.assertEqual(exit_code_for("INTERNAL_ERROR"), 1)

    def test_unknown_code_defaults_retryable(self) -> None:
        from icon_normalizer.errors import is_retryable

        self.assertTrue(is_retryable("SOME_FUTURE_CODE"))
        self.assertFalse(is_retryable("IO_ERROR"))


if __name__ == "__main__":
    unittest.main()
