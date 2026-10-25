import json
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException
from pydantic import ValidationError
from starlette.requests import Request

from app import stats, store


class StatsSaveTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        db = patch.object(store, "DB_PATH", Path(directory.name) / "test.db")
        db.start()
        self.addCleanup(db.stop)
        store.init_db()
        self.study = store.create_study("alice", "Test", store._tree_from_moves(["e4", "e5"]), {}, "white")
        self.request = Request({"type": "http", "session": {"username": "alice"}})
        common = {
            "movesFingerprint": self.study["movesFingerprint"], "side": "white",
            "explorerSettings": self.study["explorerSettings"],
        }
        self.score = stats.ExpectedScoreIn(
            **common, winRate=0.5, lossProbability=0.3, coverage=[], nodesEvaluated=1, explorerCalls=1
        )
        self.evaluation = stats.ExpectedEvalIn(
            **common, evalCp=30, evalMisses=0, depth=12, method=stats.EVAL_METHOD
        )

    def save_score(self):
        return stats.save_expected_score(self.study["id"], self.request, self.score)

    def save_eval(self):
        return stats.save_expected_eval(self.study["id"], self.request, self.evaluation)

    def test_current_results_merge_and_store_actual_input_fingerprints(self):
        # Parallel calculations may save independently without losing either result.
        with ThreadPoolExecutor(max_workers=2) as pool:
            futures = [pool.submit(self.save_score), pool.submit(self.save_eval)]
            for future in futures:
                future.result()
        saved = store.get_study("alice", self.study["id"])["stats"]
        self.assertEqual(saved["winProbability"], 0.6)
        self.assertEqual(saved["evalCp"], 30)
        for key in ("winProbabilityMovesFingerprint", "evalMovesFingerprint"):
            self.assertEqual(saved[key], self.study["movesFingerprint"])

    def test_changed_moves_start_or_side_reject_both_results_without_writing(self):
        tree = json.loads(json.dumps(store._tree_from_moves(["d4", "d5"])))
        edits = (
            ("tree", json.dumps(tree)),
            ("start_node_id", 1),
            ("side", "black"),
        )
        for column, value in edits:
            with self.subTest(column=column):
                with store._connect() as conn:
                    conn.execute(f"UPDATE studies SET {column} = ? WHERE id = ?", (value, self.study["id"]))
                before = store.get_study("alice", self.study["id"])
                for save in (self.save_score, self.save_eval):
                    with self.assertRaises(HTTPException) as error:
                        save()
                    self.assertEqual(error.exception.status_code, 409)
                    self.assertEqual(store.get_study("alice", self.study["id"]), before)
                with store._connect() as conn:
                    conn.execute(
                        "UPDATE studies SET tree = ?, start_node_id = NULL, side = 'white' WHERE id = ?",
                        (json.dumps(self.study["tree"]), self.study["id"]),
                    )

    def test_saving_results_does_not_replace_newer_study_settings(self):
        settings = {**self.study["explorerSettings"], "minRating": 2200}
        with store._connect() as conn:
            conn.execute("UPDATE studies SET explorer_settings = ? WHERE id = ?", (json.dumps(settings), self.study["id"]))
        for save in (self.save_score, self.save_eval):
            saved = save()
            self.assertEqual(saved["explorerSettings"], settings)
        self.assertEqual(saved["stats"]["minRating"], self.score.explorerSettings.minRating)
        self.assertEqual(saved["stats"]["evalSettings"]["minRating"], self.evaluation.explorerSettings.minRating)

    def test_missing_input_fingerprint_is_rejected(self):
        for payload in (self.score, self.evaluation):
            data = payload.model_dump()
            data.pop("movesFingerprint")
            with self.assertRaises(ValidationError):
                type(payload)(**data)

    def test_other_owner_cannot_save_results(self):
        self.request = Request({"type": "http", "session": {"username": "bob"}})
        for save in (self.save_score, self.save_eval):
            with self.assertRaises(HTTPException) as error:
                save()
            self.assertEqual(error.exception.status_code, 404)


if __name__ == "__main__":
    unittest.main()
