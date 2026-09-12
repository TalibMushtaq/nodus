import { describe, expect, it } from "vitest";
import { EventTypes } from "@repo/protocol";

import { folderCreatedEvent, folderDeletedEvent } from "../folder-events";

describe("folder event builders", () => {
  it("builds a FOLDER_CREATED event with the expected payload", () => {
    const event = folderCreatedEvent("device-1", 7, {
      folderId: "dir-1",
      parentFolderId: "dir-0",
      encryptedName: "enc",
    });
    expect(event.type).toBe(EventTypes.FOLDER_CREATED);
    expect(event.origin_id).toBe("device-1");
    expect(event.origin_sequence).toBe(7);
    expect(event.payload).toEqual({
      folder_id: "dir-1",
      parent_folder_id: "dir-0",
      encrypted_name: "enc",
    });
  });

  it("builds a FOLDER_DELETED event addressed by folder_id", () => {
    const event = folderDeletedEvent("device-1", 8, "dir-1");
    expect(event.type).toBe(EventTypes.FOLDER_DELETED);
    expect(event.payload).toEqual({ folder_id: "dir-1" });
  });
});
