DROP TABLE IF EXISTS rebuild_tombstones;
DROP TABLE IF EXISTS rebuild_file_versions;
DROP TABLE IF EXISTS rebuild_files;
DROP TABLE IF EXISTS rebuild_requests;
ALTER TABLE storage_nodes DROP COLUMN IF EXISTS is_primary;
