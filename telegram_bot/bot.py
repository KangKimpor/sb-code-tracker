"""SingBuildBot: the tracker in private Telegram chats, using the app's database."""

import asyncio
import hmac
import io
import logging
import os
import re
import secrets
import time
from datetime import datetime, timedelta, timezone
from urllib.parse import urlparse

from google.cloud import firestore
from telegram import BotCommand, InlineKeyboardButton as Button, InlineKeyboardMarkup as Markup
from telegram.ext import Application, CallbackQueryHandler, MessageHandler, filters

from models import (MONTH_MS, TrackerError, bucket, clean_text, code_id, export_csv,
                    fingerprint, month_key, parse_codes, to_ms, valid_month, when)
from store import Store

LOG = logging.getLogger("singbuild-tracker")
PAGE_SIZE = 6
ADMIN_COMMANDS = {"manager", "drops", "add", "schedule", "release", "delete", "select", "delete_selected", "delete_drop", "clear_expired", "label_unlabelled", "remove_unlabelled", "history", "activity", "requests", "clear_requests", "clear_logs", "export"}
HELP = (
    "SB Grab Code Tracker\n\n"
    "/codes [available|taken|all] [page] — browse this month's codes\n"
    "/search <staff name or code label> — search this month's list\n"
    "/status — counts, expiry and top-up queue\n"
    "/name <your full name> — name used for claims\n"
    "/take <ID> [full name] — claim and privately reveal a code\n"
    "/mine — reveal your current Telegram claims again\n"
    "/topup — request more codes (six-hour cooldown)\n"
    "/app — open the website\n"
    "/admin — enter the admin PIN privately\n"
    "/logout — end the admin session\n"
    "/cancel — cancel a prompt or confirmation\n\n"
    "Admin (one-hour session):\n"
    "/manager [all|available|taken] [YYYY-MM|live|expired|unlabelled] [page]\n"
    "/drops — current, staged, expired and unlabelled drops\n"
    "/add [YYYY-MM] <codes separated by commas or new lines>\n"
    "/schedule YYYY-MM <codes> — stage a future drop\n"
    "/release <ID> — release with history\n"
    "/delete <ID ...> — delete specific codes\n"
    "/select all|available|taken|none|<ID ...> — select across the manager\n"
    "/delete_selected — review and delete your selection\n"
    "/delete_drop YYYY-MM — remove a drop\n"
    "/clear_expired — remove expired codes\n"
    "/label_unlabelled — assign legacy codes to this month\n"
    "/remove_unlabelled — remove legacy codes\n"
    "/history [page], /activity [page] — last 30 days\n"
    "/requests — current month's top-up queue\n"
    "/clear_requests — resolve that queue\n"
    "/clear_logs — prune logs, releases and requests older than 30 days\n"
    "/export — CSV of every drop and the last 30 days of releases\n\n"
    "Buttons guide you through these commands. Claims and management changes appear in the website too."
)


def is_admin(context):
    return context.user_data.get("admin_until", 0) > time.time()


def require_admin(context):
    if not is_admin(context):
        context.user_data.pop("selected", None)
        raise TrackerError("Enter the admin PIN using /admin. Sessions last one hour.")


def remember(context, action):
    now = time.time()
    controls = context.user_data.setdefault("controls", {})
    for key in list(controls):
        if controls[key][0] < now:
            del controls[key]
    while len(controls) >= 150:
        del controls[next(iter(controls))]
    key = secrets.token_hex(8)
    controls[key] = (now + 300, action)
    return f"do:{key}"


def command_button(label, command):
    return Button(label, callback_data="cmd:" + command)


def action_button(context, label, action):
    return Button(label, callback_data=remember(context, action))


def menu(context):
    rows = [
        [command_button("Available codes", "codes"), command_button("Taken codes", "codes taken")],
        [command_button("My codes", "mine"), command_button("Status / refresh", "status")],
        [command_button("Set my name", "name"), command_button("Request top-up", "topup")],
        [Button("Open app", url=context.bot_data["app_url"])],
    ]
    if is_admin(context):
        rows += [
            [command_button("Code manager", "manager"), command_button("Monthly drops", "drops")],
            [command_button("Add / bulk add", "add"), command_button("Schedule drop", "schedule")],
            [command_button("Release history", "history"), command_button("Activity", "activity")],
            [command_button("Top-up queue", "requests"), command_button("Export CSV", "export")],
            [command_button("Clear old logs", "clear_logs"), command_button("Log out", "logout")],
        ]
    else:
        rows.append([command_button("Admin", "admin"), command_button("Help", "help")])
    return Markup(rows)


async def send(update, context, text, keyboard=None):
    # No Markdown/HTML parsing: user-entered names and vouchers are literal text.
    for start in range(0, len(text), 3800):
        await context.bot.send_message(update.effective_chat.id, text[start:start + 3800],
                                       reply_markup=keyboard if start + 3800 >= len(text) else None)


async def offload(context, method, *args, **kwargs):
    return await asyncio.to_thread(getattr(context.bot_data["store"], method), *args, **kwargs)


async def confirm(update, context, action, text):
    action = {**action, "operation": f"confirm:{update.update_id}:{secrets.token_hex(8)}"}
    await send(update, context, text + "\n\nConfirm within five minutes. /cancel cancels pending confirmations.", Markup([
        [action_button(context, "Confirm", {"kind": "commit", **action}), command_button("Cancel", "cancel")]
    ]))


async def list_codes(update, context, args, manager=False, search=None):
    codes = await offload(context, "codes")
    status, scope, page = "all" if manager else "available", "all" if manager else "live", 1
    for arg in args:
        if arg in ("all", "available", "taken"):
            status = arg
        elif manager and (arg in ("live", "expired", "unlabelled") or re.fullmatch(r"\d{4}-\d{2}", arg)):
            scope = valid_month(arg) if arg[0].isdigit() else arg
        elif arg.isdigit():
            page = int(arg)
        else:
            raise TrackerError("Use /manager [all|available|taken] [YYYY-MM|live|expired|unlabelled] [page]." if manager else "Use /codes [available|taken|all] [page].")
    selected = context.user_data.setdefault("selected", set()) if manager else set()
    context.user_data["manager_scope"] = scope if manager else context.user_data.get("manager_scope", "all")

    def in_scope(c):
        return scope == "all" or (scope == "unlabelled" and not c.get("monthKey")) or (scope == "expired" and bucket(c) == "old") or (scope == "live" and bucket(c) == "live") or c.get("monthKey") == scope

    rows = [c for c in codes if in_scope(c) and (status == "all" or c.get("status") == status)]
    if search:
        rows = [c for c in rows if search.casefold() in f"{c.get('takenBy', '')} Code {c['id'][-6:]}".casefold()]
    if status == "all":
        rows.sort(key=lambda c: to_ms(c.get("takenAt")) or c.get("createdAt") or 0, reverse=True)
    pages = max(1, (len(rows) + PAGE_SIZE - 1) // PAGE_SIZE)
    page = max(1, min(page, pages))
    heading = f"{'Code manager' if manager else month_key() + ' codes'} · {status} · {scope}\n{len(rows)} code(s) · page {page}/{pages}"
    buttons = []
    for code in rows[(page - 1) * PAGE_SIZE:page * PAGE_SIZE]:
        value = code.get("code", "") if manager else f"Code {code['id'][-6:]}"
        detail = f"\n\n{value} · {code.get('status')}\nID: {code['id']}"
        if manager:
            detail += f"\nDrop: {code.get('monthKey') or 'unlabelled'} ({bucket(code)})"
        if code.get("status") == "taken":
            detail += f"\n{code.get('takenBy') or '—'} · {when(code.get('takenAt'))}"
            if manager:
                detail += f"\nDevice: {code.get('takenDevice') or '—'}"
        heading += detail
        row = []
        if manager:
            row.append(action_button(context, ("✓ " if code["id"] in selected else "+ ") + "Select " + code["id"][-6:], {"kind": "select", "id": code["id"], "status": status, "scope": scope, "page": page}))
            if code.get("status") == "taken":
                row.append(action_button(context, "Release", {"kind": "command", "command": "release " + code["id"]}))
            row.append(action_button(context, "Delete", {"kind": "command", "command": "delete " + code["id"]}))
        elif code.get("status") == "available":
            row.append(action_button(context, "Claim " + code["id"][-6:], {"kind": "command", "command": "take " + code["id"]}))
        if row:
            buttons.append(row)
    base = "manager" if manager else "codes"
    # Search navigation repeats the search rather than silently losing its filter.
    nav = []
    for label, target in (("← Previous", page - 1), ("Next →", page + 1)):
        if 1 <= target <= pages:
            nav.append(action_button(context, label, {"kind": "list", "args": [status, scope, str(target)] if manager else [status, str(target)], "manager": manager, "search": search}))
    if nav:
        buttons.append(nav)
    buttons.append([command_button("Refresh", f"{base} {status} " + (scope if manager else "")), command_button("Menu", "start")])
    if manager:
        heading += f"\n\nSelected: {len(selected)}. /select all, available, taken or none selects across this scope."
        buttons += [[command_button("Select all in scope", "select all"), command_button("Clear selection", "select none")],
                    [command_button("Delete selection", "delete_selected")]]
    await send(update, context, heading, Markup(buttons))


async def show_records(update, context, command, args):
    page = int(args[0]) if args and args[0].isdigit() else 1
    page = max(1, min(page, 1000))
    cutoff = int(time.time() * 1000) - MONTH_MS
    collection, field = ("releaseHistory", "releasedAt") if command == "history" else ("activityLog", "ts")
    bound = datetime.fromtimestamp(cutoff / 1000, timezone.utc) if command == "history" else cutoff
    rows = await offload(context, "rows", collection, field, bound, page * PAGE_SIZE + 1)
    text = f"{'Release history' if command == 'history' else 'Activity'} · last 30 days · page {page}"
    for row in rows[(page - 1) * PAGE_SIZE:page * PAGE_SIZE]:
        if command == "history":
            text += f"\n\n{row.get('code')} · {row.get('takenBy') or '—'}\nTaken: {when(row.get('takenAt'))}\nReleased: {when(row.get('releasedAt'))}\nDevice: {row.get('takenDevice') or '—'}"
        else:
            text += f"\n\n{when(row.get('ts'))} · {row.get('type')}\n{row.get('text')}\nSource: {row.get('source') or 'app'} · {row.get('deviceId') or '—'}"
    buttons = []
    if page > 1:
        buttons.append(command_button("← Previous", f"{command} {page - 1}"))
    if len(rows) > page * PAGE_SIZE:
        buttons.append(command_button("Next →", f"{command} {page + 1}"))
    await send(update, context, text + ("\n\nNo records on this page." if len(rows) <= (page - 1) * PAGE_SIZE else ""), Markup([buttons, [command_button("Menu", "start")]] if buttons else [[command_button("Menu", "start")]]))


async def dispatch(update, context, command, argument=""):
    uid = update.effective_user.id
    args = argument.split()
    if command in ADMIN_COMMANDS:
        require_admin(context)
    if command in ("start", "help"):
        await send(update, context, HELP if command == "help" else "SB Grab Code Tracker\nUse the same code inventory here or in the app.\n" + ("Admin session active." if is_admin(context) else "Choose an action below."), menu(context))
    elif command == "app":
        await send(update, context, context.bot_data["app_url"], menu(context))
    elif command == "cancel":
        context.user_data.pop("prompt", None)
        context.user_data["controls"] = {}
        await send(update, context, "Pending actions cancelled.", menu(context))
    elif command == "logout":
        context.user_data.clear()
        await send(update, context, "Admin session ended.", menu(context))
    elif command == "admin":
        if uid not in context.bot_data["admin_ids"]:
            raise TrackerError("Your Telegram account is not configured for admin access. Ask the tracker owner to add your numeric user ID.")
        context.user_data["prompt"] = (time.time() + 300, "pin", {})
        await send(update, context, "Send the six-digit admin PIN as your next message. I will try to delete that message. /cancel cancels.")
    elif command == "name":
        if not argument:
            context.user_data["prompt"] = (time.time() + 300, "name", {})
            await send(update, context, "Send your full staff name. /cancel cancels.")
        else:
            context.user_data["name"] = clean_text(argument, "staff name", 60)
            await send(update, context, f"Claims will use: {context.user_data['name']}", menu(context))
    elif command == "status":
        codes = await offload(context, "codes")
        live = [c for c in codes if bucket(c) == "live"]
        available = sum(c.get("status") == "available" for c in live)
        requests = await offload(context, "requests")
        month = month_key()
        year, number = map(int, month.split("-"))
        end = datetime(year + (number == 12), 1 if number == 12 else number + 1, 1, tzinfo=timezone(timedelta(hours=7))) - timedelta(days=1)
        text = f"{month} drop\n{available} available · {len(live) - available} taken · {len(live)} total\nExpires: {end:%d %b %Y} (ICT)\nWaiting for top-up: {len({r.get('deviceId') or r['id'] for r in requests})}"
        if available <= 3:
            text += "\nLow stock. Use /topup to request more codes."
        if is_admin(context):
            text += f"\nScheduled: {sum(bucket(c) == 'scheduled' for c in codes)} · Expired: {sum(bucket(c) == 'old' for c in codes)} · Unlabelled: {sum(not c.get('monthKey') for c in codes)}"
        await send(update, context, text, menu(context))
    elif command in ("codes", "manager", "search"):
        if command == "search" and not argument:
            raise TrackerError("Use /search <staff name or code label>.")
        await list_codes(update, context, [] if command == "search" else args, manager=command == "manager", search=argument if command == "search" else None)
    elif command == "take":
        if not args:
            raise TrackerError("Choose a Claim button from /codes or use /take <ID> [full name].")
        target = code_id(args[0])
        name = " ".join(args[1:]) if len(args) > 1 else context.user_data.get("name")
        if not name:
            context.user_data["prompt"] = (time.time() + 300, "claim_name", {"id": target})
            await send(update, context, "Send your full staff name to claim this code. /cancel cancels.")
        else:
            name = clean_text(name, "staff name", 60)
            context.user_data["name"] = name
            await confirm(update, context, {"action": "claim", "data": {"id": target, "name": name}}, f"Claim Code {target[-6:]} for {name}? The voucher is revealed after the claim is saved.")
    elif command == "mine":
        rows = [c for c in await offload(context, "codes") if bucket(c) == "live" and c.get("status") == "taken" and c.get("takenDevice") == f"telegram:{uid}"]
        await send(update, context, "Your current Telegram claims\n" + ("\n\n".join(f"{c['code']} · {c.get('takenBy')}\n{when(c.get('takenAt'))}" for c in rows) or "No current claims. Choose one from /codes."), menu(context))
    elif command == "topup":
        await confirm(update, context, {"action": "requestTopup", "data": {}}, f"Request more codes for {month_key()}? This records your request in the admin queue shared with the app.")
    elif command in ("add", "schedule"):
        if not argument:
            context.user_data["prompt"] = (time.time() + 300, command, {})
            await send(update, context, "Send YYYY-MM followed by codes separated by commas or new lines." if command == "schedule" else "Send codes separated by commas or new lines. Optionally start with YYYY-MM to choose a drop.")
            return
        match = re.match(r"^(\d{4}-\d{2})(?:\s+|$)", argument)
        if command == "schedule" and not match:
            raise TrackerError("Use /schedule YYYY-MM <codes>.")
        month = valid_month(match[1]) if match else month_key()
        values = parse_codes(argument[match.end():] if match else argument)
        result = await offload(context, "mutate", "add", uid, f"add:{update.update_id}", month=month, codes=values)
        await send(update, context, f"Added {result['count']} code(s) for {month}. Duplicates in the same drop were skipped.", menu(context))
    elif command == "drops":
        groups = {}
        for c in await offload(context, "codes"):
            groups.setdefault(c.get("monthKey") or "unlabelled", []).append(c)
        text, buttons = "Monthly drops", []
        for month, codes in sorted(groups.items()):
            text += f"\n{month}: {len(codes)} total · {sum(c.get('status') == 'available' for c in codes)} available · {bucket(codes[0])}"
            buttons.append([command_button("Review " + month, "manager all " + month)] +
                           ([command_button("Delete drop", "delete_drop " + month)] if month != "unlabelled" else []))
        buttons += [[command_button("Remove expired", "clear_expired")],
                    [command_button("Label unlabelled", "label_unlabelled"), command_button("Remove unlabelled", "remove_unlabelled")],
                    [command_button("Menu", "start")]]
        await send(update, context, text, Markup(buttons))
    elif command == "select":
        codes = await offload(context, "codes")
        scope = context.user_data.get("manager_scope", "all")
        scoped = [c for c in codes if scope == "all" or (scope == "live" and bucket(c) == "live") or (scope == "expired" and bucket(c) == "old") or (scope == "unlabelled" and not c.get("monthKey")) or c.get("monthKey") == scope]
        if argument == "none":
            selection = set()
        elif argument in ("all", "available", "taken"):
            selection = {c["id"] for c in scoped if argument == "all" or c.get("status") == argument}
        else:
            selection = {code_id(v) for v in args}
            if not selection or not selection <= {c["id"] for c in codes}:
                raise TrackerError("Use /select all, available, taken, none, or valid code IDs.")
        context.user_data["selected"] = selection
        await send(update, context, f"Selected {len(selection)} code(s). Scope: {scope}.", Markup([[command_button("Review manager", "manager all " + scope), command_button("Delete selection", "delete_selected")]]))
    elif command in ("release", "delete", "delete_selected", "delete_drop", "clear_expired", "label_unlabelled", "remove_unlabelled"):
        codes = await offload(context, "codes")
        if command in ("release", "delete"):
            ids = {code_id(v) for v in args}
            if not ids or (command == "release" and len(ids) != 1):
                raise TrackerError(f"Use /{command} <ID{' ...' if command == 'delete' else ''}>.")
            targets = [c for c in codes if c["id"] in ids]
            if len(targets) != len(ids):
                raise TrackerError("A code ID was not found. Refresh /manager.")
        elif command == "delete_selected":
            ids = context.user_data.get("selected", set())
            targets = [c for c in codes if c["id"] in ids]
        elif command == "delete_drop":
            drop = valid_month(argument)
            targets = [c for c in codes if c.get("monthKey") == drop]
        else:
            targets = [c for c in codes if bucket(c) == "old"] if command == "clear_expired" else [c for c in codes if not c.get("monthKey")]
        if not targets:
            raise TrackerError("No matching codes. Refresh /manager or change the selection.")
        if command == "release":
            c = targets[0]
            if c.get("status") != "taken":
                raise TrackerError("That code is not taken.")
            await confirm(update, context, {"action": "release", "data": {"id": c["id"], "expected": fingerprint(c)}}, f"Release {c['code']} taken by {c.get('takenBy')} at {when(c.get('takenAt'))}? The previous claim will be saved in release history.")
        else:
            action = "label" if command == "label_unlabelled" else "delete"
            expected = {c["id"]: fingerprint(c) for c in targets}
            preview = "\n".join(f"{c['code']} · {c.get('monthKey') or 'unlabelled'} · {c.get('status')} · {c.get('takenBy') or '—'}" for c in targets[:10])
            label = f"Assign {len(targets)} code(s) to {month_key()}" if action == "label" else f"Permanently delete {len(targets)} code(s)"
            await confirm(update, context, {"action": action, "data": {"expected": expected, **({"month": month_key()} if action == "label" else {})}}, label + "?\n" + preview + (f"\n…and {len(targets) - 10} more." if len(targets) > 10 else ""))
    elif command in ("history", "activity"):
        await show_records(update, context, command, args)
    elif command == "requests":
        rows = sorted(await offload(context, "requests"), key=lambda r: r.get("ts", 0), reverse=True)
        pages = max(1, (len(rows) + PAGE_SIZE - 1) // PAGE_SIZE)
        page = max(1, min(int(args[0]) if args and args[0].isdigit() else 1, pages))
        text = f"{month_key()} top-up queue · {len(rows)} request(s) · page {page}/{pages}\n"
        text += "\n".join(f"{when(r.get('ts'))} · {r.get('deviceId') or '—'}" for r in rows[(page - 1) * PAGE_SIZE:page * PAGE_SIZE]) or "No requests."
        nav = ([command_button("← Previous", f"requests {page - 1}")] if page > 1 else []) + ([command_button("Next →", f"requests {page + 1}")] if page < pages else [])
        await send(update, context, text, Markup(([nav] if nav else []) + [[command_button("Resolve queue", "clear_requests"), command_button("Menu", "start")]]))
    elif command in ("clear_requests", "clear_logs"):
        if command == "clear_requests":
            action, data = "clearRequests", {"month": month_key()}
            text = f"Clear the top-up queue for {data['month']}? New requests remain possible after their cooldown."
        else:
            action, data = "prune", {"cutoff": int(time.time() * 1000) - MONTH_MS}
            text = "Permanently delete activity, release history and top-up requests older than 30 days?"
        await confirm(update, context, {"action": action, "data": data}, text)
    elif command == "export":
        codes = await offload(context, "codes")
        history = await offload(context, "rows", "releaseHistory", "releasedAt", datetime.now(timezone.utc) - timedelta(days=30), None)
        await offload(context, "mutate", "export", uid, f"export:{update.update_id}")
        await context.bot.send_document(uid, io.BytesIO(export_csv(codes, history)), filename=f"codes-export-{datetime.now(timezone.utc):%Y-%m-%d}.csv", caption="All drops and the last 30 days of release history.")
    else:
        raise TrackerError("Unknown command. Use /help or /start.")


async def commit(update, context, entry):
    action, data = entry["action"], entry["data"]
    uid = update.effective_user.id
    if action not in ("claim", "requestTopup"):
        require_admin(context)
    else:
        await offload(context, "throttle", uid, action, 30, 3600, 300)
    if action in ("delete", "label"):
        expected = list(data["expected"].items())
        done = 0
        try:
            for index in range(0, len(expected), 200):
                require_admin(context)
                result = await offload(context, "mutate", action, uid, f"{entry['operation']}:{index}", **{**data, "expected": dict(expected[index:index + 200])})
                done += result["count"]
        except Exception:
            if done:
                await send(update, context, f"{done} code(s) completed before the next batch failed. Refresh /manager to review the remaining codes.")
            raise
        context.user_data["selected"] = set()
        await send(update, context, f"{'Assigned to this month' if action == 'label' else 'Deleted'}: {done} code(s).", menu(context))
    elif action in ("clearRequests", "prune"):
        result = await offload(context, "cleanup", uid, entry["operation"], action, **data)
        await send(update, context, "Cleared: " + ", ".join(f"{count} {name}" for name, count in result.items()), menu(context))
    else:
        result = await offload(context, "mutate", action, uid, entry["operation"], **data)
        if action == "claim":
            await send(update, context, f"Your code: {result['code']}\nClaimed for: {result['name']}\nSelect and copy the code. Use /mine to reveal it again.", menu(context))
        else:
            await send(update, context, "Top-up request recorded in the shared admin queue." if action == "requestTopup" else "Code released and history saved.", menu(context))


async def handle(update, context):
    # A forged username never grants access. Everything sensitive stays in DMs.
    if not update.effective_chat or not update.effective_user or update.effective_user.is_bot:
        return
    if update.effective_chat.type != "private":
        if update.callback_query:
            await update.callback_query.answer("Open a private chat with the bot.", show_alert=True)
        else:
            await send(update, context, "Use SB Grab Code Tracker in a private chat.", Markup([[Button("Open bot", url="https://t.me/" + context.bot_data["username"])]]))
        return
    try:
        await offload(context, "throttle", update.effective_user.id, "commands", 120, 3600)
        if update.callback_query:
            await update.callback_query.answer()
            value = update.callback_query.data or ""
            if value.startswith("cmd:"):
                command, _, argument = value[4:].partition(" ")
                await dispatch(update, context, command, argument)
            elif value.startswith("do:"):
                expiry, entry = context.user_data.get("controls", {}).get(value[3:], (0, {}))
                if expiry < time.time():
                    raise TrackerError("That button expired. Refresh /codes or /manager.")
                if entry["kind"] == "commit":
                    await commit(update, context, entry)
                elif entry["kind"] == "command":
                    command, _, argument = entry["command"].partition(" ")
                    await dispatch(update, context, command, argument)
                elif entry["kind"] == "select":
                    require_admin(context)
                    selected = context.user_data.setdefault("selected", set())
                    selected.remove(entry["id"]) if entry["id"] in selected else selected.add(entry["id"])
                    await list_codes(update, context, [entry["status"], entry["scope"], str(entry["page"])], manager=True)
                elif entry["kind"] == "list":
                    if entry["manager"]:
                        require_admin(context)
                    await list_codes(update, context, entry["args"], entry["manager"], entry.get("search"))
            else:
                raise TrackerError("Unknown button. Use /start.")
            return

        text = (update.effective_message.text or "").strip()
        if text.startswith("/"):
            # Splitting on whitespace also supports a newline after a command.
            parts = text.split(maxsplit=1)
            name, argument = parts[0], parts[1] if len(parts) > 1 else ""
            await dispatch(update, context, name[1:].split("@")[0].lower(), argument)
            return
        expiry, prompt, data = context.user_data.pop("prompt", (0, "", {}))
        if expiry < time.time():
            raise TrackerError("Choose an action from /start. Prompts expire after five minutes.")
        if prompt == "pin":
            # Delete before validation; never echo or log PINs.
            try:
                await update.effective_message.delete()
            except Exception:
                pass  # Telegram deletion may be unavailable; no sensitive error logging.
            if update.effective_user.id not in context.bot_data["admin_ids"]:
                raise TrackerError("Your Telegram account is not configured for admin access.")
            await offload(context, "throttle", update.effective_user.id, "login", 5, 900, 100)
            if not re.fullmatch(r"\d{6}", text) or not hmac.compare_digest(text, context.bot_data["pin"]):
                raise TrackerError("Incorrect PIN. Use /admin to try again.")
            context.user_data["admin_until"] = time.time() + 3600
            await send(update, context, "Admin access enabled for one hour.", menu(context))
        elif prompt == "claim_name":
            await dispatch(update, context, "take", data["id"] + " " + text)
        else:
            await dispatch(update, context, prompt, text)
    except TrackerError as exc:
        await send(update, context, str(exc))
    except Exception:
        # SDK/HTTP exceptions can contain credentials or voucher data. Log class only.
        LOG.error("Tracker request failed; update %s", update.update_id)
        await send(update, context, "Could not complete this request. Try the same confirmation again or refresh the list. Use /mine to recover a claim whose reply was lost.")


async def post_init(application):
    me = await application.bot.get_me()
    if (me.username or "").casefold() != application.bot_data["username"].casefold():
        raise RuntimeError("The bot token does not belong to the configured TELEGRAM_BOT_USERNAME.")
    await application.bot.set_my_commands([BotCommand(c, d) for c, d in (
        ("start", "Open tracker menu"), ("codes", "Browse and claim current codes"),
        ("status", "Stock and top-up status"), ("name", "Set your staff name"),
        ("mine", "Reveal your Telegram claims"), ("topup", "Request more codes"),
        ("app", "Open tracker app"), ("admin", "Admin PIN login"), ("help", "All commands"),
        ("cancel", "Cancel pending actions"), ("logout", "End admin session"),
    )])


async def on_error(update, context):
    LOG.error("Telegram delivery failed (%s).", type(context.error).__name__)


def build_application():
    token, pin = os.environ["TELEGRAM_BOT_TOKEN"], os.environ["ADMIN_PIN"]
    if not re.fullmatch(r"\d{6}", pin):
        raise RuntimeError("ADMIN_PIN must be the tracker's six-digit PIN.")
    admin_ids = {int(i.strip()) for i in os.environ["ADMIN_USER_IDS"].split(",") if i.strip()}
    if not admin_ids or any(i <= 0 for i in admin_ids):
        raise RuntimeError("Set ADMIN_USER_IDS to the numeric Telegram IDs of tracker admins.")
    app_url = os.environ.get("TRACKER_APP_URL", "https://sb-code-tracker.web.app")
    if urlparse(app_url).scheme != "https" or not urlparse(app_url).netloc:
        raise RuntimeError("TRACKER_APP_URL must be an HTTPS URL.")
    username = os.environ.get("TELEGRAM_BOT_USERNAME", "SingBuildBot")
    if not re.fullmatch(r"[A-Za-z0-9_]{5,32}", username):
        raise RuntimeError("Invalid TELEGRAM_BOT_USERNAME.")
    application = Application.builder().token(token).post_init(post_init).build()
    application.bot_data.update(store=Store(firestore.Client(project=os.environ.get("FIREBASE_PROJECT_ID", "sb-code-tracker"))),
                                pin=pin, admin_ids=admin_ids, app_url=app_url, username=username)
    application.add_handler(CallbackQueryHandler(handle))
    application.add_handler(MessageHandler(filters.TEXT, handle))
    application.add_error_handler(on_error)
    return application


def main():
    # HTTPX INFO logs contain the bot token in the request URL.
    logging.basicConfig(level=logging.WARNING)
    application = build_application()
    host = os.environ.get("WEBHOOK_URL", "").rstrip("/")
    if host:
        secret = os.environ.get("WEBHOOK_SECRET", "")
        if not re.fullmatch(r"[A-Za-z0-9_-]{32,128}", secret):
            raise RuntimeError("WEBHOOK_SECRET must be 32–128 random letters, numbers, underscores or hyphens.")
        if urlparse(host).scheme != "https" or urlparse(host).path or not urlparse(host).netloc:
            raise RuntimeError("WEBHOOK_URL must be a public HTTPS host without a path.")
        application.run_webhook(listen="0.0.0.0", port=int(os.environ.get("PORT", "10000")),
                                url_path="telegram", webhook_url=host + "/telegram",
                                secret_token=secret, allowed_updates=["message", "callback_query"],
                                max_connections=1, drop_pending_updates=False)
    else:
        application.run_polling(allowed_updates=["message", "callback_query"], drop_pending_updates=False)


if __name__ == "__main__":
    main()
