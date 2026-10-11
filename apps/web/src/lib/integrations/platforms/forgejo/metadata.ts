import { z } from 'zod';

export const MAX_FORGEJO_REPOSITORIES = 500;

const NonEmptyMetadataStringSchema = z
  .string()
  .min(1)
  .refine(value => value.trim() === value);

export const ForgejoRepositorySchema = z
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

export const ForgejoRepositoryMetadataSchema = z
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

const PendingForgejoIntegrationMetadataSchema = z
  .object({
    state: z.literal('repository_selection_required'),
    repositories: z.array(ForgejoRepositoryMetadataSchema).min(1).max(MAX_FORGEJO_REPOSITORIES),
  })
  .strict();

const ActiveForgejoIntegrationMetadataSchema = z
  .object({
    state: z.literal('active'),
    repository: ForgejoRepositoryMetadataSchema,
  })
  .strict();

export const ForgejoIntegrationMetadataSchema = z.discriminatedUnion('state', [
  PendingForgejoIntegrationMetadataSchema,
  ActiveForgejoIntegrationMetadataSchema,
]);

export type ForgejoRepository = z.infer<typeof ForgejoRepositorySchema>;
export type ForgejoRepositoryMetadata = z.infer<typeof ForgejoRepositoryMetadataSchema>;
export type ForgejoIntegrationMetadata = z.infer<typeof ForgejoIntegrationMetadataSchema>;