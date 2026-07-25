#!/usr/bin/env python3
"""Read recent user-owned Codex conversations from the local Codex store."""

from __future__ import annotations

import argparse
import json
import os
import re
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


THREAD_ID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
    re.IGNORECASE,
)
SECRET_PATTERNS = (
    re.compile(
        r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----.*?"
        r"-----END [A-Z0-9 ]*PRIVATE KEY-----",
        re.DOTALL,
    ),
    re.compile(r"\bsk-[A-Za-z0-9_-]{16,}\b"),
    re.compile(r"\bgh[pousr]_[A-Za-z0-9]{20,}\b"),
    re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
    re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{10,}\b"),
    re.compile(r"\bBearer\s+[A-Za-z0-9._~+/=-]{12,}", re.IGNORECASE),
    re.compile(r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b"),
    re.compile(
        r"(?i)\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis)"
        r"://[^\s:/]+:[^@\s]+@[^\s]+"
    ),
    re.compile(
        r"(?i)\b(api[_ -]?key|access[_ -]?token|refresh[_ -]?token|password|secret)"
        r"\s*[:=]\s*[\"']?[^\s\"']{8,}"
    ),
)
CONTEXT_PREFIXES = (
    "<environment_context>",
    "<recommended_plugins>",
    "# AGENTS.md instructions",
    "<permissions instructions>",
    "<collaboration_mode>",
)


def codex_home() -> Path:
    configured = os.environ.get("CODEX_HOME")
    return Path(configured).expanduser() if configured else Path.home() / ".codex"


def find_state_db(base: Path) -> Path:
    candidates = sorted(
        base.glob("state_*.sqlite"),
        key=lambda path: path.stat().st_mtime,
        reverse=True,
    )
    for candidate in candidates:
        try:
            with sqlite3.connect(f"file:{candidate}?mode=ro", uri=True) as connection:
                found = connection.execute(
                    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='threads'"
                ).fetchone()
            if found:
                return candidate
        except sqlite3.Error:
            continue
    raise RuntimeError(f"No readable Codex thread database found under {base}")


def open_database(path: Path) -> sqlite3.Connection:
    connection = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    return connection


def iso_time(milliseconds: int) -> str:
    return datetime.fromtimestamp(milliseconds / 1000, tz=timezone.utc).isoformat()


def list_threads(
    connection: sqlite3.Connection, base: Path, limit: int
) -> list[dict[str, Any]]:
    """List the user-facing task index, then enrich it from the thread database."""
    newest_by_id: dict[str, dict[str, str]] = {}
    with (base / "session_index.jsonl").open(encoding="utf-8") as index:
        for line in index:
            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                continue
            thread_id = record.get("id")
            updated_at = record.get("updated_at")
            if not isinstance(thread_id, str) or not THREAD_ID_RE.fullmatch(thread_id):
                continue
            if not isinstance(updated_at, str):
                continue
            previous = newest_by_id.get(thread_id)
            if previous is None or updated_at > previous["updated_at"]:
                newest_by_id[thread_id] = record

    candidates = sorted(
        newest_by_id.values(), key=lambda record: record["updated_at"], reverse=True
    )
    result: list[dict[str, Any]] = []
    for index_record in candidates:
        if len(result) >= limit:
            break
        row = connection.execute(
            """
            SELECT id, cwd, source, rollout_path, created_at_ms, recency_at_ms
            FROM threads
            WHERE id = ?
            LIMIT 1
            """,
            (index_record["id"],),
        ).fetchone()
        if row is not None and row["source"] not in {"vscode", "cli"}:
            continue
        if row is None:
            result.append(
                {
                    "thread_id": index_record["id"],
                    "title": redact(
                        index_record.get("thread_name", "Untitled conversation")
                    ),
                    "updated_at": index_record["updated_at"],
                    "error": "thread metadata missing from local Codex database",
                }
            )
            continue
        result.append(
            {
                "thread_id": row["id"],
                "title": redact(
                    index_record.get("thread_name", "Untitled conversation")
                ),
                "created_at": iso_time(row["created_at_ms"]),
                "updated_at": index_record["updated_at"],
                "cwd": row["cwd"],
                "source": row["source"],
            }
        )
    return result


def redact(text: str) -> str:
    cleaned = text
    for pattern in SECRET_PATTERNS:
        cleaned = pattern.sub("[REDACTED]", cleaned)
    return cleaned


def message_text(payload: dict[str, Any]) -> str:
    parts: list[str] = []
    for item in payload.get("content", []):
        if not isinstance(item, dict):
            continue
        value = item.get("text") or item.get("input_text") or item.get("output_text")
        if not isinstance(value, str):
            continue
        if payload.get("role") == "user" and value.lstrip().startswith(CONTEXT_PREFIXES):
            continue
        parts.append(value.strip())
    return redact("\n\n".join(part for part in parts if part))


def indexed_title(base: Path, thread_id: str, fallback: str) -> str:
    title = fallback
    newest = ""
    try:
        with (base / "session_index.jsonl").open(encoding="utf-8") as index:
            for line in index:
                try:
                    record = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if record.get("id") != thread_id:
                    continue
                updated_at = record.get("updated_at", "")
                if updated_at >= newest:
                    newest = updated_at
                    title = record.get("thread_name") or fallback
    except OSError:
        pass
    return title


def trim_messages(messages: list[dict[str, str]], max_chars: int) -> tuple[list[dict[str, str]], bool]:
    total = sum(len(message["text"]) for message in messages)
    if total <= max_chars:
        return messages, False

    if not messages:
        return [], False

    first_text = messages[0]["text"][: max_chars // 2]
    first = [{"role": messages[0]["role"], "text": first_text}]
    remaining = max_chars - len(first_text)
    tail: list[dict[str, str]] = []
    for message in reversed(messages[1:]):
        if remaining <= 0:
            break
        text = message["text"]
        if len(text) > remaining:
            text = text[-remaining:]
        tail.append({"role": message["role"], "text": text})
        remaining -= len(text)
    return first + list(reversed(tail)), True


def read_thread(
    connection: sqlite3.Connection, base: Path, thread_id: str, max_chars: int
) -> dict[str, Any]:
    if not THREAD_ID_RE.fullmatch(thread_id):
        raise ValueError("thread ID must be an immutable UUID")

    row = connection.execute(
        """
        SELECT id, title, cwd, source, rollout_path, created_at_ms, recency_at_ms
        FROM threads
        WHERE id = ? AND source IN ('vscode', 'cli')
        """,
        (thread_id,),
    ).fetchone()
    if row is None:
        raise KeyError(f"User-owned Codex thread not found: {thread_id}")

    rollout_path = Path(row["rollout_path"])
    messages: list[dict[str, str]] = []
    with rollout_path.open(encoding="utf-8") as rollout:
        for line in rollout:
            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                continue
            payload = record.get("payload", {})
            if record.get("type") != "response_item" or payload.get("type") != "message":
                continue
            role = payload.get("role")
            if role not in {"user", "assistant"}:
                continue
            text = message_text(payload)
            if text:
                messages.append({"role": role, "text": text})

    messages, truncated = trim_messages(messages, max_chars)
    return {
        "thread_id": row["id"],
        "title": redact(indexed_title(base, row["id"], row["title"])),
        "created_at": iso_time(row["created_at_ms"]),
        "updated_at": iso_time(row["recency_at_ms"]),
        "cwd": row["cwd"],
        "source": row["source"],
        "messages": messages,
        "truncated": truncated,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="List or read user-owned conversations from the local Codex store."
    )
    parser.add_argument(
        "--codex-home",
        type=Path,
        default=codex_home(),
        help="Codex data directory (defaults to CODEX_HOME or ~/.codex).",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    list_parser = subparsers.add_parser("list", help="List recent root conversations.")
    list_parser.add_argument("--limit", type=int, default=25)

    read_parser = subparsers.add_parser("read", help="Read one conversation.")
    read_parser.add_argument("thread_id")
    read_parser.add_argument("--max-chars", type=int, default=60_000)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        database = find_state_db(args.codex_home)
        with open_database(database) as connection:
            if args.command == "list":
                if not 1 <= args.limit <= 100:
                    raise ValueError("--limit must be between 1 and 100")
                result: Any = list_threads(connection, args.codex_home, args.limit)
            else:
                if not 1_000 <= args.max_chars <= 250_000:
                    raise ValueError("--max-chars must be between 1000 and 250000")
                result = read_thread(
                    connection, args.codex_home, args.thread_id, args.max_chars
                )
        json.dump(result, sys.stdout, ensure_ascii=False, indent=2)
        sys.stdout.write("\n")
        return 0
    except (OSError, sqlite3.Error, RuntimeError, ValueError, KeyError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
