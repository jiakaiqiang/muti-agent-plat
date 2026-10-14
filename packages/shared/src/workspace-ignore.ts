export const GENERATED_WORKSPACE_DIRECTORIES = [
  '.git',
  'node_modules',
  'dist',
  'build',
  'generated',
  '.next',
  '.nuxt',
  '.output',
  '.vite',
  '.turbo',
  '.cache',
  '.agent-cluster',
  'coverage',
  '.venv',
  'venv',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache'
] as const;

const generatedWorkspaceDirectorySet = new Set<string>(GENERATED_WORKSPACE_DIRECTORIES);

export function isGeneratedWorkspaceDirectory(name: string) {
  return generatedWorkspaceDirectorySet.has(name);
}
