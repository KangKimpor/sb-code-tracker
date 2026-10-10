"""Shared tracker shapes; all calendar boundaries use Cambodia time."""

import csv
import hashlib
import io
import json
import re
from datetime import datetime, timedelta, timezone

ICT = timezone(timedelta(hours=7))
MONTH_MS = 30 * 24 * 60 * 60 * 1000


class TrackerError(ValueError):
    pass


def month_key(now=None):
    return (now or datetime.now(timezone.utc)).astimezone(ICT).strftime("%Y-%m")


def valid_month(value):
    if not isinstance(value, str) or not re.fullmatch(r"\d{4}-(0[1-9]|1[0-2])", value):
        raise TrackerError("Use a month in YYYY-MM format.")
    return value


def clean_text(value, label, maximum):
    if not isinstance(value, str) or not value.strip() or len(value) > maximum or any(ord(c) < 32 or ord(c) == 127 for c in value):
        raise TrackerError(f"Enter a {label} of 1–{maximum} characters, without control characters.")
    return value.strip()


def code_id(value):
    value = clean_text(value, "code ID", 128)
    if "/" in value or value in (".", ".."):
        raise TrackerError("Invalid code ID. Use an ID from /codes or /manager.")
    return value


def parse_codes(value):
    codes = list(dict.fromkeys(clean_text(v.upper(), "code", 64) for v in re.split(r"[\n,]+", value) if v.strip()))
    if not codes or len(codes) > 200:
        raise TrackerError("Add 1–200 codes at a time, separated by commas or new lines.")
    return codes


def to_ms(value):
    if isinstance(value, datetime):
        return int(value.timestamp() * 1000)
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) else 0


def when(value):
    try:
        return datetime.fromtimestamp(to_ms(value) / 1000, ICT).strftime("%d %b %Y %H:%M ICT") if to_ms(value) else "—"
    except (ValueError, OverflowError, OSError):
        return "—"


def bucket(code, month=None):
    current = month or month_key()
    drop = code.get("monthKey")
    return "live" if not drop or drop == current else "scheduled" if drop > current else "old"


def fingerprint(code):
    # A confirmation must not delete/release a record another interface changed.
    fields = {key: code.get(key) for key in ("code", "monthKey", "status", "takenBy", "takenDevice", "claimRequest", "createdAt")}
    fields["takenAt"] = to_ms(code.get("takenAt"))
    return hashlib.sha256(json.dumps(fields, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def inventory(code):
    return {
        "code": f"Code {code['id'][-6:]}", "monthKey": code.get("monthKey") or "",
        "status": code.get("status", "available"), "takenBy": code.get("takenBy"),
        "takenAt": code.get("takenAt"), "createdAt": code.get("createdAt", 0),
    }


def csv_safe(value):
    value = str(value or "")
    return "'" + value if re.match(r"^[=+\-@\t\r\n]|^[\s\x00-\x1f\x7f]+[=+\-@]", value) else value


def export_csv(codes, history):
    out = io.StringIO(newline="")
    out.write("\ufeff")
    writer = csv.writer(out, quoting=csv.QUOTE_ALL)
    writer.writerow(["Code", "Drop", "Drop Status", "Status", "Taken By", "Taken At", "Released At"])
    for code in codes:
        writer.writerow([csv_safe(code.get("code")), code.get("monthKey") or "", bucket(code), code.get("status"), csv_safe(code.get("takenBy")), when(code.get("takenAt")), ""])
    writer.writerow([])
    writer.writerow(["--- Release History ---"])
    writer.writerow(["Code", "Taken By", "Taken At", "Released At"])
    for row in history:
        writer.writerow([csv_safe(row.get("code")), csv_safe(row.get("takenBy")), when(row.get("takenAt")), when(row.get("releasedAt"))])
    return out.getvalue().encode("utf-8")
