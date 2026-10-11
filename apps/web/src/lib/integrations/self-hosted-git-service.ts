import 'server-only';

import { and, eq, isNull } from 'drizzle-orm';
import type { PlatformIntegration } from '@kilocode/db/schema';
import { platform_integrations } from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { INTEGRATION_STATUS, PLATFORM } from '@/lib/integrations/core/constants';
import type { Owner } from '@/lib/integrations/core/types';

/**
 * Gitea and Forgejo are the same upstream Git platform family: identical OAuth2
 * endpoints, identical `/api/v1` shape, and identical storage semantics. The
 * service layer is therefore shared and keyed on the platform constant rather
 * than duplicated per platform.
 */
export type SelfHostedGitPlatform = typeof PLATFORM.GITEA | typeof PLATFORM.FORGEJO;

const SELF_HOSTED_GIT_PLATFORMS: readonly SelfHostedGitPlatform[] = [
  PLATFORM.GITEA,
  PLATFORM.FORGEJO,
];

export function isSelfHostedGitPlatform(platform: string): platform is SelfHostedGitPlatform {
  return (SELF_HOSTED_GIT_PLATFORMS as readonly string[]).includes(platform);
}

function getOwnershipConditions(owner: Owner) {
  return owner.type === 'user'
    ? [
        eq(platform_integrations.owned_by_user_id, owner.id),
        isNull(platform_integrations.owned_by_organization_id),
      ]
    : [
        eq(platform_integrations.owned_by_organization_id, owner.id),
        isNull(platform_integrations.owned_by_user_id),
      ];
}

export async function getSelfHostedGitInstallation(
  owner: Owner,
  platform: SelfHostedGitPlatform
): Promise<PlatformIntegration | null> {
  const [integration] = await db
    .select()
    .from(platform_integrations)
    .where(and(...getOwnershipConditions(owner), eq(platform_integrations.platform, platform)))
    .orderBy(platform_integrations.updated_at)
    .limit(1);

  return integration || null;
}

export async function getSelfHostedGitInstallationById(
  integrationId: string,
  platform: SelfHostedGitPlatform
): Promise<PlatformIntegration | null> {
  const [integration] = await db
    .select()
    .from(platform_integrations)
    .where(
      and(eq(platform_integrations.id, integrationId), eq(platform_integrations.platform, platform))
    )
    .limit(1);

  return integration || null;
}

/**
 * Fully removes the integration and its credentials. Unlike GitLab there is no
 * webhook or upstream resource to preserve, so a plain delete keeps reconnect
 * behaviour identical to a first connect.
 */
export async function uninstallSelfHostedGitIntegration(
  owner: Owner,
  platform: SelfHostedGitPlatform
): Promise<{ success: boolean }> {
  await db
    .delete(platform_integrations)
    .where(and(...getOwnershipConditions(owner), eq(platform_integrations.platform, platform)));

  return { success: true };
}

export type SelfHostedGitConnectionStatus = {
  connected: boolean;
  integrationId: string | null;
  accountLogin: string | null;
  status: (typeof INTEGRATION_STATUS)[keyof typeof INTEGRATION_STATUS] | null;
  canManage: boolean;
};

export async function getSelfHostedGitConnectionStatus(
  owner: Owner,
  platform: SelfHostedGitPlatform
): Promise<Omit<SelfHostedGitConnectionStatus, 'canManage'>> {
  const integration = await getSelfHostedGitInstallation(owner, platform);

  if (!integration) {
    return {
      connected: false,
      integrationId: null,
      accountLogin: null,
      status: null,
    };
  }

  return {
    connected: integration.integration_status === INTEGRATION_STATUS.ACTIVE,
    integrationId: integration.id,
    accountLogin: integration.platform_account_login,
    status: integration.integration_status,
  };
}
