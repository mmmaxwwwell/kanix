/**
 * Checks SuperTokens core connectivity by hitting its /hello endpoint.
 * Returns true if SuperTokens responds successfully, false otherwise.
 */
export async function checkSuperTokensConnectivity(connectionUri: string): Promise<boolean> {
  try {
    const response = await fetch(`${connectionUri}/hello`, {
      signal: AbortSignal.timeout(3000),
    });
    return response.ok;
  } catch {
    return false;
  }
}
