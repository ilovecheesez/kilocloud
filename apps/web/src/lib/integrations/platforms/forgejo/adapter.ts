import 'server-only';

import { z } from 'zod';
import { FORGEJO_CLIENT_ID, FORGEJO_CLIENT_SECRET } from '@kilocode/web-shared/lib/config.server';
import { ForgejoRepositorySchema, type ForgejoRepository } from './metadata';

const FORGEJO_AUTHORIZE_URL = '/login/oauth/authorize';
const FORGEJO_TOKEN_URL = '/login/oauth/access_token';
const FORGEJO_USER_URL = '/api/v1/user';
const FORGEJO_REPOS_URL = '/api/v1/user/repos';
const FORGEJO_DEFAULT_INSTANCE_URL = 'https://forgejo.org';
const MAX_FORGEJO_REPOSITORY_PAGES = 20;
const FORGEJO_PAGE_SIZE = 50;

const NonEmptyOAuthTokenSchema = z
  .string()
  .min(1)
  .refine(value => value.trim() === value);

const ForgejoOAuthTokenSchema = z
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

export type ForgejoOAuthTokens = {
  accessToken: string;
  tokenType: 'bearer';
  scope?: string;
  expiresIn?: number;
  refreshToken?: string;
};

const ForgejoUserSchema = z
  .object({
    id: z.number().int().positive(),
    login: z.string().min(1),
    full_name: z.string().optional(),
    email: z.string().optional(),
  })
  .strict();

export type ForgejoUser = {
  id: number;
  login: string;
  fullName?: string;
  email?: string;
};

function resolveForgejoInstanceUrl(instanceUrl?: string): string {
  if (!instanceUrl) return FORGEJO_DEFAULT_INSTANCE_URL;
  let url: URL;
  try {
    url = new URL(instanceUrl);
  } catch {
    throw new Error(`Invalid Forgejo instance URL: ${instanceUrl}`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`Invalid Forgejo instance URL protocol: ${instanceUrl}`);
  }
  return instanceUrl.replace(/\/+$/, '');
}

export function buildForgejoOAuthUrl(state: string, instanceUrl?: string): string {
  if (!FORGEJO_CLIENT_ID) {
    throw new Error('Forgejo OAuth client ID is not configured');
  }
  const base = resolveForgejoInstanceUrl(instanceUrl);
  const url = new URL(`${base}${FORGEJO_AUTHORIZE_URL}`);
  url.searchParams.set('client_id', FORGEJO_CLIENT_ID);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('state', state);
  url.searchParams.set('scope', 'read:user read:repository write:repository');
  return url.toString();
}

export async function exchangeForgejoOAuthCode(
  code: string,
  instanceUrl?: string
): Promise<ForgejoOAuthTokens> {
  if (!FORGEJO_CLIENT_ID || !FORGEJO_CLIENT_SECRET) {
    throw new Error('Forgejo OAuth credentials are not configured');
  }
  const base = resolveForgejoInstanceUrl(instanceUrl);
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: FORGEJO_CLIENT_ID,
    client_secret: FORGEJO_CLIENT_SECRET,
  });
  const response = await fetch(`${base}${FORGEJO_TOKEN_URL}`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });

  if (!response.ok) {
    throw new Error(`Forgejo OAuth token exchange failed (${response.status})`);
  }

  const responseBody = await response.json().catch(() => {
    throw new Error('Forgejo OAuth token exchange returned invalid JSON');
  });
  const parsed = ForgejoOAuthTokenSchema.safeParse(responseBody);
  if (!parsed.success) {
    throw new Error('Forgejo OAuth token exchange returned invalid credentials');
  }

  return {
    accessToken: parsed.data.access_token,
    tokenType: 'bearer',
    scope: parsed.data.scope,
    expiresIn: parsed.data.expires_in,
    refreshToken: parsed.data.refresh_token,
  };
}

export async function fetchForgejoUser(
  accessToken: string,
  instanceUrl?: string
): Promise<ForgejoUser> {
  const base = resolveForgejoInstanceUrl(instanceUrl);
  const response = await fetch(`${base}${FORGEJO_USER_URL}`, {
    redirect: 'manual',
    headers: {
      Accept: 'application/json',
      Authorization: `token ${accessToken}`,
    },
  });
  if (!response.ok) {
    throw new Error(`Forgejo user request failed (${response.status})`);
  }
  const responseBody = await response.json().catch(() => {
    throw new Error('Forgejo user request returned invalid JSON');
  });
  const parsed = ForgejoUserSchema.safeParse(responseBody);
  if (!parsed.success) {
    throw new Error('Forgejo user request returned invalid identity');
  }
  return {
    id: parsed.data.id,
    login: parsed.data.login,
    fullName: parsed.data.full_name,
    email: parsed.data.email,
  };
}

export async function fetchForgejoRepositories(
  accessToken: string,
  instanceUrl?: string
): Promise<ForgejoRepository[]> {
  const base = resolveForgejoInstanceUrl(instanceUrl);
  const repositories: ForgejoRepository[] = [];
  let page = 1;
  let hasMore = true;

  while (hasMore && page <= MAX_FORGEJO_REPOSITORY_PAGES) {
    const url = new URL(`${base}${FORGEJO_REPOS_URL}`);
    url.searchParams.set('page', String(page));
    url.searchParams.set('per_page', String(FORGEJO_PAGE_SIZE));

    const response = await fetch(url.toString(), {
      redirect: 'manual',
      headers: {
        Accept: 'application/json',
        Authorization: `token ${accessToken}`,
      },
    });

    if (!response.ok) {
      throw new Error(`Forgejo repositories request failed (${response.status})`);
    }

    const pageData = await response.json().catch(() => {
      throw new Error('Forgejo repositories request returned invalid JSON');
    });

    if (!Array.isArray(pageData)) {
      throw new Error('Forgejo repositories request returned invalid response');
    }

    for (const repo of pageData) {
      const parsed = ForgejoRepositorySchema.safeParse(repo);
      if (parsed.success) {
        repositories.push(parsed.data);
      }
    }

    hasMore = pageData.length === FORGEJO_PAGE_SIZE;
    page++;
  }

  return repositories;
}
