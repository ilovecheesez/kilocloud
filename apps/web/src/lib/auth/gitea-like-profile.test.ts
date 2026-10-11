import { describe, expect, it } from '@jest/globals';
import { parseGiteaLikeProfile } from './gitea-like-profile';

function giteaUser(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 42,
    login: 'kilo',
    email: 'kilo@example.com',
    name: 'Kilo Example',
    avatar_url: 'https://gitea.com/avatars/kilo.png',
    ...overrides,
  };
}

describe('parseGiteaLikeProfile', () => {
  it('maps the REST user payload to a NextAuth user keyed by the numeric id', () => {
    expect(parseGiteaLikeProfile(giteaUser())).toEqual({
      id: '42',
      email: 'kilo@example.com',
      name: 'Kilo Example',
      image: 'https://gitea.com/avatars/kilo.png',
    });
  });

  it('falls back to the login when the display name is missing', () => {
    expect(parseGiteaLikeProfile(giteaUser({ name: undefined })).name).toBe('kilo');
    expect(parseGiteaLikeProfile(giteaUser({ name: '   ' })).name).toBe('kilo');
  });

  it('keeps a null image absent rather than coercing it', () => {
    expect(parseGiteaLikeProfile(giteaUser({ avatar_url: undefined })).image).toBeNull();
    expect(parseGiteaLikeProfile(giteaUser({ avatar_url: '   ' })).image).toBeNull();
    expect(parseGiteaLikeProfile(giteaUser({ avatar_url: '' })).image).toBeNull();
  });

  it('serves both Gitea and Forgejo, which return the identical shape', () => {
    const forgejoUser = parseGiteaLikeProfile(giteaUser({ id: 9, login: 'forgejo-user' }));

    expect(forgejoUser.id).toBe('9');
    expect(forgejoUser.name).toBe('Kilo Example');
  });

  it('refuses a user without an email instead of inventing one', () => {
    expect(() => parseGiteaLikeProfile(giteaUser({ email: undefined }))).toThrow(
      'Gitea provider did not return an email address'
    );
    expect(() => parseGiteaLikeProfile(giteaUser({ email: 'not-an-email' }))).toThrow();
  });

  it('rejects a payload with a non-positive or non-integer id', () => {
    expect(() => parseGiteaLikeProfile(giteaUser({ id: 0 }))).toThrow();
    expect(() => parseGiteaLikeProfile(giteaUser({ id: 1.5 }))).toThrow();
    expect(() => parseGiteaLikeProfile(giteaUser({ id: '42' }))).toThrow();
  });

  it('rejects a payload without a login', () => {
    expect(() => parseGiteaLikeProfile(giteaUser({ login: '  ' }))).toThrow();
  });
});
