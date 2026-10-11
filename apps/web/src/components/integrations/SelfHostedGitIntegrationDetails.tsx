'use client';

import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, CheckCircle2, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { useConfirm } from '@/components/ui/confirm';
import { useTRPC } from '@/lib/trpc/utils';
import { PLATFORM } from '@/lib/integrations/core/constants';
import { getPlatformOAuthConnectPath } from '@/lib/integrations/oauth/paths';
import { ForgejoLogo } from '@/components/auth/ForgejoLogo';
import { GiteaLogo } from '@/components/auth/GiteaLogo';

export const SELF_HOSTED_GIT_PLATFORMS = [PLATFORM.GITEA, PLATFORM.FORGEJO] as const;

export type SelfHostedGitPlatformId = (typeof SELF_HOSTED_GIT_PLATFORMS)[number];

const platformLabels: Record<SelfHostedGitPlatformId, string> = {
  [PLATFORM.GITEA]: 'Gitea',
  [PLATFORM.FORGEJO]: 'Forgejo',
};

const platformLogos: Record<
  SelfHostedGitPlatformId,
  React.ComponentType<{ className?: string }>
> = {
  [PLATFORM.GITEA]: GiteaLogo,
  [PLATFORM.FORGEJO]: ForgejoLogo,
};

const connectionErrorMessages: Record<SelfHostedGitPlatformId, Record<string, string>> = {
  [PLATFORM.GITEA]: {
    authorization_cancelled:
      'Gitea authorization was cancelled. No changes were made. Start OAuth again when you are ready.',
    invalid_state: 'Gitea authorization expired or could not be verified. Start OAuth again.',
    unauthorized:
      "You don't have access to connect Gitea for this owner. Ask an owner or billing manager to connect it.",
    missing_code: 'Gitea did not return an authorization code. Start OAuth again.',
    no_repositories:
      'The authorized Gitea account has no repositories. Connect an account with repository access, then try again.',
    connection_exists:
      'Gitea is already connected. Disconnect the current connection before using OAuth.',
    connection_failed: 'Gitea could not be connected. Try OAuth again in a minute.',
  },
  [PLATFORM.FORGEJO]: {
    authorization_cancelled:
      'Forgejo authorization was cancelled. No changes were made. Start OAuth again when you are ready.',
    invalid_state: 'Forgejo authorization expired or could not be verified. Start OAuth again.',
    unauthorized:
      "You don't have access to connect Forgejo for this owner. Ask an owner or billing manager to connect it.",
    missing_code: 'Forgejo did not return an authorization code. Start OAuth again.',
    no_repositories:
      'The authorized Forgejo account has no repositories. Connect an account with repository access, then try again.',
    connection_exists:
      'Forgejo is already connected. Disconnect the current connection before using OAuth.',
    connection_failed: 'Forgejo could not be connected. Try OAuth again in a minute.',
  },
};

function getConnectionErrorMessage(platform: SelfHostedGitPlatformId, error: string): string {
  return (
    connectionErrorMessages[platform][error] ??
    `${platformLabels[platform]} could not be connected. Try OAuth again in a minute.`
  );
}

export function SelfHostedGitConnectionRedirectNotice({
  platform,
  error,
}: {
  platform: SelfHostedGitPlatformId;
  error?: string;
}) {
  if (!error) return null;

  const isAuthorizationCancelled = error === 'authorization_cancelled';
  const label = platformLabels[platform];

  return (
    <Alert variant={isAuthorizationCancelled ? 'warning' : 'destructive'}>
      <AlertCircle />
      <AlertTitle>
        {isAuthorizationCancelled ? `${label} OAuth was cancelled` : `Could not connect ${label}`}
      </AlertTitle>
      <AlertDescription>{getConnectionErrorMessage(platform, error)}</AlertDescription>
    </Alert>
  );
}

function LoadingState({ platform }: { platform: SelfHostedGitPlatformId }) {
  const label = platformLabels[platform];
  return (
    <Card>
      <CardHeader className="space-y-3">
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-4 w-full max-w-md" />
      </CardHeader>
      <CardContent className="space-y-6">
        <Skeleton className="h-28 w-full" />
        <Skeleton className="h-40 w-full" />
      </CardContent>
      <span className="sr-only">Loading {label} connection status...</span>
    </Card>
  );
}

type SelfHostedGitIntegrationDetailsProps = {
  platform: SelfHostedGitPlatformId;
  organizationId?: string;
  success?: boolean;
  error?: string;
};

export function SelfHostedGitIntegrationDetails({
  platform,
  organizationId,
  success,
  error,
}: SelfHostedGitIntegrationDetailsProps) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const Logo = platformLogos[platform];
  const label = platformLabels[platform];
  // Gitea and Forgejo routers expose the same shape, so a single union value
  // serves both call sites without per-platform branching.
  const platformRouter = platform === PLATFORM.GITEA ? trpc.gitea : trpc.forgejo;
  const queryOptions = platformRouter.getConnection.queryOptions({ organizationId });

  const statusQuery = useQuery(queryOptions);

  const disconnect = useMutation(
    platformRouter.disconnect.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: queryOptions.queryKey });
      },
    })
  );

  React.useEffect(() => {
    if (success) {
      toast.success(`${label} connected successfully`);
    }
    if (error) {
      toast.error(getConnectionErrorMessage(platform, error));
    }
  }, [success, error, label, platform]);

  const handleConnect = () => {
    window.location.href = getPlatformOAuthConnectPath(platform, organizationId);
  };

  const handleDisconnect = async () => {
    if (
      !(await confirm({
        title: `Disconnect ${label}?`,
        description: `Kilo will lose access to your ${label} repositories. You can reconnect later.`,
        confirmLabel: 'Disconnect',
        destructive: true,
      }))
    ) {
      return;
    }

    disconnect.mutate(
      { organizationId },
      {
        onSuccess: async () => {
          toast.success(`${label} disconnected`);
          await statusQuery.refetch();
        },
        onError: err => {
          toast.error(`Failed to disconnect ${label}`, { description: err.message });
        },
      }
    );
  };

  if (statusQuery.isLoading) {
    return <LoadingState platform={platform} />;
  }

  if (!statusQuery.data) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Logo className="size-5" />
            {label}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Alert variant="destructive">
            <AlertCircle />
            <AlertTitle>{label} status is unavailable</AlertTitle>
            <AlertDescription>
              Refresh the page to try again. No integration settings were changed.
            </AlertDescription>
          </Alert>
        </CardContent>
      </Card>
    );
  }

  const { connected, accountLogin, repositories } = statusQuery.data;

  return (
    <div className="space-y-6">
      <SelfHostedGitConnectionRedirectNotice platform={platform} error={error} />

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Logo className="size-5" />
                {label} Integration
              </CardTitle>
              <CardDescription>
                Connect your {label} repositories for AI code reviews and Cloud Agent sessions
              </CardDescription>
            </div>
            {connected ? (
              <Badge variant="default" className="flex items-center gap-1">
                <CheckCircle2 className="size-3" />
                Connected
              </Badge>
            ) : (
              <Badge variant="secondary" className="flex items-center gap-1">
                <XCircle className="size-3" />
                Not Connected
              </Badge>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {connected ? (
            <>
              <div className="space-y-3 rounded-lg border p-4">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">Account</span>
                  <span className="text-sm">{accountLogin ?? 'Unknown'}</span>
                </div>
                <div className="space-y-2">
                  <span className="text-sm font-medium">Repositories</span>
                  {repositories.length === 0 ? (
                    <p className="text-muted-foreground text-sm">
                      No repositories cached yet. Reconnect {label} to refresh them.
                    </p>
                  ) : (
                    <ul className="space-y-1">
                      {repositories.map(repository => (
                        <li key={repository.id} className="text-sm">
                          {repository.fullName}
                          {repository.private ? ' (private)' : ''}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>

              <div className="flex flex-wrap gap-3">
                <Button
                  variant="destructive"
                  onClick={handleDisconnect}
                  disabled={disconnect.isPending}
                >
                  {disconnect.isPending ? 'Disconnecting...' : `Disconnect ${label}`}
                </Button>
              </div>
            </>
          ) : (
            <>
              <Alert>
                <AlertDescription>
                  Connect {label} to use your repositories in Cloud Agent sessions.
                </AlertDescription>
              </Alert>

              <div className="space-y-2 rounded-lg border p-4">
                <h4 className="font-medium">What you&apos;ll get:</h4>
                <ul className="text-muted-foreground space-y-1 text-sm">
                  <li>Access to your {label} repositories from Cloud Agent</li>
                  <li>Repository selection captured at connect time</li>
                  <li>Direct OAuth sign-in with your {label} account</li>
                </ul>
              </div>

              <Button onClick={handleConnect} size="lg" className="w-full">
                <Logo className="mr-2 size-4" />
                {`Connect ${label}`}
              </Button>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
