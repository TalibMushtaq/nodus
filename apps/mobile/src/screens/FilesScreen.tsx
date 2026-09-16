import * as React from "react";
import { Button, Text, TextInput, View } from "react-native";

import { toCatalogEntry } from "@repo/sdk";

import { useApp } from "../runtime/context";
import { ScreenScroll } from "../runtime/ScreenScroll";
import { Section, transferPathLabel } from "../runtime/ui";
import { styles } from "../runtime/styles";

/**
 * File browser: upload, download/rename/move/delete, and the folder browser
 * (list, open, create, rename, delete) that backs the current location.
 */
export function FilesScreen() {
  const {
    authed,
    busy,
    selectedNode,
    uploadPicked,
    uploadStatus,
    lastPath,
    loadFiles,
    folderTrail,
    folderLabel,
    visibleFiles,
    fileNames,
    downloadOne,
    renameFile,
    moveFile,
    deleteFile,
    fileNameInput,
    setFileNameInput,
    downloadStatus,
    currentFolderId,
    setCurrentFolderId,
    loadFolders,
    folders,
    visibleFolders,
    renameFolder,
    deleteFolder,
    folderNameInput,
    setFolderNameInput,
    createFolder,
  } = useApp();

  return (
    <ScreenScroll title="Files">
      <Section title="6 · Upload a file">
        <Button
          title="Pick and upload"
          onPress={() => void uploadPicked()}
          disabled={!authed || busy !== null}
        />
        {uploadStatus && <Text style={styles.hint}>{uploadStatus}</Text>}
        {lastPath && <Text style={styles.hint}>Last shard path: {transferPathLabel(lastPath)}</Text>}
        <Text style={styles.hint}>
          Uploads to {selectedNode ? "the selected node" : "the primary node"} and seals the key to
          all your devices and nodes.
        </Text>
      </Section>

      <Section title="7 · Download a file">
        <Button title="Load files" onPress={() => void loadFiles()} disabled={!authed || busy !== null} />
        <Text style={styles.hint}>
          In: Root{folderTrail.map((f) => ` / ${folderLabel(f)}`).join("")}
        </Text>
        {visibleFiles.length === 0 && <Text style={styles.hint}>No files here.</Text>}
        {visibleFiles.map((f) => (
          <View key={f.file_id} style={styles.radioRow}>
            <Text style={styles.hint}>
              {fileNames[f.file_id] ?? `${f.file_id.slice(0, 12)}…`} · {f.versions.length} version
              {f.versions.length === 1 ? "" : "s"} ·{" "}
              {toCatalogEntry(f).storage_status ?? "unknown"}
              {toCatalogEntry(f).conflicted_versions.length > 0 ? " · conflict" : ""}
            </Text>
            <View style={styles.buttonRow}>
              <Button
                title={busy === `downloading-${f.file_id}` ? "Downloading…" : "Download"}
                onPress={() => void downloadOne(f)}
                disabled={busy !== null}
              />
              <Button
                title={busy === `renaming-file-${f.file_id}` ? "Renaming…" : "Rename"}
                onPress={() => void renameFile(f)}
                disabled={busy !== null || fileNameInput.trim() === ""}
              />
              {(f.parent_folder_id ?? null) !== currentFolderId && (
                <Button
                  title={busy === `moving-file-${f.file_id}` ? "Moving…" : "Move here"}
                  onPress={() => void moveFile(f)}
                  disabled={busy !== null}
                />
              )}
              <Button
                title={busy === `deleting-file-${f.file_id}` ? "Deleting…" : "Delete"}
                onPress={() => deleteFile(f)}
                disabled={busy !== null}
              />
            </View>
          </View>
        ))}
        <TextInput
          style={styles.input}
          value={fileNameInput}
          onChangeText={setFileNameInput}
          placeholder="new file name (for Rename)"
        />
        {downloadStatus && <Text style={styles.hint}>{downloadStatus}</Text>}
      </Section>

      <Section title="11 · Folders">
        <Button
          title="Load folders"
          onPress={() => void loadFolders()}
          disabled={!authed || busy !== null}
        />
        <Text style={styles.hint}>
          In: Root{folderTrail.map((f) => ` / ${folderLabel(f)}`).join("")}
        </Text>
        {currentFolderId !== null && (
          <Button
            title="◂ Up"
            onPress={() => {
              const parent = folders.find((f) => f.folder_id === currentFolderId)?.parent_folder_id ?? null;
              setCurrentFolderId(parent);
            }}
            disabled={busy !== null}
          />
        )}
        {visibleFolders.length === 0 && <Text style={styles.hint}>No subfolders here.</Text>}
        {visibleFolders.map((f) => (
          <View key={f.folder_id} style={styles.radioRow}>
            <Text style={styles.hint}>{folderLabel(f)}</Text>
            <View style={styles.buttonRow}>
              <Button title="Open" onPress={() => setCurrentFolderId(f.folder_id)} disabled={busy !== null} />
              <Button
                title={busy === `renaming-${f.folder_id}` ? "Renaming…" : "Rename"}
                onPress={() => void renameFolder(f)}
                disabled={busy !== null || folderNameInput.trim() === ""}
              />
              <Button
                title={busy === `deleting-${f.folder_id}` ? "Deleting…" : "Delete"}
                onPress={() => deleteFolder(f)}
                disabled={busy !== null}
              />
            </View>
          </View>
        ))}
        <TextInput
          style={styles.input}
          value={folderNameInput}
          onChangeText={setFolderNameInput}
          placeholder="new subfolder name (for Create / Rename)"
        />
        <Button
          title={busy === "creating-folder" ? "Creating…" : "Create here"}
          onPress={() => void createFolder()}
          disabled={!authed || busy !== null || folderNameInput.trim() === ""}
        />
      </Section>
    </ScreenScroll>
  );
}
