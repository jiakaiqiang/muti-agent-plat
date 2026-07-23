import type { ContextPipelineVersion } from './contracts';
import { DEFAULT_CONTEXT_PIPELINE_VERSION, SUPPORTED_CONTEXT_PIPELINE_VERSIONS } from './contracts';

type Assert<T extends true> = T;
type IsExact<T, Expected> = [T] extends [Expected]
  ? [Expected] extends [T]
    ? true
    : false
  : false;

const v2: ContextPipelineVersion = 'v2';

type ContextPipelineVersionIsV2Only = Assert<IsExact<ContextPipelineVersion, 'v2'>>;

const supportedVersions = SUPPORTED_CONTEXT_PIPELINE_VERSIONS satisfies readonly ContextPipelineVersion[];
const defaultVersion: ContextPipelineVersion = DEFAULT_CONTEXT_PIPELINE_VERSION;

void v2;
void supportedVersions;
void defaultVersion;
