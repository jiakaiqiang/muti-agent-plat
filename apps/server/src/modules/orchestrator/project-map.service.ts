import { Injectable } from '@nestjs/common';
import type { ContextPack, ProjectMap, ProjectMapModule, SessionDetail, WorkspaceSnapshot } from '@agent-cluster/shared';
import { nowIso } from '../../common/time.js';

@Injectable()
export class ProjectMapService {
  buildProjectMap(session: SessionDetail, workspaceFocus?: ContextPack['workspaceFocus']): ProjectMap | undefined {
    const snapshot = session.workspaceSnapshot;
    if (!snapshot) return undefined;

    const focus = workspaceFocus ?? this.workspaceFocus(session);
    const modules = this.projectMapModules(snapshot, focus);
    const sourceRefs = this.uniqueFirstStrings(
      [
        ...this.projectInstructionFiles(snapshot),
        ...this.workspaceConfigFiles(snapshot),
        ...(snapshot.entrypoints ?? []),
        ...(focus?.relevantFiles ?? [])
      ],
      16
    );

    return {
      source: sourceRefs.length ? 'merged' : 'generated',
      modules,
      validationCommands: focus?.validationCommands ?? this.workspaceValidationCommands(snapshot),
      riskBoundaries: [
        'Stay within the selected workspace snapshot and capability policy.',
        'Do not treat workspace context as write permission.',
        ...snapshot.skipped.slice(0, 6).map((item) => `Skipped ${item.path}: ${item.reason}`)
      ],
      memoryLocations: this.projectMemoryLocations(snapshot),
      sourceRefs,
      generatedAt: nowIso()
    };
  }

  workspaceFocus(session: SessionDetail): ContextPack['workspaceFocus'] {
    const snapshot = session.workspaceSnapshot;
    if (!snapshot) return undefined;
    const relevantFiles = snapshot.files
      .map((file) => ({
        path: file.path,
        score: this.workspaceFileRelevanceScore(file.path, session.originalInput)
      }))
      .filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
      .map((item) => item.path)
      .slice(0, 12);
    const fallbackFiles = snapshot.files.map((file) => file.path).slice(0, 8);
    const selectedRelevantFiles = relevantFiles.length ? relevantFiles : fallbackFiles;
    const entrypoints = snapshot.entrypoints ?? [];
    const configFiles = this.workspaceConfigFiles(snapshot);
    const testFiles = this.workspaceTestFiles(snapshot, selectedRelevantFiles);
    const impactedFiles = this.workspaceImpactedFiles(snapshot, selectedRelevantFiles, entrypoints);
    const validationCommands = this.workspaceValidationCommands(snapshot);
    return {
      relevantFiles: selectedRelevantFiles,
      impactedFiles,
      testFiles,
      configFiles,
      possibleEntryPoints: entrypoints,
      detectedStack: snapshot.detectedStack ?? [],
      validationCommands,
      rationale: relevantFiles.length
        ? 'Matched workspace file paths against user requirement keywords, then added impacted files, tests, configs, entrypoints, and validation scripts.'
        : 'No strong keyword match was found, so the first readable workspace files are used with detected tests, configs, entrypoints, and validation scripts.'
    };
  }

  private projectMapModules(snapshot: WorkspaceSnapshot, focus?: ContextPack['workspaceFocus']): ProjectMapModule[] {
    const filesByTopLevel = new Map<string, string[]>();
    for (const file of snapshot.files) {
      const topLevel = file.path.split('/')[0] || file.path;
      const files = filesByTopLevel.get(topLevel) ?? [];
      files.push(file.path);
      filesByTopLevel.set(topLevel, files);
    }

    const focusedTopLevels = new Set(
      [
        ...(focus?.impactedFiles ?? []),
        ...(focus?.relevantFiles ?? []),
        ...(focus?.possibleEntryPoints ?? [])
      ]
        .map((path) => path.split('/')[0] || path)
        .filter(Boolean)
    );
    const orderedTopLevels = [
      ...Array.from(focusedTopLevels),
      ...Array.from(filesByTopLevel.keys()).filter((topLevel) => !focusedTopLevels.has(topLevel))
    ];

    return orderedTopLevels.slice(0, 12).map((topLevel) => {
      const files = filesByTopLevel.get(topLevel) ?? [];
      const entrypoints = this.uniqueFirstStrings(
        [...(focus?.possibleEntryPoints ?? []).filter((path) => path.startsWith(`${topLevel}/`) || path === topLevel), ...this.entrypointLikeFiles(files)],
        6
      );
      const contracts = this.contractLikeFiles(files);
      const tests = this.uniqueFirstStrings(
        [...(focus?.testFiles ?? []).filter((path) => path.startsWith(`${topLevel}/`) || path === topLevel), ...files.filter((path) => this.isWorkspaceTestPath(path))],
        8
      );
      return {
        name: topLevel,
        path: topLevel,
        responsibility: this.moduleResponsibility(topLevel, files),
        entrypoints,
        contracts,
        tests,
        commonTasks: this.moduleCommonTasks(topLevel, files)
      };
    });
  }

  private moduleResponsibility(topLevel: string, files: string[]) {
    const lower = topLevel.toLowerCase();
    if (lower === 'apps') return 'Application entrypoints and runnable product surfaces.';
    if (lower === 'packages') return 'Shared packages, contracts, fixtures, or reusable libraries.';
    if (lower === 'docs') return 'Product, design, contract, quality, and operational documentation.';
    if (lower === 'tests') return 'Automated smoke, e2e, contract, and harness verification.';
    if (files.some((path) => path.includes('/components/'))) return 'Frontend components and user-facing interaction surfaces.';
    if (files.some((path) => path.includes('/modules/'))) return 'Backend service modules and runtime orchestration logic.';
    return 'Workspace module inferred from directory structure and selected evidence.';
  }

  private moduleCommonTasks(topLevel: string, files: string[]) {
    const tasks = ['inspect related files before acting'];
    if (files.some((path) => this.isWorkspaceTestPath(path))) tasks.push('run or update scoped tests');
    if (files.some((path) => path.endsWith('package.json'))) tasks.push('check package scripts and dependencies');
    if (topLevel.toLowerCase() === 'docs') tasks.push('keep documentation indexes in sync');
    if (topLevel.toLowerCase() === 'packages') tasks.push('preserve shared contracts across frontend and backend');
    return tasks;
  }

  private entrypointLikeFiles(files: string[]) {
    return files.filter((path) =>
      /(^|\/)(main|index|app|App|server|bootstrap)\.(ts|tsx|js|jsx|vue|mjs|cjs)$/i.test(path)
    );
  }

  private contractLikeFiles(files: string[]) {
    return this.uniqueFirstStrings(
      files.filter((path) => /(^|\/)(contracts?|types?|schemas?|api|runtime)(\/|\.|-)/i.test(path) || /contract/i.test(path)),
      8
    );
  }

  private projectInstructionFiles(snapshot: WorkspaceSnapshot) {
    return snapshot.files
      .map((file) => file.path)
      .filter((path) => {
        const name = path.toLowerCase().split('/').at(-1) ?? path.toLowerCase();
        return ['agents.md', 'claude.md', 'readme.md'].includes(name) || path.toLowerCase().includes('ai-agent-context');
      });
  }

  private projectMemoryLocations(snapshot: WorkspaceSnapshot) {
    const candidates = [
      'AGENTS.md',
      '.claude/CLAUDE.md',
      'docs/ai-agent-context/',
      'docs/product/',
      'docs/design/',
      'docs/contracts/',
      'docs/quality/'
    ];
    const paths = new Set(snapshot.files.map((file) => file.path));
    return candidates.filter((candidate) => candidate.endsWith('/') || paths.has(candidate));
  }

  private workspaceConfigFiles(snapshot: WorkspaceSnapshot) {
    const configNames = new Set([
      'agents.md',
      'claude.md',
      'readme.md',
      'package.json',
      'tsconfig.json',
      'vite.config.ts',
      'vite.config.js',
      'nest-cli.json',
      'eslint.config.js',
      'eslint.config.mjs',
      'vitest.config.ts',
      'playwright.config.ts'
    ]);
    return snapshot.files
      .map((file) => file.path)
      .filter((path) => configNames.has(path.toLowerCase().split('/').at(-1) ?? path.toLowerCase()))
      .slice(0, 12);
  }

  private workspaceTestFiles(snapshot: WorkspaceSnapshot, relevantFiles: string[]) {
    const paths = snapshot.files.map((file) => file.path);
    const relevantStems = new Set(
      relevantFiles
        .map((path) => path.split('/').at(-1) ?? path)
        .map((name) => name.replace(/\.(test|spec)\.[^.]+$/i, '').replace(/\.[^.]+$/i, '').toLowerCase())
        .filter(Boolean)
    );
    const scored = paths
      .filter((path) => this.isWorkspaceTestPath(path))
      .map((path) => {
        const lowerPath = path.toLowerCase();
        const fileName = lowerPath.split('/').at(-1) ?? lowerPath;
        const stem = fileName.replace(/\.(test|spec)\.[^.]+$/i, '').replace(/\.[^.]+$/i, '');
        return {
          path,
          score:
            (relevantStems.has(stem) ? 80 : 0) +
            (lowerPath.includes('/e2e/') || lowerPath.includes('\\e2e\\') ? 20 : 0) +
            (lowerPath.includes('/tests/') || lowerPath.startsWith('tests/') ? 10 : 0)
        };
      })
      .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
      .map((item) => item.path);
    return this.uniqueFirstStrings(scored, 12);
  }

  private isWorkspaceTestPath(path: string) {
    const lower = path.toLowerCase();
    return (
      /(^|\/)(tests?|e2e|__tests__)\//.test(lower) ||
      /\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs|vue)$/.test(lower)
    );
  }

  private workspaceValidationCommands(snapshot: WorkspaceSnapshot) {
    const packageFiles = snapshot.files.filter((file) => file.path.endsWith('package.json') && file.content);
    const commands: string[] = [];
    for (const file of packageFiles) {
      try {
        const parsed = JSON.parse(file.content ?? '{}') as { scripts?: Record<string, unknown> };
        const scripts = parsed.scripts ?? {};
        for (const scriptName of Object.keys(scripts)) {
          if (/^(typecheck|test|test:|build|e2e|smoke|lint)/i.test(scriptName)) {
            commands.push(`npm run ${scriptName}`);
          }
        }
      } catch {
        continue;
      }
    }
    const preferredOrder = ['npm run typecheck', 'npm run test', 'npm run build'];
    return this.uniqueFirstStrings(
      [...preferredOrder.filter((command) => commands.includes(command)), ...commands],
      8
    );
  }

  private workspaceImpactedFiles(snapshot: WorkspaceSnapshot, relevantFiles: string[], entrypoints: string[]) {
    const related = [...relevantFiles, ...entrypoints];
    const files = snapshot.files.map((item) => item.path);
    const sameTopLevel = new Set(
      related
        .map((path) => path.split('/').slice(0, 2).join('/'))
        .filter(Boolean)
    );
    const impacted = files.filter((path) => {
      if (related.includes(path)) return true;
      const top = path.split('/').slice(0, 2).join('/');
      return sameTopLevel.has(top) && !this.isWorkspaceTestPath(path);
    });
    return this.uniqueFirstStrings(impacted, 12);
  }

  private workspaceFileRelevanceScore(path: string, requirement: string) {
    const lowerPath = path.toLowerCase();
    const lowerRequirement = requirement.toLowerCase();
    const fileName = lowerPath.split('/').at(-1) ?? lowerPath;
    let score = 0;
    if (lowerRequirement.includes(fileName)) score += 80;
    for (const token of lowerRequirement.split(/[^a-z0-9_\-.]+/i).filter((item) => item.length >= 4)) {
      if (lowerPath.includes(token)) score += 10;
    }
    if (lowerPath.startsWith('src/') || lowerPath.startsWith('apps/') || lowerPath.startsWith('packages/')) score += 5;
    if (['agents.md', 'claude.md', 'readme.md', 'package.json'].includes(fileName)) score += 2;
    return score;
  }

  private uniqueFirstStrings(values: string[], limit: number) {
    const seen = new Set<string>();
    const unique: string[] = [];
    for (const value of values) {
      const normalized = value.trim();
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      unique.push(normalized);
      if (unique.length >= limit) break;
    }
    return unique;
  }
}
