import sqlite3
import tempfile
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime
from pathlib import Path
from unittest.mock import patch

from starlette.requests import Request

from app import practice, store


class PracticeAttemptTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        db = patch.object(store, "DB_PATH", Path(directory.name) / "test.db")
        db.start()
        self.addCleanup(db.stop)
        store.init_db()
        self.study = store.create_study(
            "alice", "Test", store._tree_from_moves(["e4"]), {}, "white"
        )
        self.at = datetime.now(UTC).isoformat()

    def record(self, correct=True, grade=practice.apply_answer):
        return store.record_practice_attempt("alice", self.study["id"], 1, correct, self.at, grade)

    def test_route_records_state_and_activity(self):
        request = Request({"type": "http", "session": {"username": "alice"}})
        result = practice.record_attempt(
            self.study["id"], practice.AttemptIn(nodeId=1, correct=True), request
        )
        self.assertEqual(result, {"streak": 1, "tauDays": 1.0, "knowledge": 1 / 3})
        self.assertEqual(store.get_practice_states("alice", self.study["id"])[1]["streak"], 1)
        self.assertEqual(store.practice_totals("alice"), {self.study["id"]: {"answers": 1}})

    def test_queue_says_when_it_is_only_optional_review(self):
        request = Request({"type": "http", "session": {"username": "alice"}})
        queue = practice.practice_queue(self.study["id"], request)
        self.assertEqual(queue, {"nodeIds": [1], "optional": False})
        self.record()
        queue = practice.practice_queue(self.study["id"], request)
        self.assertEqual(queue, {"nodeIds": [1], "optional": True})

    def test_concurrent_answers_grade_latest_committed_state(self):
        self.record()
        self.record()
        barrier = threading.Barrier(2)

        def slow_grade(prev, correct):
            # Keep the read/grade/write window open so an unlocked read would
            # allow both answers to grade the same previous state.
            time.sleep(0.1)
            return practice.apply_answer(prev, correct)

        def answer():
            barrier.wait(timeout=5)
            return self.record(grade=slow_grade)

        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda _: answer(), range(2)))

        self.assertEqual(sorted(results), [(3, 4.0), (3, 8.0)])
        state = store.get_practice_states("alice", self.study["id"])[1]
        self.assertEqual(state["tau_days"], 8.0)
        self.assertEqual(store.practice_totals("alice"), {self.study["id"]: {"answers": 4}})

    def test_log_failure_rolls_back_state(self):
        for existing in (False, True):
            with self.subTest(existing=existing):
                if existing:
                    self.record()
                before = store.get_practice_states("alice", self.study["id"])
                totals = store.practice_totals("alice")
                with store._connect() as conn:
                    conn.execute("""
                        CREATE TRIGGER fail_practice_log BEFORE INSERT ON practice_log
                        BEGIN SELECT RAISE(ABORT, 'log failed'); END
                    """)
                with self.assertRaisesRegex(sqlite3.IntegrityError, "log failed"):
                    self.record(correct=False)
                self.assertEqual(store.get_practice_states("alice", self.study["id"]), before)
                self.assertEqual(store.practice_totals("alice"), totals)
                with store._connect() as conn:
                    conn.execute("DROP TRIGGER fail_practice_log")


if __name__ == "__main__":
    unittest.main()
