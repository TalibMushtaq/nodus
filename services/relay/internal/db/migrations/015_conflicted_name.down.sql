ALTER TABLE rebuild_file_versions DROP COLUMN IF EXISTS conflicted_name;
ALTER TABLE file_versions DROP COLUMN IF EXISTS conflicted_name;
