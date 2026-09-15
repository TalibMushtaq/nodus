//! @repo/sdk — the single client implementation shared by web and native.
//!
//! The SDK holds everything platform-agnostic (auth, device identity, and, as
//! the Phase 15 migration proceeds, catalogue/keys/envelopes/transfer logic).
//! Platform differences are injected through the adapter contracts in
//! `./adapters.js`; host apps (apps/web, apps/mobile) supply one adapter set
//! each. See docs/decisions/0007-mobile-native-and-sdk.md.

export type { RelayRequestInit, RelayResponse, RelayHttp, SecureStore, Connectivity } from "./adapters.js";

export { getOrCreateDeviceIdentity, isStoredDeviceIdentity, DEVICE_IDENTITY_KEY } from "./device.js";
export { createAuthClient } from "./auth.js";
export type { AuthClient, AuthResult, SessionInfo } from "./auth.js";

export { shortId, formatCountdown, formatBytes, timeAgo } from "./format.js";
export { isRelayOnline, relayStatusLabel } from "./connectivity.js";
export { createZip } from "./zip.js";
export type { ZipEntry } from "./zip.js";

export { createAttemptPath } from "./transfer/attempt-path.js";
export type { AttemptPathDeps, BufferedShardUpload } from "./transfer/attempt-path.js";
export { createSignedRelayChannel } from "./transfer/relay-signaling.js";
export type { RelayChannelDeps } from "./transfer/relay-signaling.js";

export { uploadFile, measurePlaintext, DEFAULT_SHARD_CONCURRENCY } from "./upload/uploader.js";
export type {
  UploadSource,
  UploadDeps,
  UploadFileOptions,
  FileMeasurement,
  UploadProgressEvent,
  UploadPhase,
  UploadResult,
} from "./upload/uploader.js";
export { uploadKey } from "./upload/upload-progress.js";
export type { UploadProgress } from "./upload/upload-progress.js";

export {
  decodeRecipientPublicKey,
  decodeEnvelope,
  encodeEnvelope,
  sealFekForRecipientIdentity,
  sealFekForRecipients,
  openFekFromEnvelope,
  openFolderKeyFromEnvelopes,
  collectRecipients,
  envelopeEvent,
  folderEnvelopeEvent,
} from "./envelopes/envelopes.js";
export type {
  RecipientKind,
  EnvelopeRecipient,
  RelayEnvelope,
  RelayFolderEnvelope,
  EnvelopeSummary,
  EnvelopeExport,
  EnvelopeDeviceInfo,
  EnvelopeNodeInfo,
  RecipientSources,
} from "./envelopes/envelopes.js";

export { fileUpsertEvent, fileDeletedEvent, conflictResolvedEvent } from "./files/file-events.js";

export { listConflicts } from "./conflicts/conflicts.js";
export type { ConflictEntry, ConflictDeps } from "./conflicts/conflicts.js";

export { toCatalogEntry } from "./catalog/catalog.js";
export type {
  RelayFileVersion,
  RelayFile,
  CatalogEntry,
  RelayFolder,
  FolderEntry,
} from "./catalog/catalog.js";

export { createRecoveryClient } from "./recovery/recovery.js";
export type {
  RecoveryClient,
  RecoveryDeps,
  RecoveryLoginResult,
  RecoveryStore,
} from "./recovery/recovery.js";

export { createFolderMutations, folderCreatedEvent, folderDeletedEvent } from "./folders/folders.js";
export type { FolderMutationDeps, FolderMutations } from "./folders/folders.js";

export {
  downloadFile,
  MissingEnvelopeError,
  ShardUnavailableError,
  ShardIntegrityError,
} from "./download/download.js";
export type {
  DownloadDeps,
  DownloadFileOptions,
  DownloadResult,
  RelayFileLocation,
} from "./download/download.js";
export { PersistentWebRtcSession, WebRtcSessionCache } from "./transfer/webrtc-session.js";
export type {
  PersistentSessionDeps,
  PersistentShardRequest,
  PersistentShardResult,
} from "./transfer/webrtc-session.js";
