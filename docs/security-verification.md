# Security fix verification

Implemented and verified locally. Production rollout is pending. After reconnecting Firebase on 2026-10-09, live legacy rules were verified, the new inventory was found empty, and the Cloud Functions API was found disabled. The production frontend is temporarily restored to compatibility with that existing setup; see [connection-recovery.md](connection-recovery.md). Server-enforced admin access is not yet active.

| Finding | Change | Evidence |
| --- | --- | --- |
| Anonymous admin writes/deletions | Private server PIN issues an expiring Firebase admin claim; every admin action checks it; all browser writes denied | Backend denial tests; Firestore unauthenticated, normal-user and expired-admin tests; real custom-token sign-in against Auth emulator |
| Raw unclaimed/future voucher reads | Staff list uses a separate sanitized inventory; raw codes require an admin claim; server returns a voucher only after committing its claim | Denied raw reads, sanitized inventory, concurrent claim winner and secret nonce retry tests |
| Forged audit/history | Server constructs events from stored data; claim and release events commit with their corresponding state change | Direct forged writes denied even for admins; atomic claim/release and injected-field tests |
| Anonymous quota exhaustion via code creation | Creation is admin-only, bounded to 200 codes per request and 1,000 per month; public query and accepted mutation rates are bounded | Denied direct creation, PIN/global/IP throttling and bounded-list tests; source review of monthly cap |
| Rejected normal logs | Browser logger removed; server creates trusted records including device ID | Successful claim/release logs with `source: server` |
| Malformed history timestamp crash | Timestamp helper accepts actual SDK timestamps or finite milliseconds; server sanitizes old malformed timestamps during release | Object/coercion regression tests and malformed-release emulator test |
| CSV formula control-prefix bypass | Every exported cell uses formula neutralization, including whitespace/control prefixes | CSV regression cases |
| Browser-clock-driven deletion | Automatic expiry moved to a server scheduler using ICT; manual deletion requires admin access | Expiry tests preserve current/future/legacy records and skip deletion when no current drop exists |

Checks: lint without warnings; production build; 12 unit tests; 17 integration tests against isolated Auth and Firestore emulators (including paged migration preserving original records); callable/scheduler metadata load; patch whitespace check; browser and backend production dependency audits (zero reported vulnerabilities).

Reviewed the final paths separately after implementation, without subagents: client action callers, refresh/listeners, login/logout/session expiry, server dispatch, Firestore rules, migration, expiry and Hosting workflow. Live browser-to-deployed-backend testing and production deployment were not possible. The existing large-bundle build warning remains. Firebase CLI tooling has upstream advisories, documented in the rollout guide; it is not an app or backend runtime dependency.

Intentional policy limits: staff access remains anonymous, names are self-entered, and anyone with the URL can claim a current code. Rate limits do not completely prevent distributed denial-of-service or read billing. Old exposed vouchers and historical untrusted audit records require operational review. Existing production data was preserved; the migration was supplied but not run live.

See [security-rollout.md](security-rollout.md) for the coordinated backend/rules/inventory/website rollout and deployment prerequisites.
