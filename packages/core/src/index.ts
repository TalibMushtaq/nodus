export type { FileId, Shard, ShardIndex, ShardMetadata } from "./types.js";
export {
  SHARD_SIZE_BYTES,
  splitIntoShards,
  reconstructFromShards,
} from "./shard.js";
