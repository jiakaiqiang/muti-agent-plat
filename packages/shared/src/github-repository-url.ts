export type GitHubRepositoryRef = {
  provider: 'github';
  owner: string;
  repository: string;
  repositoryId: string;
  repositoryUrl: string;
};

export function normalizeGitHubRepositoryUrl(value: string): GitHubRepositoryRef {
  const invalid = () => new Error('GITHUB_REPOSITORY_URL_INVALID');
  if (typeof value !== 'string' || value.length > 512 || value.includes('%')) throw invalid();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalid();
  }
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port ||
      url.username || url.password || url.search || url.hash) throw invalid();
  const segments = url.pathname.replace(/\/$/, '').split('/');
  if (segments.length !== 3 || segments[0] !== '') throw invalid();
  const owner = segments[1]?.toLowerCase();
  const repository = segments[2]?.replace(/\.git$/i, '').toLowerCase();
  if (!owner || !repository ||
      !/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/.test(owner) ||
      !/^[a-z0-9][a-z0-9._-]{0,99}$/.test(repository) ||
      repository === '.' || repository === '..') throw invalid();
  const repositoryId = `${owner}/${repository}`;
  return { provider: 'github', owner, repository, repositoryId,
    repositoryUrl: `https://github.com/${repositoryId}` };
}
