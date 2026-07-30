import { SetMetadata } from '@nestjs/common';

export const SKIP_PERSISTENCE_COMMIT = 'skipPersistenceCommit';

export const SkipPersistenceCommit = () => SetMetadata(SKIP_PERSISTENCE_COMMIT, true);
