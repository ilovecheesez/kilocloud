import 'server-only';

import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { platform_integrations, platform_oauth_credentials } from '@kilocode/db/schema';
import { GiteaOAuthCredentialRowSchema } from '@kilocode/worker-utils/gitea-workspace-access-token';
import { captureException, captureMessage } from '@sentry/nextjs';
import { after } from 'next/server';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { INTEGRATION_STATUS, PLATFORM } from '@/lib/integrations/core/constants';
import type { Owner } from '@/lib/integrations/core/types';
import {
  GiteaIntegrationMetadataSchema,
  GiteaRepositorySchema,
  type GiteaRepository,
} from './metadata';

const CachedGiteaRepositorySchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    full_name: z.string().min(3),
    private: z.boolean(),
    default_branch: z.string().min(1).optional(),
  })
  .strict();

export const CachedGiteaRepositoryListResultSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('available'),
      repositories: z.array(GiteaRepositorySchema),
      syncedAt: z.iso.datetime(),
    })
    .strict(),
  z.object({ status: z.literal('not_connected') }).strict(),
  z.object({ status: z.literal('workspace_selection_required') }).strict(),
  z.object({ status: z.literal('reconnect_required') }).strict(),
  z.object({ status: z.literal('insufficient_permissions') }).strict(),
  z.object({ status: z.literal('temporarily_unavailable') }).strict(),
  z.object({ status: z.literal('invalid_request') }).strict(),
]);

export type CachedGiteaRepositoryListResult = z.infer<
  typeof CachedGiteaRepositoryListResultSchema
>;

type ListGiteaRepositoriesInput = {
  owner: Owner;
  kiloUserId: string;
  forceRefresh?: boolean;
  expectedIntegrationId?: string;
};

type PrimeGiteaRepositoryCacheInput = {
  owner: Owner;
  kiloUserId: string;
  integrationId: string;
};

function ownerCondition(owner: Owner) {
  return owner.type === 'user'
    ? and(
        eq(platform_integrations.owned_by_user_id, owner.id),
        isNull(platform_integrations.owned_by_organization_id)
      )
    : eq(platform_integrations.owned_by_organization_id, owner.id);
}

function readCachedRepositories(
  value: unknown,
  syncedAt: string | null,
  repository: GiteaRepository
): Extract<CachedGiteaRepositoryListResult, { status: 'available' }> | null {
  if (value === null || !syncedAt) return null;
  const repositories = z.array(CachedGiteaRepositorySchema).safeParse(value);
  if (!repositories.success) return null;
  return {
    status: 'available',
    repositories: repositories.data.map(repository => ({
      id: repository.id,
      name: repository.name,
      fullName: repository.full_name,
      private: repository.private,
      defaultBranch: repository.default_branch,
    })),
    syncedAt: new Date(syncedAt).toISOString(),
  };
}

export async function listGiteaRepositories({
  owner,
  kiloUserId,
  forceRefresh = false,
  expectedIntegrationId,
}: ListGiteaRepositoriesInput): Promise<CachedGiteaRepositoryListResult> {
  const [row] = await db
    .select({
      integrationId: platform_integrations.id,
      integrationStatus: platform_integrations.integration_status,
      installationId: platform_integrations.platform_installation_id,
      accountId: platform_integrations.platform_account_id,
      accountLogin: platform_integrations.platform_account_login,
      metadata: platform_integrations.metadata,
      repositories: platform_integrations.repositories,
      repositoriesSyncedAt: platform_integrations.repositories_synced_at,
      credential: platform_oauth_credentials,
    })
    .from(platform_integrations)
    .leftJoin(
      platform_oauth_credentials,
      eq(platform_oauth_credentials.platform_integration_id, platform_integrations.id)
    )
    .where(and(ownerCondition(owner), eq(platform_integrations.platform, PLATFORM.GITEA)))
    .limit(1);

  if (!row) return { status: 'not_connected' };
  if (expectedIntegrationId && row.integrationId !== expectedIntegrationId) {
    return { status: 'temporarily_unavailable' };
  }
  const credential = GiteaOAuthCredentialRowSchema.safeParse(row.credential);
  if (!credential.success || credential.data.revoked_at) {
    return { status: 'reconnect_required' };
  }

  const metadata = GiteaIntegrationMetadataSchema.safeParse(row.metadata);
  if (!metadata.success) return { status: 'reconnect_required' };
  if (
    row.integrationStatus === INTEGRATION_STATUS.PENDING &&
    metadata.data.state === 'workspace_selection_required'
  ) {
    return { status: 'workspace_selection_required' };
  }
  if (
    row.integrationStatus !== INTEGRATION_STATUS.ACTIVE ||
    metadata.data.state !== 'active' ||
    row.installationId !== metadata.data.repository.id ||
    row.accountId !== metadata.data.repository.id ||
    row.accountLogin !== metadata.data.repository.fullName
  ) {
    return { status: 'reconnect_required' };
  }

  const cachedResult = readCachedRepositories(
    row.repositories,
    row.repositoriesSyncedAt,
    metadata.data.repository
  );
  if (!forceRefresh && cachedResult) return cachedResult;

  // Repository fetching would be triggered from the worker via token-service-client
  // For now, return cached state with a note
  return {
    status: 'available',
    repositories: metadata.data.repositories,
    syncedAt: new Date().toISOString(),
  };
}

export function scheduleGiteaRepositoryCachePrime(
  input: PrimeGiteaRepositoryCacheInput
): void {
  after(() => primeGiteaRepositoryCache(input));
}

export async function primeGiteaRepositoryCache({
  owner,
  kiloUserId,
  integrationId,
}: PrimeGiteaRepositoryCacheInput): Promise<void> {
  try {
    const result = await listGiteaRepositories({
      owner,
      kiloUserId,
      forceRefresh: true,
      expectedIntegrationId: integrationId,
    });
    if (result.status !== 'available') {
      captureMessage('Gitea repository cache prime failed', {
        level: 'warning',
        tags: { source: 'gitea_repository_cache', operation: 'prime' },
        extra: { integrationId, ownerType: owner.type, status: result.status },
      });
    }
  } catch (error) {
    captureException(error, {
      tags: { source: 'gitea_repository_cache', operation: 'prime' },
      extra: { integrationId, ownerType: owner.type },
    });
  }
}