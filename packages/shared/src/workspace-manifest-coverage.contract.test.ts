import type {
  ContextPack,
  WorkspaceManifestCoverage,
  WorkspaceSkippedReason
} from './contracts';

type Assert<T extends true> = T;
type IsExact<T, Expected> = [T] extends [Expected]
  ? [Expected] extends [T]
    ? true
    : false
  : false;

// Test 1: WorkspaceManifestCoverage has the four required fields.
const coverage: WorkspaceManifestCoverage = {
  totalEntriesSeen: 12,
  scannedEntries: 10,
  readableFiles: 8,
  skippedByReason: {
    ignored_directory: 1,
    binary: 0,
    too_large: 1,
    sensitive: 0,
    limit_exceeded: 0,
    read_error: 0
  }
};

// Test 2: skippedByReason key set is exactly WorkspaceSkippedReason.
type SkippedKeys = keyof WorkspaceManifestCoverage['skippedByReason'];
type SkippedKeysMatchReason = Assert<IsExact<SkippedKeys, WorkspaceSkippedReason>>;

// Test 3: each skippedByReason value is a number (optional per reason).
type SkippedValues = WorkspaceManifestCoverage['skippedByReason'][WorkspaceSkippedReason];
type SkippedValuesAreNumbers = Assert<IsExact<SkippedValues, number | undefined>>;

// Test 4: WorkspaceManifest.coverage is an optional field of the new type.
type Manifest = NonNullable<ContextPack['workspaceManifest']>;
type ManifestCoverage = Manifest['coverage'];
type ManifestCoverageIsOptional = Assert<
  IsExact<ManifestCoverage, WorkspaceManifestCoverage | undefined>
>;

void coverage;
