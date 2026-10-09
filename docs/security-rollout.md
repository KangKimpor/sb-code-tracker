# Security rollout

Staff access stays open. The PIN screen now gets a one-hour admin session from the server. The PIN is held in Secret Manager, never in the website. All browser writes are denied; claims, admin operations and audit records go through the callable function. Voucher values stay in `codes`; `codeInventory` contains only display metadata.

## Before production

Firebase credentials must be renewed (`npx --yes firebase-tools@15.33.0 login --reauth`). No live resources have been changed by this patch. Take a Firestore backup before rollout. Functions and the scheduler require a billing-enabled Firebase project. Enable Firebase Authentication (custom-token sign-in needs no Google or email provider), and confirm the runtime service account can sign custom tokens (Service Account Token Creator / IAM signBlob permission). Keep the existing six-digit admin PIN, as requested; changing it is not required.

1. Install both lockfiles: `npm ci` and `npm ci --prefix functions`.
2. Run `npm run lint`, `npm test`, `npm run test:security` (Java 21+), and `npm run build`.
3. Store the existing PIN in the server's `ADMIN_PIN` secret: `npx --yes firebase-tools@15.33.0 functions:secrets:set ADMIN_PIN --project sb-code-tracker`. This transfers the current PIN to the backend; no new PIN is needed. If `ADMIN_PIN` is already configured with the existing PIN, skip this step. Do not commit its value or include it in website build settings.
4. Deploy the backend and rules: `npx --yes firebase-tools@15.33.0 deploy --only functions,firestore:rules --project sb-code-tracker`. This briefly disables claims in the old website; perform the remaining steps in the same maintenance window.
5. With Application Default Credentials for this project, run `npm --prefix functions run migrate -- sb-code-tracker`. This creates safe inventory copies using fresh transactional reads and preserves all original code records. Do not reopen staff access until inventory counts and a sample have been checked.
6. Deploy the new website: `npx --yes firebase-tools@15.33.0 deploy --only hosting --project sb-code-tracker`. Verify a staff claim, PIN rejection and acceptance, release/history, bulk add/delete, top-up request and CSV export. Verify logout and session expiry remove admin access. Staff must not read `codes`, history or logs directly.
7. Set the GitHub repository variable `SECURITY_BACKEND_READY=true` after these checks so the existing Hosting workflow can publish subsequent changes. Remove the obsolete `VITE_ADMIN_PIN` secret from GitHub and any hosting build settings.
8. Enable Firestore TTL on `expiresAt` for `_rateLimits` and `_requestCooldowns` to clean old rate buckets. Monitor billing and function errors.

## Limits and existing records

Anonymous staff access is intentional: anyone with the app URL can claim a current code or choose a staff name. This does not establish employee identity. Claim and top-up requests have a per-IP limit of 30/hour, a global limit of 300/hour, and top-ups have a six-hour device cooldown. PIN verification is limited to five attempts per IP per 15 minutes and 100 globally per hour. Staff sharing a network share the IP allowance. Rate limits bound accepted writes; they are not complete protection against a distributed denial-of-service or read billing. Configure Firebase App Check enforcement and billing alerts as an additional operational layer.

Keeping the existing PIN preserves the risk that someone learned it from the old public website bundle. Server checks and throttling prevent browser-only bypasses, but anyone who already knows that PIN can still enter admin mode.

New monthly drops are limited to 1,000 codes. Staff queries return up to 2,000 records for the current month plus legacy unlabelled codes; inspect and label legacy records before rollout if this would exceed the limit. Public inventory includes staff-entered names and claim times, as the existing staff table does. Old audit rows remain historical, potentially untrusted records; new rows are stamped `source: server`. The backend does not silently delete old forged records during migration. Previously downloaded voucher values cannot be made secret again; replace any still-valid vouchers that may already have been exposed. Close old app tabs and clear their cached site data during rollout.

The Firebase CLI is pinned in the test command and run outside the app's dependency tree. Version 15.33.0 currently has upstream dependency advisories in its local tooling; it is not shipped to browsers or Cloud Functions. Application and backend dependency audits are separate. Upgrade this test-tool pin when a patched compatible CLI is available.

Expiry uses the server's ICT month. A daily server job removes expired monthly codes only when a current-month drop exists; future and unlabelled drops are preserved. A wrong browser clock cannot delete codes. Admin manual deletion remains available. Reverting only Hosting after rollout is unsafe because old client writes are now denied; keep the new rules and backend when rolling back UI changes.
