const KNOWN_NAMES = {
  c02e05: "Soklim Sim",
  "0cf376": "Sothea Sorn",
  "801a50": "Kimpor Kang",
  "643595": "Hongsrun Lang",
};

function cleanName(value) {
  if (typeof value !== "string") return "";
  const name = value.trim().replace(/\s+/g, " ");
  return name.length <= 60 ? name : "";
}

// Suggestions stay editable. Full IDs are required for learned matches; the
// six-character suffixes below are only the owner's explicit starting mappings.
export function suggestDeviceName(deviceId, remembered, codes) {
  if (typeof deviceId !== "string" || !deviceId) return "";
  if (remembered?.deviceId === deviceId) {
    const name = cleanName(remembered.name);
    if (name) return name;
  }
  const known = KNOWN_NAMES[deviceId.slice(-6).toLowerCase()];
  if (known) return known;

  const names = new Map();
  for (const code of codes) {
    if (code.takenDevice !== deviceId || code.status !== "taken") continue;
    const name = cleanName(code.takenBy);
    if (name) names.set(name.toLowerCase(), name);
  }
  // A shared device with conflicting names needs an explicit choice.
  return names.size === 1 ? names.values().next().value : "";
}
