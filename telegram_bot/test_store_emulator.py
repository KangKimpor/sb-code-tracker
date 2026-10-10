"""Real transaction tests. Refuses all projects except a local demo emulator."""

import os
import unittest
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

from google.cloud import firestore

from models import TrackerError, fingerprint, month_key
from store import Store


@unittest.skipUnless(os.environ.get("FIRESTORE_EMULATOR_HOST"), "Requires the local Firestore emulator")
class StoreTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # This ID is deliberately never configurable from production credentials.
        cls.db = firestore.Client(project="demo-telegram-tracker")
        cls.store = Store(cls.db)

    def setUp(self):
        self.id = uuid.uuid4().hex
        self.ref = self.db.collection("codes").document(self.id)
        self.code = {"code": "TEST-" + self.id.upper(), "monthKey": month_key(), "status": "available", "takenBy": None, "takenAt": None, "createdAt": 1}
        self.ref.set(self.code)
        self.uid = int(self.id[:12], 16)

    def operation(self):
        return uuid.uuid4().hex

    def test_competing_claims_have_one_winner(self):
        def claim(uid):
            try:
                return self.store.mutate("claim", uid, self.operation(), id=self.id, name=f"Staff {uid}")
            except TrackerError:
                return None
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(claim, [self.uid, self.uid + 1]))
        self.assertEqual(sum(r is not None for r in results), 1)
        self.assertEqual(self.ref.get().to_dict()["status"], "taken")

    def test_retry_returns_claim_without_another_audit(self):
        op = self.operation()
        first = self.store.mutate("claim", self.uid, op, id=self.id, name="Staff")
        second = self.store.mutate("claim", self.uid, op, id=self.id, name="Staff")
        self.assertEqual(first, second)
        logs = list(self.db.collection("activityLog").where("deviceId", "==", f"telegram:{self.uid}").stream())
        self.assertEqual(len(logs), 1)
        self.assertNotIn("claimRequest", self.ref.get().to_dict())
        mirror = self.db.collection("codeInventory").document(self.id).get().to_dict()
        self.assertEqual(mirror["status"], "taken")
        self.assertNotEqual(mirror["code"], first["code"])
        self.assertNotIn("takenDevice", mirror)

    def test_release_history_and_retry_then_browser_claim(self):
        self.store.mutate("claim", self.uid, self.operation(), id=self.id, name="Staff")
        expected = fingerprint(self.ref.get().to_dict())
        op = self.operation()
        self.store.mutate("release", self.uid, op, id=self.id, expected=expected)
        self.store.mutate("release", self.uid, op, id=self.id, expected=expected)
        history = list(self.db.collection("releaseHistory").where("code", "==", self.code["code"]).stream())
        self.assertEqual(len(history), 1)
        self.assertEqual(history[0].to_dict()["takenDevice"], f"telegram:{self.uid}")
        self.assertEqual(self.ref.get().to_dict()["status"], "available")
        # The compatibility website updates the same document and leaves no bot-only fields.
        self.ref.update({"status": "taken", "takenBy": "Browser Staff", "takenDevice": "browser-device", "takenAt": firestore.SERVER_TIMESTAMP})
        with self.assertRaises(TrackerError):
            self.store.mutate("claim", self.uid, self.operation(), id=self.id, name="Staff")

    def test_stale_confirmation_does_not_delete_an_app_claim(self):
        before = fingerprint(self.code)
        self.ref.update({"status": "taken", "takenBy": "Browser Staff", "takenDevice": "browser", "takenAt": firestore.SERVER_TIMESTAMP})
        with self.assertRaises(TrackerError):
            self.store.mutate("delete", self.uid, self.operation(), expected={self.id: before})
        self.assertTrue(self.ref.get().exists)

    def test_future_and_expired_rejected_legacy_allowed(self):
        for month in ("2000-01", "9999-12"):
            self.ref.update({"monthKey": month})
            with self.assertRaises(TrackerError):
                self.store.mutate("claim", self.uid, self.operation(), id=self.id, name="Staff")
        self.ref.update({"monthKey": firestore.DELETE_FIELD})
        self.assertIn("code", self.store.mutate("claim", self.uid, self.operation(), id=self.id, name="Staff"))

    def test_topup_retry_and_new_operation_cooldown(self):
        op = self.operation()
        self.store.mutate("requestTopup", self.uid, op)
        self.store.mutate("requestTopup", self.uid, op)
        with self.assertRaises(TrackerError):
            self.store.mutate("requestTopup", self.uid, self.operation())
        requests = list(self.db.collection("topupRequests").where("deviceId", "==", f"telegram:{self.uid}").stream())
        self.assertEqual(len(requests), 1)

    def test_bulk_add_is_atomic_uppercase_and_duplicate_safe(self):
        value = "BULK-" + self.id.upper()
        op = self.operation()
        result = self.store.mutate("add", self.uid, op, month=month_key(), codes=[value.lower(), value])
        retry = self.store.mutate("add", self.uid, op, month=month_key(), codes=[value])
        self.assertEqual(result, retry)
        self.assertEqual(result["count"], 1)
        self.assertEqual(self.store.mutate("add", self.uid, self.operation(), month=month_key(), codes=[value])["count"], 0)
        self.assertEqual(len(list(self.db.collection("codes").where("code", "==", value).stream())), 1)

    def test_unlabelled_current_drop_duplicate_is_skipped(self):
        self.ref.update({"monthKey": firestore.DELETE_FIELD})
        result = self.store.mutate("add", self.uid, self.operation(), month=month_key(), codes=[self.code["code"]])
        self.assertEqual(result["count"], 0)

    def test_label_and_delete_mirror_retry(self):
        self.ref.update({"monthKey": firestore.DELETE_FIELD})
        op = self.operation()
        expected = {self.id: fingerprint(self.ref.get().to_dict())}
        self.store.mutate("label", self.uid, op, expected=expected, month=month_key())
        self.store.mutate("label", self.uid, op, expected=expected, month=month_key())
        self.assertEqual(self.ref.get().to_dict()["monthKey"], month_key())
        self.assertEqual(self.db.collection("codeInventory").document(self.id).get().to_dict()["monthKey"], month_key())
        expected = {self.id: fingerprint(self.ref.get().to_dict())}
        op = self.operation()
        self.store.mutate("delete", self.uid, op, expected=expected)
        self.store.mutate("delete", self.uid, op, expected=expected)
        self.assertFalse(self.ref.get().exists)
        self.assertFalse(self.db.collection("codeInventory").document(self.id).get().exists)

    def test_persistent_rate_limit_rejects_sixth_login(self):
        for _ in range(5):
            self.store.throttle(self.uid, "login", 5, 900)
        with self.assertRaises(TrackerError):
            Store(self.db).throttle(self.uid, "login", 5, 900)

    def test_cleanup_timestamp_bounds_preserve_recent_history(self):
        old, recent = [self.db.collection("releaseHistory").document() for _ in range(2)]
        old.set({"releasedAt": datetime.now(timezone.utc) - timedelta(days=40)})
        recent.set({"releasedAt": datetime.now(timezone.utc)})
        cutoff = int((datetime.now(timezone.utc) - timedelta(days=30)).timestamp() * 1000)
        op = self.operation()
        result = self.store.cleanup(self.uid, op, "prune", cutoff=cutoff)
        retry = self.store.cleanup(self.uid, op, "prune", cutoff=cutoff)
        self.assertEqual(result, retry)
        self.assertFalse(old.get().exists)
        self.assertTrue(recent.get().exists)


if __name__ == "__main__":
    unittest.main()
