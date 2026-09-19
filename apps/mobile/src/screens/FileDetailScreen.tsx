// File detail: metadata, read-only version history, and the download / rename /
// delete actions. Version *restore* is intentionally absent — it needs relay and
// storage-node protocol work tracked for a later phase.

import * as React from "react";
import { Image, View } from "react-native";
import { useNavigation, useRoute, type RouteProp } from "@react-navigation/native";
import { formatBytes, timeAgo } from "@repo/sdk";

import { AppStatusLine } from "../runtime/AppStatusLine";
import { useApp } from "../runtime/context";
import { toFileRow } from "../files/view";
import type { RelayFolder } from "../relay";
import {
  Button,
  Card,
  Divider,
  EmptyState,
  Screen,
  Sheet,
  StatusBadge,
  TextField,
  ThemedText,
  useTheme,
} from "../design";
import type { FilesStackParamList } from "../navigation/types";

export function FileDetailScreen() {
  const app = useApp();
  const theme = useTheme();
  const route = useRoute<RouteProp<FilesStackParamList, "FileDetail">>();
  const navigation = useNavigation();
  const [renameOpen, setRenameOpen] = React.useState(false);
  const [moveOpen, setMoveOpen] = React.useState(false);

  const file = app.files.find((f) => f.file_id === route.params.fileId);
  const row = file ? toFileRow(file, app.fileNames[file.file_id] ?? null) : null;
  // Decrypted preview for images. Shares the Files list/grid cache, so opening
  // details from a view that already loaded a thumbnail does not re-download.
  const [preview, setPreview] = React.useState<string | null>(null);
  const previewImage = app.previewImage;
  const fileName = file ? app.fileNames[file.file_id] ?? "" : "";
  React.useEffect(() => {
    if (!file) return;
    let cancelled = false;
    void previewImage(file, fileName).then((next) => {
      if (!cancelled) setPreview(next);
    });
    return () => {
      cancelled = true;
    };
  }, [previewImage, file, fileName]);

  // Destination options for Move: Root plus every folder, labelled by path.
  const folderOptions = React.useMemo(() => {
    const byId = new Map(app.folders.map((f) => [f.folder_id, f]));
    const pathFor = (folder: RelayFolder): string => {
      const parts: string[] = [];
      let current: RelayFolder | undefined = folder;
      for (let guard = 0; current && guard < 64; guard += 1) {
        parts.unshift(app.folderNames[current.folder_id] ?? `${current.folder_id.slice(0, 8)}…`);
        current = current.parent_folder_id ? byId.get(current.parent_folder_id) : undefined;
      }
      return parts.join(" / ");
    };
    return app.folders
      .map((f) => ({ id: f.folder_id, label: pathFor(f) }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [app.folders, app.folderNames]);

  if (!row || !file) {
    return (
      <Screen>
        <EmptyState
          icon="file"
          title="File not found"
          description="It may have been deleted or not loaded yet."
          action={<Button title="Back" variant="secondary" onPress={() => navigation.goBack()} />}
        />
      </Screen>
    );
  }

  const ext = row.name.includes(".") ? row.name.split(".").pop()?.toUpperCase() : undefined;
  const versions = [...file.versions].sort((a, b) => b.version_number - a.version_number);

  return (
    <Screen>
      <AppStatusLine />

      {/* Image preview when the file decrypts to an image; otherwise an
          extension placeholder (content is encrypted until downloaded). */}
      <View
        style={{
          height: 140,
          borderWidth: 1,
          borderColor: theme.colors.border,
          backgroundColor: theme.colors.secondary,
          alignItems: "center",
          justifyContent: "center",
          borderRadius: theme.radius.md,
          marginBottom: theme.spacing.lg,
          overflow: "hidden",
        }}
      >
        {preview ? (
          <Image source={{ uri: preview }} style={{ width: "100%", height: "100%" }} resizeMode="contain" />
        ) : (
          <ThemedText variant="mono" tone="muted">
            {ext ?? "FILE"}
          </ThemedText>
        )}
      </View>

      <Card style={{ paddingHorizontal: theme.spacing.md }}>
        <MetaRow label="Status">
          <StatusBadge status={row.status} />
        </MetaRow>
        <Divider />
        <MetaRow label="Size">
          <ThemedText variant="mono">{row.sizeBytes != null ? formatBytes(row.sizeBytes) : "—"}</ThemedText>
        </MetaRow>
        <Divider />
        <MetaRow label="Modified">
          <ThemedText variant="mono">{timeAgo(row.updatedAt)}</ThemedText>
        </MetaRow>
        <Divider />
        <MetaRow label="Shards">
          <ThemedText variant="mono">{row.shardCount ?? "—"}</ThemedText>
        </MetaRow>
      </Card>

      <View style={{ marginTop: theme.spacing.xl }}>
        <ThemedText variant="sectionLabel" tone="muted" style={{ marginBottom: theme.spacing.sm }}>
          Version history
        </ThemedText>
        <Card style={{ paddingHorizontal: theme.spacing.md }}>
          {versions.map((v, index) => (
            <React.Fragment key={v.version_number}>
              {index > 0 ? <Divider /> : null}
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: theme.spacing.md,
                  paddingVertical: theme.spacing.md,
                }}
              >
                <ThemedText variant="mono" tone="accent">
                  v{v.version_number}
                </ThemedText>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <ThemedText variant="monoSmall" tone="muted">
                    {timeAgo(v.created_at)}
                  </ThemedText>
                  <ThemedText variant="caption" tone="muted">
                    {v.shard_count} shard{v.shard_count === 1 ? "" : "s"}
                    {v.conflict_status === "flagged" ? " · conflicted" : ""}
                  </ThemedText>
                </View>
              </View>
            </React.Fragment>
          ))}
          {versions.length === 0 ? (
            <View style={{ paddingVertical: theme.spacing.md }}>
              <ThemedText variant="caption" tone="muted">
                No versions recorded.
              </ThemedText>
            </View>
          ) : null}
        </Card>
        <ThemedText variant="caption" tone="muted" style={{ marginTop: theme.spacing.sm }}>
          Restoring an earlier version is not available yet.
        </ThemedText>
      </View>

      <View style={{ marginTop: theme.spacing.xl, gap: theme.spacing.sm }}>
        <Button title="Download" icon="download" onPress={() => void app.downloadOne(file)} />
        <Button title="Share" variant="secondary" icon="share" onPress={() => void app.downloadOne(file)} />
        <Button title="Move" variant="secondary" icon="move" onPress={() => setMoveOpen(true)} />
        <Button title="Rename" variant="secondary" icon="edit" onPress={() => setRenameOpen(true)} />
        <Button title="Delete" variant="destructive" icon="trash" onPress={() => app.deleteFile(file)} />
      </View>

      <Sheet visible={moveOpen} title="Move to" onClose={() => setMoveOpen(false)}>
        <Button
          title="Root"
          variant="secondary"
          onPress={() => { setMoveOpen(false); void app.moveFileToFolder(file, null); }}
        />
        {folderOptions.map((option) => (
          <Button
            key={option.id}
            title={option.label}
            variant="secondary"
            onPress={() => { setMoveOpen(false); void app.moveFileToFolder(file, option.id); }}
          />
        ))}
      </Sheet>

      <Sheet visible={renameOpen} title="Rename file" onClose={() => setRenameOpen(false)}>
        <TextField label="New name" value={app.fileNameInput} onChangeText={app.setFileNameInput} />
        <Button
          title="Save"
          onPress={() => {
            void app.renameFile(file);
            setRenameOpen(false);
          }}
          disabled={!app.fileNameInput.trim()}
        />
      </Sheet>
    </Screen>
  );
}

function MetaRow({ label, children }: { label: string; children: React.ReactNode }) {
  const theme = useTheme();
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        gap: theme.spacing.md,
        paddingVertical: theme.spacing.md,
      }}
    >
      <ThemedText variant="caption" tone="muted">
        {label}
      </ThemedText>
      {children}
    </View>
  );
}
