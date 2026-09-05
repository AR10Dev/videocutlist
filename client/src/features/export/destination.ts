export const lastDestinationKey = "videocutlist.last-destination.v1";

const validDestinationId = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 64 &&
  !Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  }) &&
  !value.includes("/") &&
  !value.includes("\\");

export function lastDestinationId(storage: Storage = localStorage): string | undefined {
  try {
    const value = storage.getItem(lastDestinationKey);
    return validDestinationId(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export function rememberDestination(id: string, storage: Storage = localStorage): void {
  if (!validDestinationId(id)) return;
  try {
    storage.setItem(lastDestinationKey, id);
  } catch {
    /* Browser storage can be unavailable in private or restricted contexts. */
  }
}

export function destinationIsConfigured(
  id: string | undefined,
  destinations: readonly { id: string }[],
): id is string {
  return id !== undefined && destinations.some((destination) => destination.id === id);
}
