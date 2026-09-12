import { describe, expect, it } from "vitest";

import { fileDeletedEvent, fileUpsertEvent } from "../file-events";

describe("file mutation events", () => {
  it("renames via a FILE_CREATED metadata upsert", () => {
    const event = fileUpsertEvent("device-1", 7, "file-1", {
      parentFolderId: "dir-1",
      encryptedName: "enc-name",
    });
    expect(event.type).toBe("FILE_CREATED");
    expect(event.origin_sequence).toBe(7);
    expect(event.payload).toMatchObject({
      file_id: "file-1",
      parent_folder_id: "dir-1",
      encrypted_name: "enc-name",
    });
  });

  it("deletes via TOMBSTONE_CREATED with the tombstone shape the backends parse", () => {
    const event = fileDeletedEvent("device-1", 8, "file-1");
    expect(event.type).toBe("TOMBSTONE_CREATED");
    expect(event.payload).toMatchObject({ entity_type: "file", entity_id: "file-1" });
    expect(typeof (event.payload as { deleted_at?: unknown }).deleted_at).toBe("string");
  });
});
