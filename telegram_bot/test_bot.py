"""Offline behavior checks: no Telegram calls, real credentials or live writes."""

import time
import unittest
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import bot
from models import TrackerError, export_csv, fingerprint, month_key, parse_codes


def context():
    store = Mock()
    store.codes.return_value = []
    store.requests.return_value = []
    return SimpleNamespace(user_data={}, bot_data={"store": store, "pin": "123456", "admin_ids": {7}, "username": "SingBuildBot", "app_url": "https://sb-code-tracker.web.app"}, bot=SimpleNamespace(send_message=AsyncMock(), send_document=AsyncMock()))


def update(text="/start", uid=7, chat_type="private", callback=None):
    message = SimpleNamespace(text=text, delete=AsyncMock())
    query = SimpleNamespace(data=callback, answer=AsyncMock()) if callback else None
    return SimpleNamespace(update_id=1234, effective_chat=SimpleNamespace(id=uid, type=chat_type), effective_user=SimpleNamespace(id=uid, is_bot=False), effective_message=message, callback_query=query)


class ModelTests(unittest.TestCase):
    def test_ict_rollover(self):
        self.assertEqual(month_key(datetime(2026, 10, 31, 16, 59, tzinfo=timezone.utc)), "2026-10")
        self.assertEqual(month_key(datetime(2026, 10, 31, 17, 0, tzinfo=timezone.utc)), "2026-11")

    def test_bulk_normalizes_deduplicates_and_rejects_bad_input(self):
        self.assertEqual(parse_codes(" abc,ABC\ndef "), ["ABC", "DEF"])
        for value in ("", "ABC\tDEF", "X" * 65, ",".join(str(i) for i in range(201))):
            with self.assertRaises(TrackerError):
                parse_codes(value)

    def test_confirmation_fingerprint_catches_app_claim(self):
        original = {"code": "SECRET", "status": "available"}
        self.assertNotEqual(fingerprint(original), fingerprint({**original, "status": "taken", "takenDevice": "browser"}))

    def test_csv_formula_and_utf8_safety(self):
        result = export_csv([{"code": "=FORMULA", "takenBy": "\t+BAD", "status": "taken"}], [{"code": "@EVIL", "takenBy": "សុខលីម"}]).decode()
        self.assertTrue(result.startswith("\ufeff"))
        for escaped in ("'=FORMULA", "'\t+BAD", "'@EVIL", "សុខលីម"):
            self.assertIn(escaped, result)


class HandlerTests(unittest.IsolatedAsyncioTestCase):
    async def test_groups_never_get_vouchers_or_admin_actions(self):
        ctx = context()
        ctx.user_data["admin_until"] = time.time() + 3600
        await bot.handle(update("/export", chat_type="supergroup"), ctx)
        ctx.bot_data["store"].codes.assert_not_called()
        ctx.bot.send_document.assert_not_called()
        self.assertIn("private chat", ctx.bot.send_message.call_args.args[1])

    async def test_pin_deletion_and_numeric_allowlist(self):
        ctx = context()
        await bot.handle(update("/admin"), ctx)
        incoming = update("123456")
        await bot.handle(incoming, ctx)
        incoming.effective_message.delete.assert_awaited_once()
        self.assertTrue(bot.is_admin(ctx))
        self.assertNotIn("123456", " ".join(c.args[1] for c in ctx.bot.send_message.call_args_list))
        other = context()
        await bot.handle(update("/admin", uid=9), other)
        self.assertNotIn("prompt", other.user_data)

    async def test_wrong_pin_is_throttled_and_no_session(self):
        ctx = context()
        await bot.handle(update("/admin"), ctx)
        await bot.handle(update("000000"), ctx)
        self.assertFalse(bot.is_admin(ctx))
        self.assertTrue(any(call.args[1] == "login" for call in ctx.bot_data["store"].throttle.call_args_list))

    async def test_expired_admin_cannot_export_or_confirm(self):
        ctx = context()
        ctx.user_data["admin_until"] = time.time() - 1
        await bot.handle(update("/export"), ctx)
        ctx.bot_data["store"].codes.assert_not_called()
        token = bot.remember(ctx, {"kind": "commit", "action": "release", "operation": "op", "data": {"id": "code"}})
        await bot.handle(update(callback=token), ctx)
        ctx.bot_data["store"].mutate.assert_not_called()

    async def test_confirmation_tokens_belong_to_one_user_and_cancel_invalidates(self):
        owner, other = context(), context()
        token = bot.remember(owner, {"kind": "commit", "action": "claim", "operation": "op", "data": {"id": "code", "name": "Staff"}})
        await bot.handle(update(uid=9, callback=token), other)
        other.bot_data["store"].mutate.assert_not_called()
        await bot.handle(update("/cancel"), owner)
        await bot.handle(update(callback=token), owner)
        owner.bot_data["store"].mutate.assert_not_called()

    async def test_staff_list_masks_vouchers_and_hides_other_months(self):
        ctx = context()
        ctx.bot_data["store"].codes.return_value = [
            {"id": "current", "code": "SECRET-CURRENT", "monthKey": month_key(), "status": "available"},
            {"id": "legacy", "code": "SECRET-LEGACY", "status": "available"},
            {"id": "future", "code": "SECRET-FUTURE", "monthKey": "9999-12", "status": "available"},
            {"id": "past", "code": "SECRET-PAST", "monthKey": "2000-01", "status": "available"},
        ]
        await bot.handle(update("/codes"), ctx)
        text = ctx.bot.send_message.call_args.args[1]
        self.assertNotIn("SECRET", text)
        self.assertIn("current", text)
        self.assertIn("legacy", text)
        self.assertNotIn("future", text)
        self.assertNotIn("past", text)

    async def test_claim_is_not_revealed_until_confirmed_and_saved(self):
        ctx = context()
        await bot.handle(update("/take current Full Name"), ctx)
        ctx.bot_data["store"].mutate.assert_not_called()
        control = next(key for key, (_, value) in ctx.user_data["controls"].items() if value["kind"] == "commit")
        ctx.bot_data["store"].mutate.return_value = {"code": "SAVED-VOUCHER", "name": "Full Name"}
        await bot.handle(update(callback="do:" + control), ctx)
        self.assertIn("SAVED-VOUCHER", ctx.bot.send_message.call_args.args[1])

    async def test_failed_claim_never_reveals_voucher(self):
        ctx = context()
        token = bot.remember(ctx, {"kind": "commit", "action": "claim", "operation": "op", "data": {"id": "current", "name": "Staff"}})
        ctx.bot_data["store"].mutate.side_effect = TrackerError("Already taken")
        await bot.handle(update(callback=token), ctx)
        self.assertEqual(ctx.bot.send_message.call_args.args[1], "Already taken")

    async def test_mine_does_not_match_only_by_staff_name(self):
        ctx = context()
        ctx.bot_data["store"].codes.return_value = [
            {"id": "mine", "code": "MINE", "status": "taken", "takenBy": "Same Name", "takenDevice": "telegram:7"},
            {"id": "other", "code": "OTHER-SECRET", "status": "taken", "takenBy": "Same Name", "takenDevice": "telegram:8"},
            {"id": "browser", "code": "BROWSER-SECRET", "status": "taken", "takenBy": "Same Name", "takenDevice": "browser"},
        ]
        await bot.handle(update("/mine"), ctx)
        text = ctx.bot.send_message.call_args.args[1]
        self.assertIn("MINE", text)
        self.assertNotIn("OTHER-SECRET", text)
        self.assertNotIn("BROWSER-SECRET", text)

    async def test_buttons_and_commands_both_require_admin(self):
        ctx = context()
        for command in bot.ADMIN_COMMANDS:
            await bot.handle(update(callback="cmd:" + command), ctx)
        ctx.bot_data["store"].codes.assert_not_called()
        ctx.bot_data["store"].mutate.assert_not_called()
        ctx.bot.send_document.assert_not_called()

    async def test_large_selection_is_chunked_and_partial_failure_reported(self):
        ctx = context()
        ctx.user_data["admin_until"] = time.time() + 3600
        entry = {"kind": "commit", "action": "delete", "operation": "fixed", "data": {"expected": {str(i): "hash" for i in range(401)}}}
        ctx.bot_data["store"].mutate.side_effect = [{"count": 200}, TrackerError("Changed")]
        token = bot.remember(ctx, entry)
        await bot.handle(update(callback=token), ctx)
        self.assertEqual(len(ctx.bot_data["store"].mutate.call_args_list), 2)
        self.assertTrue(any("200 code(s) completed" in c.args[1] for c in ctx.bot.send_message.call_args_list))


if __name__ == "__main__":
    unittest.main()
