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
  'coverage'
] as const;

const generatedWorkspaceDirectorySet = new Set<string>(GENERATED_WORKSPACE_DIRECTORIES);

export function isGeneratedWorkspaceDirectory(name: string) {
  return generatedWorkspaceDirectorySet.has(name);
}
