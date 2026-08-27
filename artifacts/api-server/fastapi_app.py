"""Single-process DRE Server Copilot application.

FastAPI serves the production React build and provides the authenticated DRE
chat, SQLite history, guarded shell execution, and activity event stream.
"""

from __future__ import annotations

import asyncio
import hmac
import importlib.util
import json
import logging
import os
import re
import shlex
import sqlite3
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal
from uuid import uuid4

from fastapi import Depends, FastAPI, Header, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from openai import AsyncOpenAI
from pydantic import BaseModel, Field, model_validator


logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))
logger = logging.getLogger("dre-copilot")
APP_STARTED_AT = time.monotonic()


class Settings:
    port = int(os.getenv("PORT", "8000"))
    openai_api_key = os.getenv("OPENAI_API_KEY") or os.getenv("AI_INTEGRATIONS_OPENAI_API_KEY")
    openai_base_url = os.getenv("OPENAI_BASE_URL") or os.getenv("AI_INTEGRATIONS_OPENAI_BASE_URL")
    # RunPod/OpenAI deployments default to gpt-5.6. Replit's integration proxy
    # uses its provisioned model name when OPENAI_MODEL is not supplied.
    openai_model = os.getenv("OPENAI_MODEL") or (
        "gpt-5.6-terra" if os.getenv("AI_INTEGRATIONS_OPENAI_API_KEY") else "gpt-5.6"
    )
    agent_token = os.getenv("DRE_AGENT_TOKEN", "")
    allow_shell_execution = os.getenv("DRE_ALLOW_SHELL_EXECUTION", "false").lower() == "true"
    db_path = Path(os.getenv("DRE_STATE_DB_PATH", "/workspace/dre-copilot/state.sqlite3"))
    history_max_messages = int(os.getenv("DRE_HISTORY_MAX_MESSAGES", "40"))
    history_max_chars = int(os.getenv("DRE_HISTORY_MAX_CHARS", "30000"))
    shell_timeout_seconds = int(os.getenv("DRE_SHELL_TIMEOUT_SECONDS", "30"))
    shell_max_output_chars = int(os.getenv("DRE_SHELL_MAX_OUTPUT_CHARS", "20000"))


settings = Settings()
FRONTEND_DIST = Path(os.getenv("DRE_FRONTEND_DIST", Path(__file__).parent / "frontend-dist"))
SENSITIVE_PATH_FRAGMENT = re.compile(
    r"(^|/)(?:\.env(?:\.|$)|\.ssh|id_rsa|shadow|passwd|environ)(/|$)", re.IGNORECASE
)
SHELL_METACHARACTER = re.compile(r"[|&;<>()`$\\\n\r]")
HARD_BLOCKED_PATTERN = re.compile(
    r"(?:\brm\b|\bmkfs\b|\bshutdown\b|\breboot\b|\bpoweroff\b|\bhalt\b|"
    r"\binit\s+[06]\b|:\s*\(\s*\)\s*\{|\bdd\b.*\bof=/dev/)",
    re.IGNORECASE,
)
GUARDED_PROGRAMS = {
    "pwd",
    "whoami",
    "uptime",
    "uname",
    "date",
    "ls",
    "cat",
    "head",
    "tail",
    "grep",
    "ps",
    "df",
    "free",
    "git",
}
SYSTEM_INSTRUCTIONS = """You are DRE, a careful server copilot for one Linux
server. Be concise and factual. Use the shell tool only when it materially
helps answer the request. Shell actions are audited and may be blocked. Never
claim a command ran unless the corresponding tool result says it completed.
Explain the result in clear language for a phone user."""

TINYMEMORY_LOADER_PATH = Path("/opt/dre-memory/load_memory.py")
TINYMEMORY_ROOT = Path("/var/lib/dre-memory")


def load_tiny_memory_context() -> str:
    """Load trusted TinyMemory text without executing any memory content."""
    try:
        spec = importlib.util.spec_from_file_location("dre_tinymemory_loader", TINYMEMORY_LOADER_PATH)
        if spec is None or spec.loader is None:
            raise RuntimeError("could not create TinyMemory loader specification")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        memory = module.load_memory(TINYMEMORY_ROOT)
        if not isinstance(memory, str):
            raise TypeError("TinyMemory loader returned non-text content")
        return memory.strip()
    except Exception:
        logger.exception("TinyMemory loader failed; continuing without supplemental context")
        return ""


def request_instructions() -> str:
    """Append request-time TinyMemory context while leaving prompts untouched."""
    memory = load_tiny_memory_context()
    if not memory:
        return SYSTEM_INSTRUCTIONS
    return f"{SYSTEM_INSTRUCTIONS}\n\nTinyMemory context:\n{memory}"


class AgentMessageInput(BaseModel):
    content: str = Field(min_length=1, max_length=10000)
    sessionId: str = Field(min_length=8, max_length=128)
    executeCommands: bool = False


class TerminalCommandInput(BaseModel):
    command: str = Field(min_length=1, max_length=4000)
    sessionId: str = Field(min_length=8, max_length=128)


class NewSessionResponse(BaseModel):
    sessionId: str


class AgentMessage(BaseModel):
    id: str
    role: Literal["user", "assistant", "system"]
    content: str
    createdAt: str


class ShellEvent(BaseModel):
    id: str
    sessionId: str
    origin: Literal["user", "ai", "system"]
    command: str
    status: Literal["running", "completed", "blocked", "error"]
    output: str
    exitCode: int | None
    createdAt: str
    completedAt: str | None


class TerminalState(BaseModel):
    output: str
    lastCommand: str | None
    status: Literal["ready", "running", "success", "error"]
    updatedAt: str


class ActivityHub:
    """In-process pub/sub for SSE; SQLite remains the reconnect source of truth."""

    def __init__(self) -> None:
        self._queues: dict[asyncio.Queue[dict[str, Any]], str] = {}

    async def publish(self, event: dict[str, Any]) -> None:
        event_session_id = event.get("sessionId") or event.get("event", {}).get("sessionId")
        for queue, session_id in list(self._queues.items()):
            if event_session_id != session_id:
                continue
            try:
                queue.put_nowait(event)
            except asyncio.QueueFull:
                pass

    @asynccontextmanager
    async def subscribe(self, session_id: str) -> AsyncIterator[asyncio.Queue[dict[str, Any]]]:
        queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=100)
        self._queues[queue] = session_id
        try:
            yield queue
        finally:
            self._queues.pop(queue, None)


activity_hub = ActivityHub()
database_ready = False
database_error: str | None = None


def now_iso() -> str:
    return datetime.now(UTC).isoformat()


def make_event(event: dict[str, Any]) -> str:
    return f"data: {json.dumps(event, separators=(',', ':'))}\n\n"


def database_connection() -> sqlite3.Connection:
    if not database_ready:
        raise HTTPException(status_code=503, detail="SQLite state is unavailable.")
    connection = sqlite3.connect(settings.db_path)
    connection.row_factory = sqlite3.Row
    return connection


def initialize_database() -> None:
    global database_ready, database_error
    try:
        settings.db_path.parent.mkdir(parents=True, exist_ok=True)
        with sqlite3.connect(settings.db_path) as connection:
            connection.executescript(
                """
                PRAGMA journal_mode=WAL;
                CREATE TABLE IF NOT EXISTS chat_messages (
                    id TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL,
                    role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
                    content TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_chat_session_created
                    ON chat_messages(session_id, created_at);
                CREATE TABLE IF NOT EXISTS shell_events (
                    id TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL,
                    origin TEXT NOT NULL CHECK(origin IN ('user', 'ai', 'system')),
                    command TEXT NOT NULL,
                    status TEXT NOT NULL CHECK(status IN ('running', 'completed', 'blocked', 'error')),
                    output TEXT NOT NULL DEFAULT '',
                    exit_code INTEGER,
                    created_at TEXT NOT NULL,
                    completed_at TEXT
                );
                CREATE INDEX IF NOT EXISTS idx_shell_session_created
                    ON shell_events(session_id, created_at);
                """
            )
        database_ready, database_error = True, None
    except (OSError, sqlite3.Error) as error:
        database_ready, database_error = False, str(error)
        logger.exception("Could not initialize SQLite state")


def save_message(session_id: str, role: Literal["user", "assistant", "system"], content: str) -> AgentMessage:
    message = AgentMessage(id=str(uuid4()), role=role, content=content, createdAt=now_iso())
    with database_connection() as connection:
        connection.execute(
            "INSERT INTO chat_messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)",
            (message.id, session_id, message.role, message.content, message.createdAt),
        )
    return message


def get_history(session_id: str) -> list[AgentMessage]:
    with database_connection() as connection:
        rows = connection.execute(
            """
            SELECT id, role, content, created_at
            FROM chat_messages
            WHERE session_id = ?
            ORDER BY created_at DESC
            LIMIT ?
            """,
            (session_id, settings.history_max_messages),
        ).fetchall()
    messages = [
        AgentMessage(id=row["id"], role=row["role"], content=row["content"], createdAt=row["created_at"])
        for row in reversed(rows)
    ]
    total = 0
    bounded: list[AgentMessage] = []
    for message in reversed(messages):
        total += len(message.content)
        if total > settings.history_max_chars:
            break
        bounded.append(message)
    return list(reversed(bounded))


def create_shell_event(session_id: str, origin: Literal["user", "ai", "system"], command: str) -> ShellEvent:
    event = ShellEvent(
        id=str(uuid4()),
        sessionId=session_id,
        origin=origin,
        command=command,
        status="running",
        output="",
        exitCode=None,
        createdAt=now_iso(),
        completedAt=None,
    )
    with database_connection() as connection:
        connection.execute(
            """
            INSERT INTO shell_events
            (id, session_id, origin, command, status, output, exit_code, created_at, completed_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                event.id, event.sessionId, event.origin, event.command, event.status,
                event.output, event.exitCode, event.createdAt, event.completedAt,
            ),
        )
    return event


def finish_shell_event(
    event: ShellEvent,
    status: Literal["completed", "blocked", "error"],
    output: str,
    exit_code: int | None,
) -> ShellEvent:
    completed = event.model_copy(update={
        "status": status,
        "output": output,
        "exitCode": exit_code,
        "completedAt": now_iso(),
    })
    with database_connection() as connection:
        connection.execute(
            """
            UPDATE shell_events
            SET status = ?, output = ?, exit_code = ?, completed_at = ?
            WHERE id = ?
            """,
            (completed.status, completed.output, completed.exitCode, completed.completedAt, completed.id),
        )
    return completed


def get_shell_history(session_id: str, limit: int = 100) -> list[ShellEvent]:
    with database_connection() as connection:
        rows = connection.execute(
            """
            SELECT id, session_id, origin, command, status, output, exit_code, created_at, completed_at
            FROM shell_events
            WHERE session_id = ?
            ORDER BY created_at DESC, rowid DESC
            LIMIT ?
            """,
            (session_id, min(max(limit, 1), 200)),
        ).fetchall()
    return [
        ShellEvent(
            id=row["id"], sessionId=row["session_id"], origin=row["origin"],
            command=row["command"], status=row["status"], output=row["output"],
            exitCode=row["exit_code"], createdAt=row["created_at"], completedAt=row["completed_at"],
        )
        for row in reversed(rows)
    ]


def is_guarded_command(command: str) -> tuple[bool, str | None, list[str] | None]:
    """Centralized shell authorization for user and AI initiated commands."""
    if not command.strip():
        return False, "A command is required.", None
    if HARD_BLOCKED_PATTERN.search(command):
        return False, "That command is blocked because it could damage or stop the server.", None
    if settings.allow_shell_execution:
        return True, None, None
    if SHELL_METACHARACTER.search(command):
        return False, "Shell chaining, redirects, substitutions, and multiline input are blocked in guarded mode.", None
    try:
        parts = shlex.split(command)
    except ValueError:
        return False, "The command could not be parsed safely.", None
    if not parts or parts[0] not in GUARDED_PROGRAMS:
        return False, "Only explicitly approved diagnostic commands are allowed in guarded mode.", None
    if parts[0] == "git" and (len(parts) < 2 or parts[1] not in {"status", "log", "diff", "branch"}):
        return False, "Only git status, log, diff, and branch are allowed in guarded mode.", None
    if any(SENSITIVE_PATH_FRAGMENT.search(part) for part in parts[1:]):
        return False, "That path may contain credentials or sensitive operating-system data.", None
    return True, None, parts


async def run_shell_command(
    session_id: str,
    origin: Literal["user", "ai", "system"],
    command: str,
) -> ShellEvent:
    event = create_shell_event(session_id, origin, command)
    await activity_hub.publish({"type": "shell", "event": event.model_dump()})
    allowed, reason, guarded_parts = is_guarded_command(command)
    if not allowed:
        completed = finish_shell_event(event, "blocked", reason or "Command blocked.", 126)
        await activity_hub.publish({"type": "shell", "event": completed.model_dump()})
        return completed

    started = time.perf_counter()
    try:
        if guarded_parts is not None:
            process = await asyncio.create_subprocess_exec(
                *guarded_parts,
                cwd=Path.cwd(),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
            )
        else:
            process = await asyncio.create_subprocess_shell(
                command,
                cwd=Path.cwd(),
                executable="/bin/bash",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
            )
        try:
            stdout, _ = await asyncio.wait_for(process.communicate(), timeout=settings.shell_timeout_seconds)
            timed_out = False
        except TimeoutError:
            timed_out = True
            process.kill()
            stdout, _ = await process.communicate()

        output = stdout.decode("utf-8", errors="replace")
        if timed_out:
            output = f"{output}\n\nCommand timed out after {settings.shell_timeout_seconds} seconds."
        if not output.strip():
            output = "(No output)"
        if len(output) > settings.shell_max_output_chars:
            output = f"{output[:settings.shell_max_output_chars]}\n\n[Output truncated]"
        exit_code = process.returncode if process.returncode is not None else 124
        status: Literal["completed", "error"] = "completed" if exit_code == 0 and not timed_out else "error"
        completed = finish_shell_event(event, status, output, exit_code)
    except Exception:
        logger.exception("Shell command failed")
        completed = finish_shell_event(event, "error", "The command could not be started.", 1)

    logger.info("Shell %s command completed in %sms", origin, round((time.perf_counter() - started) * 1000))
    await activity_hub.publish({"type": "shell", "event": completed.model_dump()})
    return completed


def get_openai_client() -> AsyncOpenAI:
    if not settings.openai_api_key:
        raise RuntimeError("OpenAI is not configured.")
    if settings.openai_base_url:
        return AsyncOpenAI(base_url=settings.openai_base_url, api_key=settings.openai_api_key)
    return AsyncOpenAI(api_key=settings.openai_api_key)


def build_openai_input(history: list[AgentMessage]) -> str:
    lines = ["Conversation history:"]
    for message in history:
        lines.append(f"{message.role.upper()}: {message.content}")
    return "\n\n".join(lines)


async def stream_openai_response(
    client: AsyncOpenAI,
    request: dict[str, Any],
    answer_parts: list[str],
) -> AsyncIterator[tuple[str | None, Any | None, list[Any]]]:
    """Yield text deltas while collecting completed function calls and response."""
    stream = await client.responses.create(**request, stream=True)
    calls: list[Any] = []
    response: Any | None = None
    async for event in stream:
        event_type = getattr(event, "type", "")
        if event_type == "response.output_text.delta":
            delta = str(getattr(event, "delta", ""))
            if delta:
                answer_parts.append(delta)
                yield delta, None, []
        elif event_type == "response.output_item.done":
            item = getattr(event, "item", None)
            if getattr(item, "type", "") == "function_call":
                calls.append(item)
        elif event_type == "response.completed":
            response = getattr(event, "response", None)
    yield None, response, calls


async def agent_event_stream(message: AgentMessageInput) -> AsyncIterator[str]:
    save_message(message.sessionId, "user", message.content)
    yield make_event({"type": "agent", "status": "thinking"})
    await activity_hub.publish({"type": "agent", "sessionId": message.sessionId, "status": "thinking"})
    tools: list[dict[str, Any]] = []
    if message.executeCommands:
        tools = [{
            "type": "function",
            "name": "run_shell_command",
            "description": "Run one audited server diagnostic command. Commands may be blocked by policy.",
            "parameters": {
                "type": "object",
                "properties": {
                    "command": {"type": "string", "description": "One diagnostic command."},
                    "reason": {"type": "string", "description": "Why this check is needed."},
                },
                "required": ["command", "reason"],
                "additionalProperties": False,
            },
        }]
    try:
        client = get_openai_client()
        instructions = request_instructions()
        request: dict[str, Any] = {
            "model": settings.openai_model,
            "instructions": instructions,
            "input": build_openai_input(get_history(message.sessionId)),
            "tools": tools,
        }
        answer_parts: list[str] = []
        response: Any | None = None
        for _ in range(4):
            calls: list[Any] = []
            async for delta, completed_response, completed_calls in stream_openai_response(client, request, answer_parts):
                if delta:
                    yield make_event({"type": "message_delta", "content": delta})
                if completed_response is not None:
                    response = completed_response
                    calls = completed_calls
            if response is None:
                raise RuntimeError("OpenAI did not return a completed response.")
            if not calls:
                break
            tool_outputs: list[dict[str, str]] = []
            for call in calls:
                try:
                    arguments = json.loads(call.arguments)
                    command = str(arguments["command"])
                    reason = str(arguments.get("reason", ""))
                except (TypeError, KeyError, json.JSONDecodeError):
                    command, reason = "", ""
                yield make_event({"type": "tool", "command": command or "Invalid command", "reason": reason, "status": "running"})
                result = await run_shell_command(message.sessionId, "ai", command)
                yield make_event({"type": "tool", "event": result.model_dump()})
                tool_outputs.append({
                    "type": "function_call_output",
                    "call_id": call.call_id,
                    "output": json.dumps(result.model_dump()),
                })
            request = {
                "model": settings.openai_model,
                "previous_response_id": response.id,
                "instructions": instructions,
                "input": tool_outputs,
                "tools": tools,
            }
        streamed_answer = "".join(answer_parts)
        answer = streamed_answer if streamed_answer.strip() else (
            getattr(response, "output_text", "").strip() or "I completed the requested server check."
        )
        saved_answer = save_message(message.sessionId, "assistant", answer)
        if not answer_parts:
            yield make_event({"type": "message", "content": answer})
        yield make_event({"type": "done", "messageId": saved_answer.id})
        await activity_hub.publish({"type": "agent", "sessionId": message.sessionId, "status": "idle"})
    except Exception:
        logger.exception("DRE agent request failed")
        error_text = "The DRE agent could not complete that request. Check the server configuration and try again."
        save_message(message.sessionId, "system", error_text)
        yield make_event({"type": "error", "error": error_text})


async def require_agent_token(authorization: str | None = Header(default=None)) -> None:
    if not settings.agent_token:
        raise HTTPException(status_code=503, detail="DRE_AGENT_TOKEN is not configured.")
    supplied = authorization.removeprefix("Bearer ").strip() if authorization else ""
    if not supplied or not hmac.compare_digest(supplied, settings.agent_token):
        raise HTTPException(status_code=401, detail="Valid DRE agent token required.")


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    initialize_database()
    yield


app = FastAPI(title="DRE Server Copilot", version="2.0.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["Authorization", "Content-Type"],
)


@app.get("/api/healthz")
async def health_check() -> dict[str, Any]:
    """Safe enough for infrastructure checks; intentionally contains no secrets."""
    return {
        "status": "ok" if database_ready else "degraded",
        "database": "available" if database_ready else "error",
        "uptimeSeconds": round(time.monotonic() - APP_STARTED_AT),
    }


@app.get("/health", include_in_schema=False)
async def legacy_health_check() -> dict[str, Any]:
    """Compatibility alias for the original DRE agent health route."""
    return await health_check()


@app.get("/api/status", dependencies=[Depends(require_agent_token)])
async def get_status(sessionId: str = Query(min_length=8, max_length=128)) -> dict[str, Any]:
    events = get_shell_history(sessionId, limit=1)
    latest = events[-1].model_dump() if events else None
    return {
        "api": "online",
        "openai": "configured" if settings.openai_api_key else "missing",
        "shellMode": "unrestricted" if settings.allow_shell_execution else "guarded",
        "database": "available" if database_ready else "error",
        "sessionId": sessionId,
        "uptimeSeconds": round(time.monotonic() - APP_STARTED_AT),
        "recentCommand": latest,
    }


@app.post("/api/agent/session/new", dependencies=[Depends(require_agent_token)])
async def new_session() -> NewSessionResponse:
    return NewSessionResponse(sessionId=str(uuid4()))


@app.get("/api/agent/history", dependencies=[Depends(require_agent_token)])
async def get_agent_history(sessionId: str = Query(min_length=8, max_length=128)) -> list[dict[str, str]]:
    return [message.model_dump() for message in get_history(sessionId)]


@app.post("/api/agent/chat", dependencies=[Depends(require_agent_token)])
async def chat_with_agent(message: AgentMessageInput) -> StreamingResponse:
    return StreamingResponse(
        agent_event_stream(message),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no"},
    )


class LegacyAskInput(BaseModel):
    """The original endpoint accepted a prompt without requiring a session."""

    content: str = Field(min_length=1, max_length=10000)
    sessionId: str = Field(default_factory=lambda: str(uuid4()), min_length=8, max_length=128)
    executeCommands: bool = False

    @model_validator(mode="before")
    @classmethod
    def accept_legacy_prompt_fields(cls, value: Any) -> Any:
        if not isinstance(value, dict) or value.get("content"):
            return value
        for legacy_key in ("message", "prompt", "query"):
            if value.get(legacy_key):
                return {**value, "content": value[legacy_key]}
        return value


@app.post("/ask", dependencies=[Depends(require_agent_token)])
async def legacy_ask(message: LegacyAskInput) -> StreamingResponse:
    """Compatibility alias that keeps the old prompt shape and SSE response."""
    return StreamingResponse(
        agent_event_stream(AgentMessageInput(
            content=message.content,
            sessionId=message.sessionId,
            executeCommands=message.executeCommands,
        )),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no"},
    )


@app.get("/api/terminal/history", dependencies=[Depends(require_agent_token)])
async def get_terminal_history(sessionId: str = Query(min_length=8, max_length=128)) -> list[dict[str, Any]]:
    return [event.model_dump() for event in get_shell_history(sessionId)]


@app.get("/api/terminal/output", dependencies=[Depends(require_agent_token)])
async def get_terminal_output(sessionId: str = Query(min_length=8, max_length=128)) -> dict[str, Any]:
    events = get_shell_history(sessionId, limit=1)
    if not events:
        return TerminalState(
            output="DRE terminal is ready. Activity will appear here.",
            lastCommand=None,
            status="ready",
            updatedAt=now_iso(),
        ).model_dump()
    event = events[-1]
    status = "success" if event.status == "completed" else "running" if event.status == "running" else "error"
    return TerminalState(
        output=event.output,
        lastCommand=event.command,
        status=status,
        updatedAt=event.completedAt or event.createdAt,
    ).model_dump()


@app.post("/api/terminal/execute", dependencies=[Depends(require_agent_token)])
async def execute_terminal_command(command: TerminalCommandInput) -> JSONResponse:
    event = await run_shell_command(command.sessionId, "user", command.command)
    status_code = 400 if event.status == "blocked" else 200
    return JSONResponse(content=event.model_dump(), status_code=status_code)


@app.get("/api/events", dependencies=[Depends(require_agent_token)])
async def events(session_id: str = Query(alias="sessionId", min_length=8, max_length=128)) -> StreamingResponse:
    async def stream() -> AsyncIterator[str]:
        async with activity_hub.subscribe(session_id) as queue:
            yield make_event({"type": "connected"})
            while True:
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=20)
                    yield make_event(event)
                except TimeoutError:
                    yield ": keepalive\n\n"
    return StreamingResponse(stream(), media_type="text/event-stream", headers={"Cache-Control": "no-cache"})


if (FRONTEND_DIST / "assets").is_dir():
    app.mount("/assets", StaticFiles(directory=FRONTEND_DIST / "assets"), name="assets")


@app.get("/{full_path:path}", include_in_schema=False, response_model=None)
async def serve_frontend(full_path: str) -> FileResponse | JSONResponse:
    """Serve the compiled SPA directly in production without a Node server."""
    candidate = FRONTEND_DIST / full_path
    if full_path and candidate.is_file():
        return FileResponse(candidate)
    index = FRONTEND_DIST / "index.html"
    if index.is_file():
        return FileResponse(index)
    return JSONResponse(
        status_code=503,
        content={"detail": "Frontend build is not present. Build the React app before production startup."},
    )