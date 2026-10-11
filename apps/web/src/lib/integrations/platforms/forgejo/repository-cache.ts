import 'server-only';

import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { platform_integrations, platform_oauth_credentials } from '@kilocode/db/schema';
import { captureException, captureMessage } from '@sentry/nextjs';
import { after } from 'next/server';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { INTEGRATION_STATUS, PLATFORM } from '@/lib/integrations/core/constants';
import type { Owner } from '@/lib/integrations/core/types';
import { ForgejoIntegrationMetadataSchema, ForgejoRepositoryMetadataSchema } from './metadata';

export const ForgejoRepositoryListResultSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('available'),
      repositories: z.array(ForgejoRepositoryMetadataSchema),
      syncedAt: z.iso.datetime(),
    })
    .strict(),
  z.object({ status: z.literal('not_connected') }).strict(),
  z.object({ status: z.literal('repository_selection_required') }).strict(),
  z.object({ status: z.literal('reconnect_required') }).strict(),
  z.object({ status: z.literal('temporarily_unavailable') }).strict(),
  z.object({ status: z.literal('invalid_request') }).strict(),
]);

export type ForgejoRepositoryListResult = z.infer<typeof ForgejoRepositoryListResultSchema>;

type ListForgejoRepositoriesInput = {
  owner: Owner;
  kiloUserId: string;
  expectedIntegrationId?: string;
};

type PrimeForgejoRepositoryCacheInput = {
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

export async function listForgejoRepositories({
  owner,
  expectedIntegrationId,
}: ListForgejoRepositoriesInput): Promise<ForgejoRepositoryListResult> {
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
      revokedAt: platform_oauth_credentials.revoked_at,
    })
    .from(platform_integrations)
    .leftJoin(
      platform_oauth_credentials,
      eq(platform_oauth_credentials.platform_integration_id, platform_integrations.id)
    )
    .where(and(ownerCondition(owner), eq(platform_integrations.platform, PLATFORM.FORGEJO)))
    .limit(1);

  if (!row) return { status: 'not_connected' };
  if (expectedIntegrationId && row.integrationId !== expectedIntegrationId) {
    return { status: 'temporarily_unavailable' };
  }
  if (row.revokedAt) {
    return { status: 'reconnect_required' };
  }

  const metadata = ForgejoIntegrationMetadataSchema.safeParse(row.metadata);
  if (!metadata.success) return { status: 'reconnect_required' };

  if (
    row.integrationStatus === INTEGRATION_STATUS.PENDING &&
    metadata.data.state === 'repository_selection_required'
  ) {
    return { status: 'repository_selection_required' };
  }

  if (
    row.integrationStatus !== INTEGRATION_STATUS.ACTIVE ||
    metadata.data.state !== 'active' ||
    row.installationId !== String(metadata.data.repository.id) ||
    row.accountId !== String(metadata.data.repository.id) ||
    row.accountLogin !== metadata.data.repository.full_name
  ) {
    return { status: 'reconnect_required' };
  }

  const syncedAt = row.repositoriesSyncedAt
    ? new Date(row.repositoriesSyncedAt).toISOString()
    : null;

  const stored = z.array(ForgejoRepositoryMetadataSchema).safeParse(row.repositories);
  const repositories =
    stored.success && stored.data.length > 0 ? stored.data : [metadata.data.repository];

  // The OAuth token is stored encrypted under a key only the git-token-service
  // holds, so this cache reads what the connect flow already captured instead of
  // re-fetching the provider with the stored credential.
  return {
    status: 'available',
    repositories,
    syncedAt: syncedAt ?? new Date().toISOString(),
  };
}

export function scheduleForgejoRepositoryCachePrime(input: PrimeForgejoRepositoryCacheInput): void {
  after(() => primeForgejoRepositoryCache(input));
}

export async function primeForgejoRepositoryCache({
  owner,
  kiloUserId,
  integrationId,
}: PrimeForgejoRepositoryCacheInput): Promise<void> {
  try {
    const result = await listForgejoRepositories({
      owner,
      kiloUserId,
      expectedIntegrationId: integrationId,
    });
    if (result.status !== 'available') {
      captureMessage('Forgejo repository cache prime failed', {
        level: 'warning',
        tags: { source: 'forgejo_repository_cache', operation: 'prime' },
        extra: { integrationId, ownerType: owner.type, status: result.status },
      });
    }
  } catch (error) {
    captureException(error, {
      tags: { source: 'forgejo_repository_cache', operation: 'prime' },
      extra: { integrationId, ownerType: owner.type },
    });
  }
}
