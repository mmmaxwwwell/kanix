/**
 * Test helpers for integration tests.
 *
 * Integration tests must exercise the whole app against live services.
 * Skips are not allowed — missing services are a test failure, not a skip
 * condition. These assertions throw loudly from `beforeAll` so vitest
 * reports a hard failure instead of a silent pass.
 */

export function requireDatabaseUrl(): string {
  const url = process.env["DATABASE_URL"];
  if (!url) {
    throw new Error(
      "DATABASE_URL is required for integration tests. " +
        "Start services with `process-compose up` and export DATABASE_URL.",
    );
  }
  return url;
}

export function getSuperTokensUri(): string {
  return process.env["SUPERTOKENS_CONNECTION_URI"] ?? "http://localhost:3567";
}

export async function assertSuperTokensUp(): Promise<void> {
  const uri = getSuperTokensUri();
  let res: Response;
  try {
    res = await fetch(`${uri}/hello`, { signal: AbortSignal.timeout(2000) });
  } catch (err) {
    throw new Error(
      `SuperTokens is not reachable at ${uri} (${(err as Error).message}). ` +
        "Start services with `process-compose up` before running integration tests.",
    );
  }
  if (!res.ok) {
    throw new Error(
      `SuperTokens at ${uri} returned ${res.status} for /hello. ` +
        "Check the SuperTokens process and CDI version compatibility.",
    );
  }
}
