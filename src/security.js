import { Timestamp } from "firebase/firestore";

export function toMs(value) {
  const ms = value instanceof Timestamp ? value.toMillis() : value;
  return typeof ms === "number" && Number.isFinite(ms) && Math.abs(ms) <= 8640000000000000 ? ms : null;
}
export function csvSafe(value) {
  const text = String(value ?? "");
  // eslint-disable-next-line no-control-regex -- control prefixes can conceal spreadsheet formulas.
  return /^[=+\-@\t\r\n]|^[\s\u0000-\u001f\u007f]+[=+\-@]/.test(text) ? `'${text}` : text;
}
