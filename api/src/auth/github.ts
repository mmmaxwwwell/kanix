// ---------------------------------------------------------------------------
// GitHub OAuth helpers
// ---------------------------------------------------------------------------

export interface GitHubUser {
  id: number;
  login: string;
}

export type GitHubUserFetcher = (code: string) => Promise<GitHubUser>;

/**
 * Exchanges a GitHub OAuth authorization code for an access token,
 * then fetches the authenticated GitHub user's profile.
 */
export function createGitHubUserFetcher(clientId: string, clientSecret: string): GitHubUserFetcher {
  return async (code: string): Promise<GitHubUser> => {
    // Exchange authorization code for access token
    const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        code,
      }),
    });

    if (!tokenRes.ok) {
      throw new Error(`GitHub token exchange failed: ${tokenRes.status}`);
    }

    const tokenBody = (await tokenRes.json()) as {
      access_token?: string;
      error?: string;
      error_description?: string;
    };

    if (tokenBody.error || !tokenBody.access_token) {
      throw new Error(
        `GitHub OAuth error: ${tokenBody.error_description ?? tokenBody.error ?? "no access token"}`,
      );
    }

    // Fetch user profile
    const userRes = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${tokenBody.access_token}`,
        Accept: "application/vnd.github+json",
      },
    });

    if (!userRes.ok) {
      throw new Error(`GitHub user fetch failed: ${userRes.status}`);
    }

    const user = (await userRes.json()) as { id: number; login: string };
    return { id: user.id, login: user.login };
  };
}
