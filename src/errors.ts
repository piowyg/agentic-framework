/** The message of anything thrown; non-Error values are stringified. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
