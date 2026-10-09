import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function checkBackendReadiness(source, ready) {
  if (/from\s+["']firebase\/functions["']/.test(source) && ready !== "true") {
    throw new Error("Secure frontend requires the deployed Firebase backend and inventory migration. Set SECURITY_BACKEND_READY=true only after verifying that rollout.");
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  checkBackendReadiness(readFileSync("src/App.jsx", "utf8"), process.env.SECURITY_BACKEND_READY);
}
