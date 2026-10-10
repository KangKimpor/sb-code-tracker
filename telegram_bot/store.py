"""Admin SDK adapter for the website's existing Firestore collections.

Every mutation, inventory mirror, audit and retry receipt shares a transaction.
Receipts and throttles are in server-only collections, denied by tracker rules.
No Firebase Functions deployment or website rules change is needed.
"""

import hashlib
import time
from datetime import datetime, timedelta, timezone

from google.cloud import firestore
from google.cloud.firestore_v1.base_query import FieldFilter

from models import (MONTH_MS, TrackerError, bucket, clean_text, code_id,
                    fingerprint, inventory, month_key, valid_month)


class Store:
    def __init__(self, client):
        self.db = client

    def codes(self):
        # Match the app: unlabelled legacy rows remain live, scheduled rows stay hidden.
        return sorted(({**d.to_dict(), "id": d.id} for d in self.db.collection("codes").stream()), key=lambda c: c.get("createdAt") or 0)

    def rows(self, collection, field, cutoff=None, limit=100):
        query = self.db.collection(collection)
        if cutoff is not None:
            query = query.where(filter=FieldFilter(field, ">=", cutoff))
        query = query.order_by(field, direction=firestore.Query.DESCENDING)
        if limit is not None:
            query = query.limit(limit)
        return [{**d.to_dict(), "id": d.id} for d in query.stream()]

    def requests(self):
        query = self.db.collection("topupRequests").where(filter=FieldFilter("monthKey", "==", month_key()))
        return [{**d.to_dict(), "id": d.id} for d in query.stream()]

    def throttle(self, user_id, kind, maximum, seconds, global_max=None):
        """Trusted Telegram IDs, not the shared webhook IP; persistent across restarts."""
        keys = [(f"telegram:{kind}:{user_id}", maximum)]
        if global_max:
            keys.append((f"telegram:{kind}:global", global_max))
        refs = [(self.db.collection("_rateLimits").document(hashlib.sha256(k.encode()).hexdigest()), cap) for k, cap in keys]

        @firestore.transactional
        def run(tx):
            snaps = [(ref, cap, ref.get(transaction=tx)) for ref, cap in refs]
            now = int(time.time() * 1000)
            for ref, cap, snap in snaps:
                prior = snap.to_dict() or {}
                active = prior.get("until", 0) > now
                if active and prior.get("count", 0) >= cap:
                    raise TrackerError("Too many attempts. Please try again later.")
                until = prior["until"] if active else now + seconds * 1000
                tx.set(ref, {"count": prior.get("count", 0) + 1 if active else 1, "until": until,
                             "expiresAt": datetime.fromtimestamp(until / 1000, timezone.utc) + timedelta(days=30)})

        run(self.db.transaction())

    def mutate(self, action, user_id, operation_id, **data):
        receipt = self.db.collection("_telegramOperations").document(hashlib.sha256(f"{user_id}:{operation_id}".encode()).hexdigest())
        device = f"telegram:{user_id}"

        @firestore.transactional
        def run(tx):
            prior = receipt.get(transaction=tx)
            if prior.exists:
                saved = prior.to_dict()
                if saved["action"] != action:
                    raise TrackerError("This request was already used. Start again.")
                return saved["result"]
            now = int(time.time() * 1000)
            stamp = datetime.now(timezone.utc)
            month = month_key(stamp)
            result = {}
            message = ""
            event = action

            if action in ("claim", "release"):
                ref = self.db.collection("codes").document(code_id(data.get("id")))
                snap = ref.get(transaction=tx)
                code = snap.to_dict()
                if not code:
                    raise TrackerError("That code no longer exists. Refresh /codes.")
                if action == "claim":
                    name = clean_text(data.get("name"), "staff name", 60)
                    if bucket(code, month) != "live" or code.get("status") != "available":
                        raise TrackerError("This code is no longer available. Choose another from /codes.")
                    code.update(status="taken", takenBy=name, takenDevice=device, takenAt=stamp)
                    # Do not add new fields to legacy code rows: the live browser
                    # rules can whitelist their shape. Retry state lives in receipts.
                    if "claimRequest" in code:
                        code["claimRequest"] = None
                    result = {"code": code["code"], "name": name}
                    event, message = "take", f"{name} took {code['code']}"
                else:
                    if code.get("status") != "taken" or fingerprint(code) != data.get("expected"):
                        raise TrackerError("This code changed after confirmation was requested. Refresh /manager.")
                    tx.set(self.db.collection("releaseHistory").document(), {
                        "code": code["code"], "takenBy": code.get("takenBy") or "-", "takenAt": code.get("takenAt"),
                        "takenDevice": code.get("takenDevice"), "releasedAt": stamp, "source": "telegram",
                    })
                    message = f"Released {code['code']}"
                    code.update(status="available", takenBy=None, takenDevice=None, takenAt=None)
                    if "claimRequest" in code:
                        code["claimRequest"] = None
                self._mirror(tx, ref, code)

            elif action == "requestTopup":
                cooldown = self.db.collection("_requestCooldowns").document(hashlib.sha256(device.encode()).hexdigest())
                snap = cooldown.get(transaction=tx)
                # Also respect a request recorded in the app's shared collection.
                query = self.db.collection("topupRequests").where(filter=FieldFilter("deviceId", "==", device))
                requests = list(query.stream(transaction=tx))
                if (snap.exists and snap.to_dict().get("until", 0) > now) or any((r.to_dict().get("ts") or 0) > now - 6 * 3600 * 1000 for r in requests):
                    raise TrackerError("A top-up request has already been recorded. Try again after six hours.")
                tx.set(cooldown, {"until": now + 6 * 3600 * 1000, "expiresAt": stamp + timedelta(days=30)})
                tx.set(self.db.collection("topupRequests").document(), {"monthKey": month, "ts": now, "deviceId": device})
                event, message = "request", f"Top-up requested for {month}"

            elif action == "add":
                drop = valid_month(data.get("month"))
                if drop < month:
                    raise TrackerError("Choose the current month or a future month.")
                values = data.get("codes", [])
                if not values or len(values) > 200:
                    raise TrackerError("Add 1–200 codes at a time.")
                values = list(dict.fromkeys(clean_text(v.upper(), "code", 64) for v in values))
                # The old app considers unlabelled codes part of this month's drop.
                existing_rows = list(self.db.collection("codes").stream(transaction=tx))
                target = [r.to_dict() for r in existing_rows if (r.to_dict().get("monthKey") or month) == drop]
                existing = {c["code"] for c in target}
                additions = [v for v in values if v not in existing]
                if len(target) + len(additions) > 1000:
                    raise TrackerError("A monthly drop can contain up to 1,000 codes.")
                for index, value in enumerate(additions):
                    ref = self.db.collection("codes").document()
                    self._mirror(tx, ref, {"code": value, "monthKey": drop, "status": "available",
                                          "takenBy": None, "takenAt": None, "takenDevice": None, "createdAt": now + index})
                result = {"count": len(additions)}
                event, message = ("add" if drop == month else "schedule"), f"Added {len(additions)} code(s) for {drop}"

            elif action in ("delete", "label"):
                if action == "label" and data.get("month") != month:
                    raise TrackerError("The current month changed. Request a new labelling confirmation.")
                expected = data.get("expected", {})
                if not expected or len(expected) > 200:
                    raise TrackerError("Select 1–200 codes per batch.")
                refs = [self.db.collection("codes").document(code_id(i)) for i in expected]
                snaps = [ref.get(transaction=tx) for ref in refs]
                for snap in snaps:
                    code = snap.to_dict()
                    if not code or fingerprint(code) != expected[snap.id]:
                        raise TrackerError("A selected code changed. Refresh /manager and select again.")
                    if action == "label" and code.get("monthKey"):
                        raise TrackerError("Only unlabelled codes can be assigned to this month.")
                for snap in snaps:
                    if action == "label":
                        self._mirror(tx, snap.reference, {**snap.to_dict(), "monthKey": month})
                    else:
                        tx.delete(snap.reference)
                        tx.delete(self.db.collection("codeInventory").document(snap.id))
                result = {"count": len(snaps)}
                event, message = ("schedule" if action == "label" else "delete"), f"{'Labelled' if action == 'label' else 'Deleted'} {len(snaps)} code(s)"

            elif action == "clearRequests":
                query = self.db.collection("topupRequests").where(filter=FieldFilter("monthKey", "==", data["month"]))
                snaps = list(query.limit(200).stream(transaction=tx))
                for snap in snaps:
                    tx.delete(snap.reference)
                result = {"count": len(snaps)}
                event, message = "request", f"Cleared {len(snaps)} top-up request(s) for {data['month']}"

            elif action == "prune":
                collection = data["collection"]
                field = "releasedAt" if collection == "releaseHistory" else "ts"
                if collection not in ("activityLog", "releaseHistory", "topupRequests"):
                    raise TrackerError("Invalid cleanup collection.")
                cutoff = datetime.fromtimestamp(data["cutoff"] / 1000, timezone.utc) if field == "releasedAt" else data["cutoff"]
                snaps = list(self.db.collection(collection).where(filter=FieldFilter(field, "<", cutoff)).limit(200).stream(transaction=tx))
                for snap in snaps:
                    tx.delete(snap.reference)
                result = {"count": len(snaps)}
                event, message = "delete", f"Cleared {len(snaps)} old records from {collection}"

            elif action == "export":
                message = "CSV export requested"
            else:
                raise TrackerError("Unknown tracker operation.")

            tx.set(self.db.collection("activityLog").document(), {"type": event, "text": message[:500], "ts": now, "deviceId": device, "source": "telegram"})
            tx.set(receipt, {"action": action, "result": result, "expiresAt": stamp + timedelta(days=30)})
            return result

        return run(self.db.transaction())

    def _mirror(self, tx, ref, code):
        tx.set(ref, code)
        tx.set(self.db.collection("codeInventory").document(ref.id), inventory({**code, "id": ref.id}))

    def cleanup(self, user_id, operation_id, action, **data):
        """Retry-safe chunks, respecting Firestore's 500-write transaction ceiling."""
        totals = {}
        collections = ("activityLog", "releaseHistory", "topupRequests") if action == "prune" else (None,)
        for collection in collections:
            total, index = 0, 0
            while True:
                args = {**data, **({"collection": collection} if collection else {})}
                count = self.mutate(action, user_id, f"{operation_id}:{collection}:{index}", **args)["count"]
                total += count
                if count < 200:
                    break
                index += 1
            totals[collection or "requests"] = total
        return totals
