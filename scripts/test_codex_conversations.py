import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

import codex_conversations


class CodexConversationsTest(unittest.TestCase):
    def setUp(self):
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.base = Path(self.temporary_directory.name)
        self.rollout = self.base / "rollout.jsonl"
        self.database = self.base / "state_1.sqlite"
        with sqlite3.connect(self.database) as connection:
            connection.execute(
                """
                CREATE TABLE threads (
                    id TEXT, title TEXT, cwd TEXT, source TEXT, rollout_path TEXT,
                    created_at_ms INTEGER, recency_at_ms INTEGER, archived INTEGER,
                    preview TEXT
                )
                """
            )

    def tearDown(self):
        self.temporary_directory.cleanup()

    def add_thread(self, thread_id, source="vscode", archived=0, preview="visible"):
        with sqlite3.connect(self.database) as connection:
            connection.execute(
                "INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    thread_id,
                    "Test conversation",
                    "/project",
                    source,
                    str(self.rollout),
                    1_700_000_000_000,
                    1_700_000_100_000,
                    archived,
                    preview,
                ),
            )

    def write_index(self, records):
        (self.base / "session_index.jsonl").write_text(
            "\n".join(json.dumps(record) for record in records), encoding="utf-8"
        )

    def test_list_uses_deduplicated_user_facing_index(self):
        self.add_thread("00000000-0000-0000-0000-000000000001")
        self.add_thread(
            "00000000-0000-0000-0000-000000000002",
            source='{"subagent":{"other":"guardian"}}',
        )
        self.add_thread("00000000-0000-0000-0000-000000000003")
        self.write_index(
            [
                {
                    "id": "00000000-0000-0000-0000-000000000001",
                    "thread_name": "Old title",
                    "updated_at": "2026-01-01T00:00:00Z",
                },
                {
                    "id": "00000000-0000-0000-0000-000000000001",
                    "thread_name": "Current title ghp_123456789012345678901234",
                    "updated_at": "2026-01-02T00:00:00Z",
                },
                {
                    "id": "00000000-0000-0000-0000-000000000002",
                    "thread_name": "Indexed subagent",
                    "updated_at": "2026-01-04T00:00:00Z",
                },
                {
                    "id": "00000000-0000-0000-0000-000000000003",
                    "thread_name": "Second root thread",
                    "updated_at": "2026-01-03T00:00:00Z",
                },
            ]
        )
        with codex_conversations.open_database(self.database) as connection:
            result = codex_conversations.list_threads(connection, self.base, 2)
        self.assertEqual(
            [thread["thread_id"] for thread in result],
            [
                "00000000-0000-0000-0000-000000000003",
                "00000000-0000-0000-0000-000000000001",
            ],
        )
        self.assertEqual(result[1]["title"], "Current title [REDACTED]")

    def test_read_filters_context_and_redacts_secrets(self):
        thread_id = "00000000-0000-0000-0000-000000000001"
        self.add_thread(thread_id)
        records = [
            {
                "type": "response_item",
                "payload": {
                    "type": "message",
                    "role": "user",
                    "content": [
                        {"type": "input_text", "text": "<environment_context>omit</environment_context>"},
                        {"type": "input_text", "text": "Please fix the sync."},
                    ],
                },
            },
            {
                "type": "response_item",
                "payload": {
                    "type": "message",
                    "role": "assistant",
                    "content": [
                        {"type": "output_text", "text": "Used api_key=supersecretvalue safely."}
                    ],
                },
            },
            {
                "type": "response_item",
                "payload": {"type": "custom_tool_call_output", "output": "never include"},
            },
        ]
        self.rollout.write_text(
            "\n".join(json.dumps(record) for record in records), encoding="utf-8"
        )
        with codex_conversations.open_database(self.database) as connection:
            result = codex_conversations.read_thread(
                connection, self.base, thread_id, 10_000
            )

        rendered = json.dumps(result)
        self.assertIn("Please fix the sync.", rendered)
        self.assertNotIn("environment_context", rendered)
        self.assertNotIn("supersecretvalue", rendered)
        self.assertNotIn("never include", rendered)

    def test_redacts_representative_credential_families(self):
        samples = (
            "ghp_123456789012345678901234",
            "AKIA1234567890ABCDEF",
            "postgresql://user:password123@localhost/database",
            "-----BEGIN PRIVATE KEY-----\nabc123\n-----END PRIVATE KEY-----",
        )
        for sample in samples:
            with self.subTest(sample=sample):
                self.assertEqual(codex_conversations.redact(sample), "[REDACTED]")

    def test_trim_messages_enforces_hard_character_cap(self):
        messages = [
            {"role": "user", "text": "a" * 2_000},
            {"role": "assistant", "text": "b" * 2_000},
            {"role": "user", "text": "c" * 2_000},
        ]
        result, truncated = codex_conversations.trim_messages(messages, 1_000)
        self.assertTrue(truncated)
        self.assertLessEqual(sum(len(message["text"]) for message in result), 1_000)
        self.assertTrue(result[0]["text"].startswith("a"))
        self.assertTrue(result[-1]["text"].endswith("c"))


if __name__ == "__main__":
    unittest.main()
