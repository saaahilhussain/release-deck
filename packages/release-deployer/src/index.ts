export { ReleaseDeployerError } from './errors.js';
export type {
  ReleaseDeployerErrorKind,
  ReleaseDeployerErrorOptions,
} from './errors.js';
export {
  activateRelease,
  buildScpArgs,
  buildSshArgs,
  cleanupPreparedRelease,
  defaultArtifactRoot,
  openPreparedRelease,
  parseReleaseProof,
  promoteRelease,
  prepareRelease,
  rollbackRelease,
  stageRelease,
  validateReleaseMetadata,
  validateRemoteRoot,
} from './deployer.js';
export type {
  ActivateReleaseInput,
  PreparedRelease,
  PrepareReleaseInput,
  PromoteReleaseInput,
  PromotionOutcome,
  ReleaseHealthProof,
  ReleaseMetadata,
  ReleaseProof,
  ManualRollbackInput,
  RollbackOutcome,
  SshTarget,
  StageReleaseInput,
} from './deployer.js';
export {
  defaultCommandExecutor,
  type CommandExecutor,
  type CommandOptions,
  type CommandResult,
} from './process.js';
export {
  ACTIVATE_REMOTE_SCRIPT,
  MANUAL_ROLLBACK_REMOTE_SCRIPT,
  PROMOTE_REMOTE_SCRIPT,
  STAGE_REMOTE_SCRIPT,
} from './scripts.js';
