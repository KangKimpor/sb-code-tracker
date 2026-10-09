export function unavailableInventory(loading, connectionError, count) {
  if (count > 0) return null;
  if (loading) return { title: "Loading codes…", detail: "Connecting to the code list" };
  if (connectionError) return { title: "Could not load codes", detail: "Please retry. Your code list has not been loaded." };
  return null;
}
