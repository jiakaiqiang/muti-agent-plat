import type { ContextPipelineVersion } from './contracts';
import { DEFAULT_CONTEXT_PIPELINE_VERSION, SUPPORTED_CONTEXT_PIPELINE_VERSIONS } from './contracts';

type Assert<T extends true> = T;
type IsExact<T, Expected> = [T] extends [Expected]
  ? [Expected] extends [T]
    ? true
    : false
  : false;

const v1: ContextPipelineVersion = 'v1';
const v2: ContextPipelineVersion = 'v2';

type ContextPipelineVersionIsStableUnion = Assert<IsExact<ContextPipelineVersion, 'v1' | 'v2'>>;

const supportedVersions = SUPPORTED_CONTEXT_PIPELINE_VERSIONS satisfies readonly ContextPipelineVersion[];
const defaultVersion: ContextPipelineVersion = DEFAULT_CONTEXT_PIPELINE_VERSION;

void v1;
void v2;
void supportedVersions;
void defaultVersion;
