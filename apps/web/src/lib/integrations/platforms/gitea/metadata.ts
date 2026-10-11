import { z } from 'zod';

export const MAX_GITEA_REPOSITORIES = 500;

const NonEmptyMetadataStringSchema = z
  .string()
  .min(1)
  .refine(value => value.trim() === value);

export const GiteaRepositorySchema = z
  .object({
    id: z.number().int().positive(),
    name: NonEmptyMetadataStringSchema,
    full_name: z.string().min(3),
    private: z.boolean(),
    default_branch: z.string().min(1).optional(),
    html_url: z.string().url().optional(),
    ssh_url: z.string().optional(),
    clone_url: z.string().url().optional(),
  })
  .strict();

export const GiteaRepositoryMetadataSchema = z
  .object({
    id: z.number().int().positive(),
    name: NonEmptyMetadataStringSchema,
    full_name: z.string().min(3),
    private: z.boolean(),
    default_branch: z.string().min(1).optional(),
    html_url: z.string().url().optional(),
    ssh_url: z.string().optional(),
    clone_url: z.string().url().optional(),
  })
  .strict();

const PendingGiteaIntegrationMetadataSchema = z
  .object({
    state: z.literal('repository_selection_required'),
    repositories: z.array(GiteaRepositoryMetadataSchema).min(1).max(MAX_GITEA_REPOSITORIES),
  })
  .strict();

const ActiveGiteaIntegrationMetadataSchema = z
  .object({
    state: z.literal('active'),
    repository: GiteaRepositoryMetadataSchema,
  })
  .strict();

export const GiteaIntegrationMetadataSchema = z.discriminatedUnion('state', [
  PendingGiteaIntegrationMetadataSchema,
  ActiveGiteaIntegrationMetadataSchema,
]);

export type GiteaRepository = z.infer<typeof GiteaRepositorySchema>;
export type GiteaRepositoryMetadata = z.infer<typeof GiteaRepositoryMetadataSchema>;
export type GiteaIntegrationMetadata = z.infer<typeof GiteaIntegrationMetadataSchema>;