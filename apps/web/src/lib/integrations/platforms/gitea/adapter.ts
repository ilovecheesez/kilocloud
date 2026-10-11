import 'server-only';

import { z } from 'zod';
import { GITEA_CLIENT_ID, GITEA_CLIENT_SECRET } from '@kilocode/web-shared/lib/config.server';
import { GiteaRepositorySchema, type GiteaRepository } from './metadata';

const GITEA_AUTHORIZE_URL = '/login/oauth/authorize';
const GITEA_TOKEN_URL = '/login/oauth/access_token';
const GITEA_USER_URL = '/api/v1/user';
const GITEA_REPOS_URL = '/api/v1/user/repos';
const GITEA_DEFAULT_INSTANCE_URL = 'https://gitea.com';
const MAX_GITEA_REPOSITORY_PAGES = 20;
const GITEA_PAGE_SIZE = 50;

const NonEmptyOAuthTokenSchema = z
  .string()
  .min(1)
  .refine(value => value.trim() === value);

const GiteaOAuthTokenSchema = z
  .object({
    access_token: NonEmptyOAuthTokenSchema,
    token_type: z
      .string()
      .transform(v => v.toLowerCase())
      .pipe(z.literal('bearer')),
    scope: z.string().optional(),
    expires_in: z.number().int().positive().optional(),
    refresh_token: NonEmptyOAuthTokenSchema.optional(),
  })
  .strict();

export type GiteaOAuthTokens = {
  accessToken: string;
  tokenType: 'bearer';
  scope?: string;
  expiresIn?: number;
  refreshToken?: string;
};

const GiteaUserSchema = z
  .object({
    id: z.number().int().positive(),
    login: z.string().min(1),
    full_name: z.string().optional(),
    email: z.string().optional(),
  })
  .strict();

export type GiteaUser = {
  id: number;
  login: string;
  fullName?: string;
  email?: string;
};

function resolveGiteaInstanceUrl(instanceUrl?: string): string {
  if (!instanceUrl) return GITEA_DEFAULT_INSTANCE_URL;
  let url: URL;
  try {
    url = new URL(instanceUrl);
  } catch {
    throw new Error(`Invalid Gitea instance URL: ${instanceUrl}`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`Invalid Gitea instance URL protocol: ${instanceUrl}`);
  }
  return instanceUrl.replace(/\/+$/, '');
}

export function buildGiteaOAuthUrl(state: string, instanceUrl?: string): string {
  if (!GITEA_CLIENT_ID) {
    throw new Error('Gitea OAuth client ID is not configured');
  }
  const base = resolveGiteaInstanceUrl(instanceUrl);
  const url = new URL(`${base}${GITEA_AUTHORIZE_URL}`);
  url.searchParams.set('client_id', GITEA_CLIENT_ID);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('state', state);
  url.searchParams.set('scope', 'read:user read:repository write:repository');
  return url.toString();
}

export async function exchangeGiteaOAuthCode(
  code: string,
  instanceUrl?: string
): Promise<GiteaOAuthTokens> {
  if (!GITEA_CLIENT_ID || !GITEA_CLIENT_SECRET) {
    throw new Error('Gitea OAuth credentials are not configured');
  }
  const base = resolveGiteaInstanceUrl(instanceUrl);
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: GITEA_CLIENT_ID,
    client_secret: GITEA_CLIENT_SECRET,
  });
  const response = await fetch(`${base}${GITEA_TOKEN_URL}`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });

  if (!response.ok) {
    throw new Error(`Gitea OAuth token exchange failed (${response.status})`);
  }

  const responseBody = await response.json().catch(() => {
    throw new Error('Gitea OAuth token exchange returned invalid JSON');
  });
  const parsed = GiteaOAuthTokenSchema.safeParse(responseBody);
  if (!parsed.success) {
    throw new Error('Gitea OAuth token exchange returned invalid credentials');
  }

  return {
    accessToken: parsed.data.access_token,
    tokenType: 'bearer',
    scope: parsed.data.scope,
    expiresIn: parsed.data.expires_in,
    refreshToken: parsed.data.refresh_token,
  };
}

export async function fetchGiteaUser(
  accessToken: string,
  instanceUrl?: string
): Promise<GiteaUser> {
  const base = resolveGiteaInstanceUrl(instanceUrl);
  const response = await fetch(`${base}${GITEA_USER_URL}`, {
    redirect: 'manual',
    headers: {
      Accept: 'application/json',
      Authorization: `token ${accessToken}`,
    },
  });
  if (!response.ok) {
    throw new Error(`Gitea user request failed (${response.status})`);
  }
  const responseBody = await response.json().catch(() => {
    throw new Error('Gitea user request returned invalid JSON');
  });
  const parsed = GiteaUserSchema.safeParse(responseBody);
  if (!parsed.success) {
    throw new Error('Gitea user request returned invalid identity');
  }
  return {
    id: parsed.data.id,
    login: parsed.data.login,
    fullName: parsed.data.full_name,
    email: parsed.data.email,
  };
}

export async function fetchGiteaRepositories(
  accessToken: string,
  instanceUrl?: string
): Promise<GiteaRepository[]> {
  const base = resolveGiteaInstanceUrl(instanceUrl);
  const repositories: GiteaRepository[] = [];
  let page = 1;
  let hasMore = true;

  while (hasMore && page <= MAX_GITEA_REPOSITORY_PAGES) {
    const url = new URL(`${base}${GITEA_REPOS_URL}`);
    url.searchParams.set('page', String(page));
    url.searchParams.set('per_page', String(GITEA_PAGE_SIZE));

    const response = await fetch(url.toString(), {
      redirect: 'manual',
      headers: {
        Accept: 'application/json',
        Authorization: `token ${accessToken}`,
      },
    });

    if (!response.ok) {
      throw new Error(`Gitea repositories request failed (${response.status})`);
    }

    const pageData = await response.json().catch(() => {
      throw new Error('Gitea repositories request returned invalid JSON');
    });

    if (!Array.isArray(pageData)) {
      throw new Error('Gitea repositories request returned invalid response');
    }

    for (const repo of pageData) {
      const parsed = GiteaRepositorySchema.safeParse(repo);
      if (parsed.success) {
        repositories.push(parsed.data);
      }
    }

    hasMore = pageData.length === GITEA_PAGE_SIZE;
    page++;
  }

  return repositories;
}
