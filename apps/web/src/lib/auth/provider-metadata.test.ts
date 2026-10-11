import { describe, expect, test } from '@jest/globals';
import { ForgejoLogo } from '@/components/auth/ForgejoLogo';
import { GiteaLogo } from '@/components/auth/GiteaLogo';
import { OpenAILogo } from '@/components/auth/OpenAILogo';
import {
  AllAuthMethodIds,
  AuthProviderIdSchema,
  LinkableAuthProviders,
  OAuthProviderIds,
  ProdNonSSOAuthProviders,
  getProviderById,
} from './provider-metadata';

describe('Anaconda provider metadata', () => {
  test('defines Anaconda as a linkable OAuth sign-in method', () => {
    expect(AuthProviderIdSchema.parse('anaconda')).toBe('anaconda');
    expect(getProviderById('anaconda')).toMatchObject({
      id: 'anaconda',
      name: 'Anaconda',
    });
    expect(LinkableAuthProviders[0]?.id).toBe('anaconda');
    expect(OAuthProviderIds[0]).toBe('anaconda');
    expect(ProdNonSSOAuthProviders[0]).toBe('anaconda');
    expect(AllAuthMethodIds).toContain('anaconda');
  });
});

describe('OpenAI provider metadata', () => {
  test('defines ChatGPT as a linkable OAuth sign-in method', () => {
    expect(AuthProviderIdSchema.parse('openai')).toBe('openai');
    expect(getProviderById('openai')).toMatchObject({
      id: 'openai',
      name: 'ChatGPT',
      signInLabel: 'Continue with ChatGPT',
    });
    expect(OAuthProviderIds).toContain('openai');
    expect(ProdNonSSOAuthProviders).toContain('openai');
    expect(AllAuthMethodIds).toContain('openai');
  });

  test('uses the OpenAI logo for the ChatGPT sign-in icon', () => {
    expect((getProviderById('openai').icon as { type?: unknown }).type).toBe(OpenAILogo);
  });
});

describe('Gitea and Forgejo provider metadata', () => {
  it.each([
    { id: 'gitea', name: 'Gitea', Logo: GiteaLogo },
    { id: 'forgejo', name: 'Forgejo', Logo: ForgejoLogo },
  ])('defines $name as a linkable OAuth sign-in method', ({ id, name, Logo }) => {
    expect(AuthProviderIdSchema.parse(id)).toBe(id);
    expect(getProviderById(id)).toMatchObject({ id, name });
    expect(LinkableAuthProviders.some(provider => provider.id === id)).toBe(true);
    expect(OAuthProviderIds).toContain(id);
    expect(ProdNonSSOAuthProviders).toContain(id);
    expect(AllAuthMethodIds).toContain(id);
    expect((getProviderById(id).icon as { type?: unknown }).type).toBe(Logo);
  });
});
