import 'server-only';

import { createPublicKey, randomUUID } from 'node:crypto';
import {
  FORGEJO_OAUTH_CREDENTIAL_ACTIVE_KEY_ID,
  FORGEJO_OAUTH_CREDENTIAL_ACTIVE_PUBLIC_KEY,
} from '@kilocode/web-shared/lib/config.server';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { INTEGRATION_STATUS, PLATFORM } from '@/lib/integrations/core/constants';
import type { Owner } from '@/lib/integrations/core/types';
import { ORGANIZATION_BILLING_ROLES } from '@kilocode/app-shared/organizations';
import { encryptKeyedEnvelope } from '@kilocode/encryption';
import {
  kilocode_users,
  organization_memberships,
  platform_integrations,
  platform_oauth_credentials,
  type NewPlatformOAuthCredential,
} from '@kilocode/db/schema';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { ForgejoOAuthTokens, ForgejoUser } from './adapter';
import {
  ForgejoIntegrationMetadataSchema,
  ForgejoRepositorySchema,
  type ForgejoRepository,
} from './metadata';

export const FORGEJO_OAUTH_CREDENTIAL_ENVELOPE_SCHEME = 'forgejo-oauth-credential-rsa-aes-256-gcm';

export class ForgejoIntegrationAuthorizationError extends Error {}
export class ForgejoIntegrationConnectionConflictError extends Error {
  constructor() {
    super('Forgejo is already connected for this owner');
    this.name = 'ForgejoIntegrationConnectionConflictError';
  }
}

export function buildForgejoOAuthCredentialAad(input: {
  credentialId: string;
  integrationId: string;
  owner: Owner;
  authorizedByUserId: string;
  kind: 'access' | 'refresh';
}): string {
  return JSON.stringify({
    scheme: FORGEJO_OAUTH_CREDENTIAL_ENVELOPE_SCHEME,
    version: 1,
    platform: PLATFORM.FORGEJO,
    credentialId: input.credentialId,
    integrationId: input.integrationId,
    owner: input.owner,
    authorizedByUserId: input.authorizedByUserId,
    kind: input.kind,
  });
}

export type StoreForgejoIntegrationInput = {
  owner: Owner;
  authorizedByUserId: string;
  forgejoUser: Pick<ForgejoUser, 'id' | 'login'>;
  tokens: ForgejoOAuthTokens;
  repositories: ForgejoRepository[];
};

export async function storeForgejoIntegration(input: StoreForgejoIntegrationInput): Promise<{
  integrationId: string;
}> {
  const integrationId = randomUUID();
  const credentialId = randomUUID();
  const providerSubjectId = String(input.forgejoUser.id);
  const selectedRepository = input.repositories.length === 1 ? input.repositories[0] : undefined;
  const repositoryList = input.repositories.map(repository => ({
    id: String(repository.id),
    name: repository.name,
    fullName: repository.full_name,
    private: repository.private,
    defaultBranch: repository.default_branch,
  }));
  const metadata = selectedRepository
    ? ForgejoIntegrationMetadataSchema.parse({
        state: 'active',
        repository: repositoryList[0],
      })
    : ForgejoIntegrationMetadataSchema.parse({
        state: 'repository_selection_required',
        repositories: repositoryList,
      });
  const encryptionKey = requireCredentialEncryptionKey();
  const accessTokenExpiresAt = new Date(Date.now() + input.tokens.expiresIn * 1000).toISOString();
  const accessTokenEncrypted = encryptKeyedEnvelope(
    input.tokens.accessToken,
    FORGEJO_OAUTH_CREDENTIAL_ENVELOPE_SCHEME,
    encryptionKey,
    buildForgejoOAuthCredentialAad({
      credentialId,
      integrationId,
      owner: input.owner,
      authorizedByUserId: input.authorizedByUserId,
      kind: 'access',
    })
  );
  const refreshTokenEncrypted = encryptKeyedEnvelope(
    input.tokens.refreshToken,
    FORGEJO_OAUTH_CREDENTIAL_ENVELOPE_SCHEME,
    encryptionKey,
    buildForgejoOAuthCredentialAad({
      credentialId,
      integrationId,
      owner: input.owner,
      authorizedByUserId: input.authorizedByUserId,
      kind: 'refresh',
    })
  );
  const credentialValues: NewPlatformOAuthCredential = {
    id: credentialId,
    platform_integration_id: integrationId,
    authorized_by_user_id: input.authorizedByUserId,
    provider_subject_id: providerSubjectId,
    provider_subject_login: input.forgejoUser.login,
    access_token_encrypted: accessTokenEncrypted,
    access_token_expires_at: accessTokenExpiresAt,
    refresh_token_encrypted: refreshTokenEncrypted,
  };

  return db.transaction(async tx => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`forgejo-oauth-owner:${input.owner.type}:${input.owner.id}`}, 0))`
    );

    if (input.owner.type === 'org') {
      const [authorizer] = await tx
        .select({ isAdmin: kilocode_users.is_admin })
        .from(kilocode_users)
        .where(
          and(eq(kilocode_users.id, input.authorizedByUserId), isNull(kilocode_users.blocked_reason))
        )
        .for('update');
      if (!authorizer) {
        throw new ForgejoIntegrationAuthorizationError(
          'Forgejo integration authorizer is no longer authorized'
        );
      }

      if (!authorizer.isAdmin) {
        const [membership] = await tx
          .select({ id: organization_memberships.id })
          .from(organization_memberships)
          .where(
            and(
              eq(organization_memberships.organization_id, input.owner.id),
              eq(organization_memberships.kilo_user_id, input.authorizedByUserId),
              inArray(organization_memberships.role, ORGANIZATION_BILLING_ROLES)
            )
          )
          .for('update');
        if (!membership) {
          throw new ForgejoIntegrationAuthorizationError(
            'Forgejo integration authorizer is no longer authorized'
          );
        }
      }
    }

    const [currentIntegration] = await tx
      .select({ id: platform_integrations.id })
      .from(platform_integrations)
      .where(
        and(ownerCondition(input.owner), eq(platform_integrations.platform, PLATFORM.FORGEJO))
      )
      .for('update');
    if (currentIntegration) {
      throw new ForgejoIntegrationConnectionConflictError();
    }

    await tx.insert(platform_integrations).values({
      id: integrationId,
      owned_by_user_id: input.owner.type === 'user' ? input.owner.id : null,
      owned_by_organization_id: input.owner.type === 'org' ? input.owner.id : null,
      created_by_user_id: input.authorizedByUserId,
      platform: PLATFORM.FORGEJO,
      integration_type: 'oauth',
      platform_installation_id: selectedRepository?.id ?? null,
      platform_account_id: selectedRepository?.id ?? null,
      platform_account_login: selectedRepository?.fullName ?? null,
      permissions: null,
      scopes: [
        ...(input.tokens.scope?.split(' ') ?? []),
        'read:repository',
        'write:repository',
        'read:user',
        'write:user',
      ],
      repository_access: selectedRepository ? 'all' : 'selected',
      repositories: selectedRepository ? null : repositoryList,
      integration_status: selectedRepository
        ? INTEGRATION_STATUS.ACTIVE
        : INTEGRATION_STATUS.PENDING,
      metadata,
    });
    await tx.insert(platform_oauth_credentials).values(credentialValues);

    return { integrationId };
  });
}

function requireCredentialEncryptionKey(): { keyId: string; publicKeyPem: Buffer } {
  const keyId = FORGEJO_OAUTH_CREDENTIAL_ACTIVE_KEY_ID;
  const encodedPublicKey = FORGEJO_OAUTH_CREDENTIAL_ACTIVE_PUBLIC_KEY;
  if (!keyId || keyId.trim() !== keyId || !encodedPublicKey) {
    throw new Error('Forgejo OAuth credential encryption is not configured');
  }

  const publicKeyPem = Buffer.from(encodedPublicKey, 'base64');
  try {
    if (publicKeyPem.toString('utf8').includes('PRIVATE KEY')) {
      throw new Error('Private key material is not allowed');
    }
    const publicKey = createPublicKey(publicKeyPem);
    if (publicKey.asymmetricKeyType !== 'rsa') {
      throw new Error('RSA public key is required');
    }
  } catch {
    throw new Error('Forgejo OAuth credential encryption is not configured');
  }
  return { keyId, publicKeyPem };
}

function ownerCondition(owner: Owner) {
  return owner.type === 'user'
    ? eq(platform_integrations.owned_by_user_id, owner.id)
    : eq(platform_integrations.owned_by_organization_id, owner.id);
}