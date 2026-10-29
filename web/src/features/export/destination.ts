export const validDestinationId = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 64 &&
  !Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  }) &&
  !value.includes("/") &&
  !value.includes("\\");

export function destinationIsConfigured(
  id: string | undefined,
  destinations: readonly { id: string }[],
): id is string {
  return id !== undefined && destinations.some((destination) => destination.id === id);
}
