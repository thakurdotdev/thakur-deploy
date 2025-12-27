import { Elysia, t } from 'elysia';
import { auth } from '../lib/auth';
import { db } from '../db';
import { account, githubInstallations } from '../db/schema';
import { eq, and } from 'drizzle-orm';
import { GitHubService } from '../services/github-service';

interface GitHubInstallation {
  id: number;
  account: {
    login: string;
    id: number;
    type: string;
  };
}

interface GitHubInstallationsResponse {
  installations: GitHubInstallation[];
}

export const githubRoutes = new Elysia({ prefix: '/github' })
  .derive(async ({ request }) => {
    const session = await auth.api.getSession({ headers: request.headers });
    return { user: session?.user, session: session?.session };
  })
  .onBeforeHandle(({ user, set }) => {
    if (!user) {
      set.status = 401;
      return 'Unauthorized';
    }
  })
  .get('/installations', async ({ user, set, query }) => {
    try {
      const forceRefresh = (query as { refresh?: string })?.refresh === 'true';

      // 1. Try to get installations from DB cache first (Vercel-style fast path)
      if (!forceRefresh) {
        const cachedInstallations = await db.select().from(githubInstallations);
        if (cachedInstallations.length > 0) {
          console.log('[GitHub] Returning cached installations from DB');
          return {
            installations: cachedInstallations.map((i) => ({
              id: parseInt(i.github_installation_id),
              account: {
                login: i.account_login,
                id: parseInt(i.account_id),
                type: i.account_type,
              },
            })),
          };
        }
      }

      // 2. No cache or force refresh - get from GitHub API
      console.log('[GitHub] Fetching installations from GitHub API...');

      // Get User's GitHub Access Token
      const userAccount = await db
        .select()
        .from(account)
        .where(and(eq(account.userId, user!.id), eq(account.providerId, 'github')))
        .limit(1);

      if (!userAccount.length || !userAccount[0].accessToken) {
        console.error('[GitHub] No linked account for user:', user!.id);
        set.status = 400;
        return { error: 'No linked GitHub account found' };
      }

      const accountData = userAccount[0];
      let token = accountData.accessToken;

      // Check if token is expired
      if (accountData.accessTokenExpiresAt) {
        const expiresAt = new Date(accountData.accessTokenExpiresAt);
        if (expiresAt < new Date()) {
          console.log('[GitHub] Access token expired, checking for refresh token...');

          // Token expired - check if we have a refresh token
          if (accountData.refreshToken) {
            // Try to refresh the token using GitHub's refresh endpoint
            try {
              const refreshRes = await fetch('https://github.com/login/oauth/access_token', {
                method: 'POST',
                headers: {
                  Accept: 'application/json',
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                  client_id: process.env.GITHUB_CLIENT_ID,
                  client_secret: process.env.GITHUB_CLIENT_SECRET,
                  grant_type: 'refresh_token',
                  refresh_token: accountData.refreshToken,
                }),
              });

              if (refreshRes.ok) {
                const refreshData = (await refreshRes.json()) as {
                  access_token: string;
                  expires_in?: number;
                  refresh_token?: string;
                  refresh_token_expires_in?: number;
                };

                // Update the token in the database
                await db
                  .update(account)
                  .set({
                    accessToken: refreshData.access_token,
                    accessTokenExpiresAt: refreshData.expires_in
                      ? new Date(Date.now() + refreshData.expires_in * 1000)
                      : null,
                    refreshToken: refreshData.refresh_token || accountData.refreshToken,
                    refreshTokenExpiresAt: refreshData.refresh_token_expires_in
                      ? new Date(Date.now() + refreshData.refresh_token_expires_in * 1000)
                      : accountData.refreshTokenExpiresAt,
                    updatedAt: new Date(),
                  })
                  .where(eq(account.id, accountData.id));

                token = refreshData.access_token;
                console.log('[GitHub] Token refreshed successfully');
              } else {
                console.error('[GitHub] Failed to refresh token:', await refreshRes.text());
                set.status = 401;
                return { error: 'GitHub token expired. Please re-login with GitHub.' };
              }
            } catch (refreshError) {
              console.error('[GitHub] Token refresh error:', refreshError);
              set.status = 401;
              return { error: 'GitHub token expired. Please re-login with GitHub.' };
            }
          } else {
            // No refresh token available
            console.log('[GitHub] No refresh token available, user must re-authenticate');
            set.status = 401;
            return { error: 'GitHub token expired. Please re-login with GitHub.' };
          }
        }
      }

      // 2. List user's installations of OUR App
      const res = await fetch('https://api.github.com/user/installations', {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github.v3+json',
        },
      });

      if (!res.ok) {
        const errText = await res.text();
        console.error('[GitHub] API Error /user/installations:', res.status, errText);

        // Check if it's a token expiry error
        if (res.status === 401) {
          set.status = 401;
          return { error: 'GitHub token expired. Please re-login with GitHub.' };
        }

        set.status = 502;
        let errorMessage = res.statusText;
        try {
          const json = JSON.parse(errText);
          errorMessage = json.message || errText;
        } catch {
          errorMessage = errText || res.statusText;
        }
        return { error: `GitHub API Error: ${errorMessage}` };
      }

      const data = (await res.json()) as GitHubInstallationsResponse;

      // Sync installations to DB to ensure FK constraints are met
      if (data.installations && Array.isArray(data.installations)) {
        for (const install of data.installations) {
          await db
            .insert(githubInstallations)
            .values({
              github_installation_id: install.id.toString(),
              account_login: install.account.login,
              account_id: install.account.id.toString(),
              account_type: install.account.type,
            })
            .onConflictDoUpdate({
              target: githubInstallations.github_installation_id,
              set: {
                account_login: install.account.login,
                account_id: install.account.id.toString(),
                account_type: install.account.type,
              },
            });
        }
      }

      return data;
    } catch (e: any) {
      console.error('[GitHub] Internal Error:', e);
      set.status = 500;
      return { error: e.message || 'Internal Server Error' };
    }
  })
  .get('/installations/:id/repositories', async ({ params, user, set }) => {
    try {
      const installationId = params.id;

      const token = await GitHubService.getInstallationToken(installationId);

      const res = await fetch(
        'https://api.github.com/installation/repositories?per_page=100&sort=pushed&direction=desc',
        {
          headers: {
            Authorization: `token ${token}`,
            Accept: 'application/vnd.github.v3+json',
          },
        },
      );

      if (!res.ok) {
        const err = await res.text();
        console.error('[GitHub] API Error /installation/repositories:', err);
        set.status = 502;
        let errorMessage = res.statusText;
        try {
          const json = JSON.parse(err);
          errorMessage = json.message || err;
        } catch {
          errorMessage = err || res.statusText;
        }
        return { error: `GitHub API Error: ${errorMessage}` };
      }

      const data = (await res.json()) as { repositories?: Array<{ pushed_at?: string }> };

      // Sort by pushed_at to show most recently updated repos first
      if (data.repositories && Array.isArray(data.repositories)) {
        data.repositories.sort((a: any, b: any) => {
          return new Date(b.pushed_at || 0).getTime() - new Date(a.pushed_at || 0).getTime();
        });
      }

      return data;
    } catch (e: any) {
      console.error('[GitHub] Internal Error (Repos):', e);
      set.status = 500;
      return { error: e.message || 'Internal Server Error' };
    }
  });
