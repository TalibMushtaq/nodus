-- Snapshot staging is shared by every account. Its conflict keys must include
-- account_id so one account's rebuild cannot suppress or overwrite another's
-- rows that happen to use the same file id/version.
ALTER TABLE rebuild_files DROP CONSTRAINT IF EXISTS rebuild_files_pkey;
ALTER TABLE rebuild_files
    ADD CONSTRAINT rebuild_files_account_file_pkey PRIMARY KEY (account_id, file_id);

ALTER TABLE rebuild_file_versions DROP CONSTRAINT IF EXISTS rebuild_file_versions_pkey;
ALTER TABLE rebuild_file_versions
    ADD CONSTRAINT rebuild_file_versions_account_file_version_pkey
    PRIMARY KEY (account_id, file_id, version_number);
