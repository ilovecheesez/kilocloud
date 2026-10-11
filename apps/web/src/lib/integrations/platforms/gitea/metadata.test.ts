import { GiteaIntegrationMetadataSchema, GiteaRepositorySchema } from './metadata';

function repository(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 42,
    name: 'demo',
    full_name: 'kilo/demo',
    private: false,
    default_branch: 'main',
    html_url: 'https://gitea.com/kilo/demo',
    ssh_url: 'git@gitea.com:kilo/demo.git',
    clone_url: 'https://gitea.com/kilo/demo.git',
    ...overrides,
  };
}

describe('GiteaRepositorySchema', () => {
  it('parses a repository payload', () => {
    expect(GiteaRepositorySchema.parse(repository())).toEqual(repository());
  });

  it('rejects a blank name', () => {
    expect(GiteaRepositorySchema.safeParse(repository({ name: '   ' })).success).toBe(false);
  });

  it('rejects a non-positive id', () => {
    expect(GiteaRepositorySchema.safeParse(repository({ id: 0 })).success).toBe(false);
  });
});

describe('GiteaIntegrationMetadataSchema', () => {
  it('accepts pending metadata with the repositories awaiting selection', () => {
    const metadata = {
      state: 'repository_selection_required',
      repositories: [
        repository(),
        repository({ id: 43, name: 'second', full_name: 'kilo/second' }),
      ],
    };

    expect(GiteaIntegrationMetadataSchema.parse(metadata)).toEqual(metadata);
  });

  it('accepts active metadata with one selected repository', () => {
    const metadata = { state: 'active', repository: repository() };

    expect(GiteaIntegrationMetadataSchema.parse(metadata)).toEqual(metadata);
  });

  it('rejects pending metadata without any repository', () => {
    expect(
      GiteaIntegrationMetadataSchema.safeParse({
        state: 'repository_selection_required',
        repositories: [],
      }).success
    ).toBe(false);
  });

  it('rejects pending metadata above the repository item limit', () => {
    expect(
      GiteaIntegrationMetadataSchema.safeParse({
        state: 'repository_selection_required',
        repositories: Array.from({ length: 501 }, (_, index) =>
          repository({ id: index + 1, name: `repo-${index}`, full_name: `kilo/repo-${index}` })
        ),
      }).success
    ).toBe(false);
  });

  it('rejects secret-shaped fields instead of stripping them', () => {
    expect(
      GiteaIntegrationMetadataSchema.safeParse({
        state: 'active',
        repository: repository({ access_token: 'must-not-be-stored' }),
      }).success
    ).toBe(false);
  });

  it('rejects an unknown state', () => {
    expect(
      GiteaIntegrationMetadataSchema.safeParse({
        state: 'workspace_selection_required',
        repositories: [repository()],
      }).success
    ).toBe(false);
  });
});
