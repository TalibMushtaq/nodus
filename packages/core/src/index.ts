export type {
  EncryptedShard,
  FileId,
  KeyEnvelope,
  Shard,
  ShardIndex,
  ShardMetadata,
} from "./types.js";
export {
  SHARD_SIZE_BYTES,
  DEFAULT_SHARD_SIZE_BYTES,
  MIN_SHARD_SIZE_BYTES,
  MAX_SHARD_SIZE_BYTES,
  resolveShardSize,
  splitIntoShards,
  reconstructFromShards,
} from "./shard.js";
export {
  SHARD_NONCE_SIZE,
  encryptShard,
  decryptShard,
  hashShard,
  generateFileEncryptionKey,
  sealFekForRecipient,
  openFekEnvelope,
  createPlaintextHasher,
  encryptName,
  decryptName,
  packEncryptedShard,
  unpackEncryptedShard,
  ed25519PublicToX25519,
  ed25519PrivateToX25519,
  deriveEncryptionKeypair,
} from "./crypto.js";
export { shardMetadataFromEncryptedShard } from "./metadata.js";
export {
  generateRecoveryPhrase,
  normalizeRecoveryPhrase,
  isValidRecoveryPhrase,
  recoveryIdentityFromPhrase,
  signRecoveryChallenge,
  type RecoveryIdentity,
} from "./recovery.js";
export {
  backoffDelay,
  backoffDelayWithRandom,
  sleepBackoff,
} from "./backoff.js";
