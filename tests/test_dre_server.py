"""Focused regression coverage for the single-process DRE API."""

from __future__ import annotations

import asyncio
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace


TEST_STATE_DIR = tempfile.TemporaryDirectory()
os.environ["DRE_STATE_DB_PATH"] = str(Path(TEST_STATE_DIR.name) / "state.sqlite3")
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "artifacts" / "api-server"))

import fastapi_app as dre  # noqa: E402


class DreServerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        dre.initialize_database()

    def test_shell_history_selects_newest_records_but_displays_chronologically(self) -> None:
        session_id = "history-ordering-session"
        with dre.database_connection() as connection:
            for index in range(3):
                connection.execute(
                    """
                    INSERT INTO shell_events
                    (id, session_id, origin, command, status, output, exit_code, created_at, completed_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        f"history-{index}",
                        session_id,
                        "user",
                        f"command-{index}",
                        "completed",
                        "",
                        0,
                        f"2026-01-01T00:00:0{index}+00:00",
                        f"2026-01-01T00:00:0{index}+00:00",
                    ),
                )

        records = dre.get_shell_history(session_id, limit=2)

        self.assertEqual([record.command for record in records], ["command-1", "command-2"])
        self.assertEqual(dre.get_shell_history(session_id, limit=1)[0].command, "command-2")

    def test_activity_hub_only_delivers_events_to_its_session(self) -> None:
        async def verify() -> None:
            hub = dre.ActivityHub()
            async with hub.subscribe("session-a") as session_a, hub.subscribe("session-b") as session_b:
                await hub.publish({"type": "agent", "sessionId": "session-a", "status": "thinking"})
                self.assertEqual((await asyncio.wait_for(session_a.get(), timeout=0.1))["sessionId"], "session-a")
                with self.assertRaises(asyncio.TimeoutError):
                    await asyncio.wait_for(session_b.get(), timeout=0.05)

        asyncio.run(verify())

    def test_guarded_mode_excludes_code_executables_but_retains_diagnostics(self) -> None:
        original_setting = dre.settings.allow_shell_execution
        dre.settings.allow_shell_execution = False
        try:
            self.assertTrue(dre.is_guarded_command("pwd")[0])
            self.assertFalse(dre.is_guarded_command("python -c 'print(1)'")[0])
            self.assertFalse(dre.is_guarded_command("node -e 'console.log(1)'")[0])
        finally:
            dre.settings.allow_shell_execution = original_setting

    def test_tool_continuation_preserves_instructions_and_tools(self) -> None:
        requests: list[dict[str, object]] = []
        original_client = dre.get_openai_client
        original_stream = dre.stream_openai_response
        original_run_shell = dre.run_shell_command

        async def fake_stream(_client: object, request: dict[str, object], answer_parts: list[str]):
            requests.append(request)
            if len(requests) == 1:
                call = SimpleNamespace(
                    arguments=json.dumps({"command": "pwd", "reason": "Confirm the current directory."}),
                    call_id="call-1",
                )
                yield None, SimpleNamespace(id="response-1", output_text=""), [call]
            else:
                answer_parts.append("The directory check completed.")
                yield "The directory check completed.", SimpleNamespace(
                    id="response-2",
                    output_text="The directory check completed.",
                ), []

        async def fake_run_shell(session_id: str, origin: str, command: str) -> dre.ShellEvent:
            return dre.ShellEvent(
                id="tool-event",
                sessionId=session_id,
                origin=origin,
                command=command,
                status="completed",
                output="/workspace",
                exitCode=0,
                createdAt="2026-01-01T00:00:00+00:00",
                completedAt="2026-01-01T00:00:00+00:00",
            )

        dre.get_openai_client = lambda: object()
        dre.stream_openai_response = fake_stream
        dre.run_shell_command = fake_run_shell
        try:
            message = dre.AgentMessageInput(
                content="Where am I?",
                sessionId="continuation-session",
                executeCommands=True,
            )
            asyncio.run(self._consume_stream(message))
        finally:
            dre.get_openai_client = original_client
            dre.stream_openai_response = original_stream
            dre.run_shell_command = original_run_shell

        self.assertEqual(len(requests), 2)
        self.assertEqual(requests[1]["instructions"], dre.SYSTEM_INSTRUCTIONS)
        self.assertEqual(requests[1]["tools"], requests[0]["tools"])

    @staticmethod
    async def _consume_stream(message: dre.AgentMessageInput) -> None:
        async for _ in dre.agent_event_stream(message):
            pass

    def test_legacy_compatibility_routes_remain_registered(self) -> None:
        paths = {getattr(route, "path", "") for route in dre.app.routes}
        self.assertTrue({"/health", "/ask"}.issubset(paths))


if __name__ == "__main__":
    unittest.main()