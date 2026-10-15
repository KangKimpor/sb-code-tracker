# Production deployments

- When asked to publish or push an update, deploy the same commit to both Vercel and Firebase Hosting.
- Production branch: `master`. Vercel deploys through its GitHub integration; `.github/workflows/deploy-firebase.yml` deploys Firebase Hosting from the same push.
- Verify the Vercel deployment and Firebase GitHub Actions run both succeed before calling a release complete. Fix or rerun a failed deployment; do not leave one host behind.
- Check the live app at `https://sb-code-tracker.vercel.app/`, `https://sb-code-tracker.web.app/`, and `https://sbgrabcode.mine.bz/`. The custom domain uses Firebase Hosting.
- Keep production build settings synchronized between Vercel and GitHub Actions, including `VITE_ADMIN_PIN` while the compatible frontend uses it. Never commit credentials or print their values. Compare live asset hashes to verify the hosts serve the same build.
- Hosting updates must not deploy Firestore rules or Cloud Functions unless that backend rollout is explicitly in scope.
