jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  GITEA_CLIENT_ID: 'gitea-client-id',
  GITEA_CLIENT_SECRET: 'gitea-client-secret',
}));

import {
  buildGiteaOAuthUrl,
  exchangeGiteaOAuthCode,
  fetchGiteaRepositories,
  fetchGiteaUser,
} from './adapter';

function validTokenResponse(overrides: Record<string, unknown> = {}): Response {
  return Response.json({
    access_token: 'gitea-access-token',
    token_type: 'bearer',
    scope: 'read:user read:repository write:repository',
    ...overrides,
  });
}

function giteaRepository(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 42,
    name: 'demo',
    full_name: 'kilo/demo',
    private: false,
    default_branch: 'main',
    html_url: 'https://gitea.com/kilo/demo',
    ssh_url: 'git@gitea.com:kilo/demo.git',
    clone_url: 'https://gitea.com/kilo/demo.git',
    ...overrides,
  };
}

describe('Gitea OAuth adapter', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('buildGiteaOAuthUrl', () => {
    it('builds the canonical authorization URL against the default gitea.com instance', () => {
      const url = new URL(buildGiteaOAuthUrl('signed-state'));

      expect(`${url.origin}${url.pathname}`).toBe('https://gitea.com/login/oauth/authorize');
      expect(Object.fromEntries(url.searchParams)).toEqual({
        client_id: 'gitea-client-id',
        response_type: 'code',
        state: 'signed-state',
        scope: 'read:user read:repository write:repository',
      });
      expect(url.toString()).not.toContain('gitea-client-secret');
    });

    it('targets a self-hosted instance and strips trailing slashes', () => {
      const url = new URL(buildGiteaOAuthUrl('signed-state', 'https://git.example.com///'));

      expect(`${url.origin}${url.pathname}`).toBe('https://git.example.com/login/oauth/authorize');
    });

    it('rejects a non-HTTP instance URL', () => {
      expect(() => buildGiteaOAuthUrl('state', 'ftp://git.example.com')).toThrow(
        'Invalid Gitea instance URL protocol'
      );
    });
  });

  describe('exchangeGiteaOAuthCode', () => {
    it('exchanges an authorization code with a form body and no client secret leak', async () => {
      const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValueOnce(validTokenResponse());

      await expect(exchangeGiteaOAuthCode('auth code')).resolves.toEqual({
        accessToken: 'gitea-access-token',
        tokenType: 'bearer',
        scope: 'read:user read:repository write:repository',
        expiresIn: undefined,
        refreshToken: undefined,
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] ?? [];
      expect(url).toBe('https://gitea.com/login/oauth/access_token');
      expect(init?.method).toBe('POST');
      expect(init?.redirect).toBe('manual');
      expect(new URLSearchParams(init?.body as string)).toEqual(
        new URLSearchParams({
          grant_type: 'authorization_code',
          code: 'auth code',
          client_id: 'gitea-client-id',
          client_secret: 'gitea-client-secret',
        })
      );
    });

    it('maps expires_in and refresh_token from the token payload', async () => {
      jest.spyOn(global, 'fetch').mockResolvedValueOnce(
        validTokenResponse({
          expires_in: 3600,
          refresh_token: 'gitea-refresh-token',
        })
      );

      await expect(exchangeGiteaOAuthCode('code')).resolves.toEqual({
        accessToken: 'gitea-access-token',
        tokenType: 'bearer',
        scope: 'read:user read:repository write:repository',
        expiresIn: 3600,
        refreshToken: 'gitea-refresh-token',
      });
    });

    it('surfaces provider failures with the status code', async () => {
      jest.spyOn(global, 'fetch').mockResolvedValueOnce(new Response('nope', { status: 400 }));

      await expect(exchangeGiteaOAuthCode('code')).rejects.toThrow(
        'Gitea OAuth token exchange failed (400)'
      );
    });

    it('rejects a token payload with a non-bearer token type', async () => {
      jest.spyOn(global, 'fetch').mockResolvedValueOnce(validTokenResponse({ token_type: 'mac' }));

      await expect(exchangeGiteaOAuthCode('code')).rejects.toThrow(
        'Gitea OAuth token exchange returned invalid credentials'
      );
    });

    it('rejects a token payload with a blank access token', async () => {
      jest
        .spyOn(global, 'fetch')
        .mockResolvedValueOnce(validTokenResponse({ access_token: '   ' }));

      await expect(exchangeGiteaOAuthCode('code')).rejects.toThrow(
        'Gitea OAuth token exchange returned invalid credentials'
      );
    });

    it('rejects a token payload with a whitespace-padded access token', async () => {
      jest
        .spyOn(global, 'fetch')
        .mockResolvedValueOnce(validTokenResponse({ access_token: ' gitea-access-token' }));

      await expect(exchangeGiteaOAuthCode('code')).rejects.toThrow(
        'Gitea OAuth token exchange returned invalid credentials'
      );
    });

    it('rejects a token payload with a blank refresh token', async () => {
      jest
        .spyOn(global, 'fetch')
        .mockResolvedValueOnce(validTokenResponse({ refresh_token: '  ' }));

      await expect(exchangeGiteaOAuthCode('code')).rejects.toThrow(
        'Gitea OAuth token exchange returned invalid credentials'
      );
    });
  });

  describe('fetchGiteaUser', () => {
    it('reads the authenticated identity with a token authorization header', async () => {
      const fetchMock = jest
        .spyOn(global, 'fetch')
        .mockResolvedValueOnce(
          Response.json({ id: 7, login: 'kilo', full_name: 'Kilo', email: 'kilo@example.com' })
        );

      await expect(fetchGiteaUser('gitea-access-token')).resolves.toEqual({
        id: 7,
        login: 'kilo',
        fullName: 'Kilo',
        email: 'kilo@example.com',
      });
      const [requestUrl, requestInit] = fetchMock.mock.calls[0] ?? [];
      expect(requestUrl).toBe('https://gitea.com/api/v1/user');
      expect((requestInit?.headers as Record<string, string> | undefined)?.Authorization).toBe(
        'token gitea-access-token'
      );
    });

    it('rejects an identity without a positive numeric id', async () => {
      jest.spyOn(global, 'fetch').mockResolvedValueOnce(Response.json({ id: -1, login: 'kilo' }));

      await expect(fetchGiteaUser('gitea-access-token')).rejects.toThrow(
        'Gitea user request returned invalid identity'
      );
    });
  });

  describe('fetchGiteaRepositories', () => {
    it('paginates until a short page is returned', async () => {
      const pageTwo = Array.from({ length: 30 }, (_, index) =>
        giteaRepository({ id: 100 + index })
      );
      const fetchMock = jest
        .spyOn(global, 'fetch')
        .mockResolvedValueOnce(
          Response.json(
            Array.from({ length: 50 }, (_, index) => giteaRepository({ id: index + 1 }))
          )
        )
        .mockResolvedValueOnce(Response.json(pageTwo));

      const repositories = await fetchGiteaRepositories('gitea-access-token');

      expect(repositories).toHaveLength(80);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const secondUrl = new URL(fetchMock.mock.calls[1]?.[0] as string);
      expect(secondUrl.searchParams.get('page')).toBe('2');
      expect(secondUrl.searchParams.get('per_page')).toBe('50');
    });

    it('drops repositories that fail the schema instead of failing the whole list', async () => {
      jest
        .spyOn(global, 'fetch')
        .mockResolvedValueOnce(
          Response.json([giteaRepository(), giteaRepository({ id: 'not-a-number' })])
        );

      const repositories = await fetchGiteaRepositories('gitea-access-token');

      expect(repositories).toHaveLength(1);
      expect(repositories[0]).toMatchObject({
        id: 42,
        name: 'demo',
        full_name: 'kilo/demo',
        private: false,
        default_branch: 'main',
      });
    });

    it('stops after the page ceiling to bound unbounded pagination', async () => {
      const fetchMock = jest
        .spyOn(global, 'fetch')
        .mockImplementation(async () =>
          Response.json(
            Array.from({ length: 50 }, (_, index) => giteaRepository({ id: index + 1 }))
          )
        );

      await fetchGiteaRepositories('gitea-access-token');

      expect(fetchMock).toHaveBeenCalledTimes(20);
    });
  });
});
