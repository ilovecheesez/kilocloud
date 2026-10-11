import 'server-only';

import { z } from 'zod';
import { baseProcedure, createTRPCRouter } from '@kilocode/web-shared/lib/trpc/init';
import {
  optionalOrgInput,
  resolveAuthorizedOwner,
  resolveOwner,
} from '@/lib/integrations/resolve-owner';
import { ensureOrganizationAccess } from '@kilocode/web-shared/routers/organizations/utils';
import { PLATFORM } from '@/lib/integrations/core/constants';
import {
  getSelfHostedGitConnectionStatus,
  uninstallSelfHostedGitIntegration,
} from '@/lib/integrations/self-hosted-git-service';
import { listForgejoRepositories } from '@/lib/integrations/platforms/forgejo/repository-cache';

/**
 * Gitea and Forgejo share one router shape because they are the same platform
 * family: a single OAuth integration row per owner, read back from the
 * repositories the connect flow already captured.
 */
export const forgejoRouter = createTRPCRouter({
  getConnection: baseProcedure.input(optionalOrgInput).query(async ({ ctx, input }) => {
    if (input?.organizationId) {
      await ensureOrganizationAccess(ctx, input.organizationId);
    }
    const owner = resolveOwner(ctx, input?.organizationId);
    const status = await getSelfHostedGitConnectionStatus(owner, PLATFORM.FORGEJO);

    if (!status.integrationId) {
      return { ...status, repositories: [] };
    }

    const result = await listForgejoRepositories({
      owner,
      kiloUserId: ctx.user.id,
      expectedIntegrationId: status.integrationId,
    });

    const repositories =
      result.status === 'available'
        ? result.repositories.map(repository => ({
            id: String(repository.id),
            name: repository.name,
            fullName: repository.full_name,
            private: repository.private,
            defaultBranch: repository.default_branch,
          }))
        : [];

    return { ...status, repositories };
  }),

  disconnect: baseProcedure
    .input(z.object({ organizationId: z.string().uuid().optional() }))
    .mutation(async ({ ctx, input }) => {
      const owner = await resolveAuthorizedOwner(ctx, input.organizationId);
      return uninstallSelfHostedGitIntegration(owner, PLATFORM.FORGEJO);
    }),
});
