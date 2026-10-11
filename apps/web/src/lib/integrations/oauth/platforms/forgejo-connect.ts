import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { captureException } from '@sentry/nextjs';
import { APP_URL } from '@kilocode/web-shared/lib/constants';
import { PLATFORM } from '@/lib/integrations/core/constants';
import type { Owner } from '@/lib/integrations/core/types';
import { buildForgejoOAuthUrl } from '@/lib/integrations/platforms/forgejo/adapter';
import { createOAuthState } from '@/lib/integrations/oauth-state';
import {
  buildIntegrationOAuthConnectErrorPath,
  redirectToSignInForOAuthConnect,
} from '@/lib/integrations/oauth/common';
import { validateReturnPath } from '@/lib/integrations/validate-return-path';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import { ORGANIZATION_BILLING_ROLES } from '@kilocode/app-shared/organizations';
import { ensureOrganizationAccess } from '@kilocode/web-shared/routers/organizations/utils';

function detailPath(organizationId: string | null): string {
  return organizationId
    ? `/organizations/${organizationId}/integrations/forgejo`
    : '/integrations/forgejo';
}

export async function handleForgejoOAuthConnect(request: NextRequest): Promise<Response> {
  const organizationId = request.nextUrl.searchParams.get('organizationId');

  try {
    const { user, authFailedResponse } = await getUserFromAuth({ adminOnly: false });
    if (authFailedResponse) {
      return redirectToSignInForOAuthConnect(request, detailPath(organizationId));
    }

    const owner: Owner = organizationId
      ? { type: 'org', id: organizationId }
      : { type: 'user', id: user.id };
    if (owner.type === 'org') {
      await ensureOrganizationAccess({ user }, owner.id, ORGANIZATION_BILLING_ROLES);
    }

    const returnToParam = request.nextUrl.searchParams.get('returnTo');
    const returnTo = returnToParam ? validateReturnPath(returnToParam) : null;
    const state = createOAuthState(`${owner.type}_${owner.id}`, user.id, returnTo ?? undefined);
    return NextResponse.redirect(buildForgejoOAuthUrl(state));
  } catch (error) {
    captureException(error, {
      tags: { endpoint: 'forgejo/connect', source: 'forgejo_oauth' },
      extra: { hasOrganizationId: Boolean(organizationId) },
    });
    return NextResponse.redirect(
      new URL(
        buildIntegrationOAuthConnectErrorPath(
          PLATFORM.FORGEJO,
          organizationId,
          'oauth_init_failed'
        ),
        APP_URL
      )
    );
  }
}
