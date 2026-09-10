ALTER TABLE rebuild_file_versions
    DROP CONSTRAINT IF EXISTS rebuild_file_versions_account_file_version_pkey;
ALTER TABLE rebuild_file_versions
    ADD CONSTRAINT rebuild_file_versions_pkey PRIMARY KEY (file_id, version_number);

ALTER TABLE rebuild_files DROP CONSTRAINT IF EXISTS rebuild_files_account_file_pkey;
ALTER TABLE rebuild_files
    ADD CONSTRAINT rebuild_files_pkey PRIMARY KEY (file_id);
