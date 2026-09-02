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
  splitIntoShards,
  reconstructFromShards,
} from "./shard.js";
export {
  encryptShard,
  decryptShard,
  hashShard,
  generateFileEncryptionKey,
  sealFekForRecipient,
  openFekEnvelope,
} from "./crypto.js";
export { shardMetadataFromEncryptedShard } from "./metadata.js";
