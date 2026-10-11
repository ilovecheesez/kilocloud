jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  FORGEJO_CLIENT_ID: 'forgejo-client-id',
  FORGEJO_CLIENT_SECRET: 'forgejo-client-secret',
}));

import {
  buildForgejoOAuthUrl,
  exchangeForgejoOAuthCode,
  fetchForgejoRepositories,
  fetchForgejoUser,
} from './adapter';

function forgejoRepository(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 9,
    name: 'demo',
    full_name: 'kilo/demo',
    private: true,
    default_branch: 'main',
    html_url: 'https://forgejo.example.com/kilo/demo',
    ssh_url: 'git@forgejo.example.com:kilo/demo.git',
    clone_url: 'https://forgejo.example.com/kilo/demo.git',
    ...overrides,
  };
}

describe('Forgejo OAuth adapter', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('builds the authorization URL against the default forgejo.org instance', () => {
    const url = new URL(buildForgejoOAuthUrl('signed-state'));

    expect(`${url.origin}${url.pathname}`).toBe('https://forgejo.org/login/oauth/authorize');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: 'forgejo-client-id',
      response_type: 'code',
      state: 'signed-state',
      scope: 'read:user read:repository write:repository',
    });
    expect(url.toString()).not.toContain('forgejo-client-secret');
  });

  it('keeps a self-hosted instance path when present', () => {
    const url = new URL(buildForgejoOAuthUrl('signed-state', 'https://forgejo.example.com/sub'));

    expect(url.origin).toBe('https://forgejo.example.com');
    expect(url.pathname).toBe('/sub/login/oauth/authorize');
  });

  it('exchanges a code against the instance token endpoint', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValueOnce(
      Response.json({
        access_token: 'forgejo-access-token',
        token_type: 'bearer',
        expires_in: 7200,
      })
    );

    await expect(
      exchangeForgejoOAuthCode('auth code', 'https://forgejo.example.com')
    ).resolves.toEqual({
      accessToken: 'forgejo-access-token',
      tokenType: 'bearer',
      scope: undefined,
      expiresIn: 7200,
      refreshToken: undefined,
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://forgejo.example.com/login/oauth/access_token'
    );
  });

  it('reads the authenticated identity from the instance', async () => {
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(Response.json({ id: 3, login: 'kilo' }));

    await expect(fetchForgejoUser('forgejo-access-token')).resolves.toEqual({
      id: 3,
      login: 'kilo',
      fullName: undefined,
      email: undefined,
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://forgejo.org/api/v1/user');
  });

  it('paginates repositories and tolerates schema failures', async () => {
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(
        Response.json([forgejoRepository(), forgejoRepository({ id: 10, name: '' })])
      );

    const repositories = await fetchForgejoRepositories('forgejo-access-token');

    expect(repositories).toHaveLength(1);
    expect(repositories[0]).toMatchObject({ id: 9, name: 'demo', private: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reports a failed repository request', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValueOnce(new Response('denied', { status: 403 }));

    await expect(fetchForgejoRepositories('forgejo-access-token')).rejects.toThrow(
      'Forgejo repositories request failed (403)'
    );
  });
});
