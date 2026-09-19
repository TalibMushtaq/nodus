// Files tab: folder browser, upload/download, multi-select bulk actions, and
// per-row context menus, wired to the existing runtime actions.
//
// Search/sort/filter run client-side over the already-loaded catalog — the
// Relay has no server-side query for either, so this is presentation only.

import * as React from "react";
import { Image, Pressable, View, type DimensionValue } from "react-native";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { formatBytes, timeAgo } from "@repo/sdk";

import { AppStatusLine } from "../runtime/AppStatusLine";
import { useApp } from "../runtime/context";
import type { RelayFolder } from "../relay";
import { toFileRow, type FileRow } from "../files/view";
import { getCachedPreview, isImageName } from "../files/preview";
import { getPreference, setPreference } from "../store/preferences";
import {
  Button,
  Card,
  Chip,
  ConfirmDialog,
  Divider,
  EmptyState,
  Icon,
  IconButton,
  PathIndicator,
  Screen,
  ScreenHeader,
  Sheet,
  StatusBadge,
  TextField,
  ThemedText,
  useTheme,
} from "../design";
import type { FilesStackParamList } from "../navigation/types";

type Nav = NativeStackNavigationProp<FilesStackParamList, "Files">;

type SortKey = "modified" | "name" | "size";
type FilterKey = "all" | "synced" | "pending" | "conflicts" | "local-only";
type ViewMode = "list" | "grid";
type IconSize = "sm" | "md" | "lg";
type Context =
  | { kind: "file"; row: FileRow }
  | { kind: "folder"; id: string }
  | null;

const SORT_LABEL: Record<SortKey, string> = { modified: "Modified", name: "Name", size: "Size" };
const FILTER_LABEL: Record<FilterKey, string> = {
  all: "All",
  synced: "Synced",
  pending: "Pending",
  conflicts: "Conflicts",
  "local-only": "Local only",
};

// Persisted view preferences (SQLite key/value, same store as shard size). The
// layout should survive a restart so the user does not re-pick it every visit.
const VIEW_PREF_KEY = "filesView";
const ICON_SIZE_PREF_KEY = "filesIconSize";
const ICON_SIZE_LABEL: Record<IconSize, string> = { sm: "S", md: "M", lg: "L" };

// Tile width per icon scale. Percentages (with a wrap gap) give a responsive
// column count without measuring the viewport. Every file tile now carries a
// preview image, so widths are larger: 31% ≈ 3 up, 48% ≈ 2 up, 100% = 1 up.
const TILE_BASIS: Record<IconSize, DimensionValue> = {
  sm: "31%",
  md: "48%",
  lg: "100%",
};

export function FilesScreen() {
  const app = useApp();
  const theme = useTheme();
  const navigation = useNavigation<Nav>();

  const [searching, setSearching] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [sort, setSort] = React.useState<SortKey>("modified");
  const [filter, setFilter] = React.useState<FilterKey>("all");
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [fabOpen, setFabOpen] = React.useState(false);
  const [sortOpen, setSortOpen] = React.useState(false);
  const [newFolderOpen, setNewFolderOpen] = React.useState(false);
  const [context, setContext] = React.useState<Context>(null);
  // The rename target is held separately from the context menu so closing the
  // menu does not drop which entity is being renamed.
  const [renameTarget, setRenameTarget] = React.useState<
    { kind: "file"; row: FileRow } | { kind: "folder"; folder: RelayFolder } | null
  >(null);
  const [propertiesFolder, setPropertiesFolder] = React.useState<RelayFolder | null>(null);
  // Files awaiting a destination folder (single or bulk move).
  const [moveTargets, setMoveTargets] = React.useState<FileRow[] | null>(null);
  const [confirmBulkDelete, setConfirmBulkDelete] = React.useState(false);
  const [view, setView] = React.useState<ViewMode>("list");
  const [iconSize, setIconSize] = React.useState<IconSize>("md");

  React.useEffect(() => {
    if (app.authed) {
      void app.loadFiles();
      void app.loadFolders();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app.authed]);

  // Restore the persisted layout/icon scale once on mount. A bad or missing
  // stored value is ignored so the defaults stay valid.
  React.useEffect(() => {
    void (async () => {
      const [storedView, storedSize] = await Promise.all([
        getPreference(VIEW_PREF_KEY),
        getPreference(ICON_SIZE_PREF_KEY),
      ]);
      if (storedView === "list" || storedView === "grid") setView(storedView);
      if (storedSize === "sm" || storedSize === "md" || storedSize === "lg") {
        setIconSize(storedSize);
      }
    })();
  }, []);

  // Persist on change; fire-and-forget (a failed write only costs the next
  // session its remembered layout, it never blocks the UI).
  const changeView = (next: ViewMode) => {
    setView(next);
    void setPreference(VIEW_PREF_KEY, next);
  };
  const changeIconSize = (next: IconSize) => {
    setIconSize(next);
    void setPreference(ICON_SIZE_PREF_KEY, next);
  };

  const rows = React.useMemo(
    () => app.visibleFiles.map((f) => toFileRow(f, app.fileNames[f.file_id] ?? null)),
    [app.visibleFiles, app.fileNames],
  );

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    const matches = rows.filter((row) => {
      if (q && !row.name.toLowerCase().includes(q)) return false;
      switch (filter) {
        case "synced":
          return row.status === "synced";
        case "pending":
          return row.status === "pending";
        case "conflicts":
          return row.status === "conflict";
        case "local-only":
          return row.status === "local-only";
        default:
          return true;
      }
    });
    const sorted = [...matches];
    sorted.sort((a, b) => {
      if (sort === "name") return a.name.localeCompare(b.name);
      if (sort === "size") return (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0);
      return b.updatedAt.localeCompare(a.updatedAt);
    });
    return sorted;
  }, [rows, query, filter, sort]);

  const folders = React.useMemo(() => {
    const label = (id: string) => app.folderNames[id] ?? id;
    return [...app.visibleFolders].sort((a, b) =>
      label(a.folder_id).localeCompare(label(b.folder_id)),
    );
  }, [app.visibleFolders, app.folderNames]);

  // Destination options for a move: Root plus every folder, labelled with its
  // path so same-named folders in different parents are distinguishable.
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

  const selectedRows = React.useMemo(
    () => rows.filter((row) => selected.has(row.fileId)),
    [rows, selected],
  );
  const selectionMode = selected.size > 0;

  const selectedNode = app.nodes.find((n) => n.node_id === app.selectedNode);
  const node = selectedNode ?? app.nodes.find((n) => n.is_primary);
  const freeSpace =
    node?.total_bytes != null ? formatBytes(node.total_bytes - (node.used_bytes ?? 0)) : "unknown";

  const up = () => {
    if (app.currentFolderId === null) return;
    const parent =
      app.folders.find((f) => f.folder_id === app.currentFolderId)?.parent_folder_id ?? null;
    app.setCurrentFolderId(parent);
  };

  const toggleSelection = (fileId: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(fileId)) next.delete(fileId);
      else next.add(fileId);
      return next;
    });

  const openContext = (next: Context) => setContext(next);

  const closeContext = () => setContext(null);

  return (
    <View style={{ flex: 1 }}>
      {selectionMode ? (
        <ScreenHeader
          title={`${selected.size} selected`}
          right={
            <>
              <IconButton
                name="move"
                accessibilityLabel="Move selected"
                onPress={() => setMoveTargets(selectedRows)}
              />
              <IconButton
                name="trash"
                accessibilityLabel="Delete selected"
                onPress={() => setConfirmBulkDelete(true)}
              />
              <IconButton
                name="close"
                accessibilityLabel="Cancel selection"
                onPress={() => setSelected(new Set())}
              />
            </>
          }
        />
      ) : (
        <ScreenHeader
          title="Files"
          subtitle={`${node?.display_name ?? "No node"} · ${freeSpace} free`}
          right={
            <>
              <IconButton
                name={view === "list" ? "gridView" : "listView"}
                accessibilityLabel={view === "list" ? "Switch to grid view" : "Switch to list view"}
                onPress={() => changeView(view === "list" ? "grid" : "list")}
              />
              <IconButton
                name={searching ? "close" : "search"}
                accessibilityLabel="Search files"
                onPress={() => {
                  setSearching((v) => !v);
                  if (searching) setQuery("");
                }}
              />
              <IconButton
                name="filter"
                accessibilityLabel="Sort and filter"
                onPress={() => setSortOpen(true)}
              />
              <IconButton
                name="alert"
                accessibilityLabel="Open conflicts"
                onPress={() => navigation.navigate("Conflicts")}
              />
            </>
          }
        />
      )}

      {searching ? (
        <View style={{ paddingHorizontal: theme.spacing.lg, paddingBottom: theme.spacing.sm }}>
          <TextField
            value={query}
            onChangeText={setQuery}
            placeholder="Search this folder"
            autoCapitalize="none"
          />
        </View>
      ) : null}

      {/* Breadcrumb. The root is a distinct chip that stays tappable from any
          depth, and each ancestor is a target, so the tree is fully navigable
          back to the top from any folder. */}
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: theme.spacing.xs,
          paddingHorizontal: theme.spacing.lg,
          paddingBottom: theme.spacing.sm,
          flexWrap: "wrap",
        }}
      >
        <Pressable
          onPress={() => app.setCurrentFolderId(null)}
          hitSlop={6}
          style={({ pressed }) => [
            {
              flexDirection: "row",
              alignItems: "center",
              gap: theme.spacing.xs,
              paddingHorizontal: theme.spacing.sm,
              paddingVertical: theme.spacing.xs,
              borderRadius: theme.radius.sm,
              backgroundColor:
                app.currentFolderId === null ? theme.colors.secondary : "transparent",
              opacity: pressed ? 0.6 : 1,
            },
          ]}
        >
          <Icon
            name="folder"
            size={15}
            color={app.currentFolderId === null ? theme.colors.foreground : theme.colors.accent}
          />
          <ThemedText variant="body" tone={app.currentFolderId === null ? "default" : "accent"}>
            Backups
          </ThemedText>
        </Pressable>
        {app.folderTrail.map((f, i) => {
          const isCurrent = i === app.folderTrail.length - 1;
          return (
            <React.Fragment key={f.folder_id}>
              <ThemedText variant="caption" tone="muted">
                /
              </ThemedText>
              <Pressable
                onPress={() => (isCurrent ? undefined : app.setCurrentFolderId(f.folder_id))}
                hitSlop={6}
                style={({ pressed }) => [
                  {
                    paddingHorizontal: theme.spacing.xs,
                    paddingVertical: theme.spacing.xs,
                    borderRadius: theme.radius.sm,
                    backgroundColor: isCurrent ? theme.colors.secondary : "transparent",
                    opacity: pressed ? 0.6 : 1,
                  },
                ]}
              >
                <ThemedText
                  variant="body"
                  tone={isCurrent ? "default" : "accent"}
                  numberOfLines={1}
                >
                  {app.folderLabel(f)}
                </ThemedText>
              </Pressable>
            </React.Fragment>
          );
        })}
      </View>

      <Screen refreshing={false} onRefresh={() => void Promise.all([app.loadFiles(), app.loadFolders()])}>
        <AppStatusLine />
        {app.uploadStatus ? (
          <ThemedText variant="caption" tone="muted" style={{ marginBottom: theme.spacing.sm }}>
            {app.uploadStatus}
          </ThemedText>
        ) : null}
        {app.lastPath ? (
          <View style={{ marginBottom: theme.spacing.sm }}>
            <PathIndicator path={app.lastPath} />
          </View>
        ) : null}

        {folders.length === 0 && filtered.length === 0 ? (
          <EmptyState
            icon="folder"
            title="Nothing here yet"
            description="Upload a file or create a folder to get started."
          />
        ) : view === "grid" ? (
          // One wrapping grid for folders and files so the cards flow together
          // and rows line up; separate grids put folders on their own row.
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: theme.spacing.sm }}>
            {folders.map((f) => (
              <FolderTile
                key={f.folder_id}
                label={app.folderLabel(f)}
                width={TILE_BASIS[iconSize]}
                onOpen={() =>
                  selectionMode ? undefined : app.setCurrentFolderId(f.folder_id)
                }
                onMore={() => openContext({ kind: "folder", id: f.folder_id })}
              />
            ))}
            {filtered.map((row) => (
              <FileTile
                key={row.fileId}
                row={row}
                width={TILE_BASIS[iconSize]}
                selected={selected.has(row.fileId)}
                selectionMode={selectionMode}
                onOpen={() =>
                  selectionMode
                    ? toggleSelection(row.fileId)
                    : navigation.navigate("FileDetail", { fileId: row.fileId })
                }
                onMore={() => openContext({ kind: "file", row })}
              />
            ))}
          </View>
        ) : (
          <Card>
            {folders.map((f, index) => (
              <React.Fragment key={f.folder_id}>
                {index > 0 ? <Divider /> : null}
                <Pressable
                  onPress={() =>
                    selectionMode
                      ? undefined
                      : app.setCurrentFolderId(f.folder_id)
                  }
                  onLongPress={() => openContext({ kind: "folder", id: f.folder_id })}
                  style={({ pressed }) => [
                    {
                      flexDirection: "row",
                      alignItems: "center",
                      gap: theme.spacing.md,
                      paddingHorizontal: theme.spacing.md,
                      paddingVertical: theme.spacing.md,
                      opacity: pressed ? 0.7 : 1,
                    },
                  ]}
                >
                  <View
                    style={{
                      width: 36,
                      height: 36,
                      borderWidth: 1,
                      borderColor: theme.colors.border,
                      backgroundColor: theme.colors.secondary,
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    <Icon name="folder" size={16} color={theme.colors.mutedForeground} />
                  </View>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <ThemedText variant="body">{app.folderLabel(f)}</ThemedText>
                    <ThemedText variant="monoSmall" tone="muted">
                      Folder
                    </ThemedText>
                  </View>
                  <StatusBadge status="synced" variant="dot" />
                  <IconButton
                    name="more"
                    color={theme.colors.mutedForeground}
                    accessibilityLabel={`Actions for ${app.folderLabel(f)}`}
                    onPress={() => openContext({ kind: "folder", id: f.folder_id })}
                  />
                </Pressable>
              </React.Fragment>
            ))}
            {filtered.map((row, index) => (
              <React.Fragment key={row.fileId}>
                {folders.length > 0 || index > 0 ? <Divider /> : null}
                <FileRowView
                  row={row}
                  selectionMode={selectionMode}
                  selected={selected.has(row.fileId)}
                  onOpen={() =>
                    selectionMode
                      ? toggleSelection(row.fileId)
                      : navigation.navigate("FileDetail", { fileId: row.fileId })
                  }
                  onLongPress={() => openContext({ kind: "file", row })}
                  onMore={() => openContext({ kind: "file", row })}
                />
              </React.Fragment>
            ))}
          </Card>
        )}

        {app.currentFolderId !== null ? (
          <View style={{ marginTop: theme.spacing.lg }}>
            <Button title="Up one level" variant="secondary" icon="chevronLeft" onPress={up} />
          </View>
        ) : null}
      </Screen>

      {/* FAB — hidden while selecting so it does not overlap the bulk actions. */}
      {!selectionMode ? (
        <Pressable
          onPress={() => setFabOpen(true)}
          style={{
            position: "absolute",
            right: theme.spacing.lg,
            bottom: theme.spacing.lg,
            width: 52,
            height: 52,
            borderRadius: theme.radius.sm,
            backgroundColor: theme.colors.accent,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Icon name="plus" size={24} color={theme.colors.accentForeground} />
        </Pressable>
      ) : null}

      <Sheet visible={fabOpen} title="Add" onClose={() => setFabOpen(false)}>
        <Button title="Upload file" icon="upload" onPress={() => { setFabOpen(false); void app.uploadPicked(); }} />
        <Button
          title="Upload photo/video"
          variant="secondary"
          icon="upload"
          onPress={() => { setFabOpen(false); void app.uploadPicked(); }}
        />
        <Button
          title="New folder"
          variant="secondary"
          icon="folder"
          onPress={() => { setFabOpen(false); setNewFolderOpen(true); }}
        />
      </Sheet>

      <Sheet visible={sortOpen} title="Sort & filter" onClose={() => setSortOpen(false)}>
        <ThemedText variant="label" tone="muted">
          View
        </ThemedText>
        <View style={{ flexDirection: "row", gap: theme.spacing.sm, flexWrap: "wrap" }}>
          <Chip label="List" icon="listView" active={view === "list"} onPress={() => changeView("list")} />
          <Chip label="Grid" icon="gridView" active={view === "grid"} onPress={() => changeView("grid")} />
        </View>
        {/* Icon scale only affects tiles, so hide it in list view. */}
        {view === "grid" ? (
          <>
            <ThemedText variant="label" tone="muted" style={{ marginTop: theme.spacing.sm }}>
              Icon size
            </ThemedText>
            <View style={{ flexDirection: "row", gap: theme.spacing.sm, flexWrap: "wrap" }}>
              {(Object.keys(ICON_SIZE_LABEL) as IconSize[]).map((k) => (
                <Chip
                  key={k}
                  label={ICON_SIZE_LABEL[k]}
                  active={iconSize === k}
                  onPress={() => changeIconSize(k)}
                />
              ))}
            </View>
          </>
        ) : null}
        <ThemedText variant="label" tone="muted" style={{ marginTop: theme.spacing.sm }}>
          Sort by
        </ThemedText>
        <View style={{ flexDirection: "row", gap: theme.spacing.sm, flexWrap: "wrap" }}>
          {(Object.keys(SORT_LABEL) as SortKey[]).map((k) => (
            <Chip key={k} label={SORT_LABEL[k]} active={sort === k} onPress={() => setSort(k)} />
          ))}
        </View>
        <ThemedText variant="label" tone="muted" style={{ marginTop: theme.spacing.sm }}>
          Status
        </ThemedText>
        <View style={{ flexDirection: "row", gap: theme.spacing.sm, flexWrap: "wrap" }}>
          {(Object.keys(FILTER_LABEL) as FilterKey[]).map((k) => (
            <Chip key={k} label={FILTER_LABEL[k]} active={filter === k} onPress={() => setFilter(k)} />
          ))}
        </View>
        <Button title="Done" onPress={() => setSortOpen(false)} style={{ marginTop: theme.spacing.sm }} />
      </Sheet>

      <Sheet visible={newFolderOpen} title="New folder" onClose={() => setNewFolderOpen(false)}>
        <TextField
          label="Name"
          value={app.folderNameInput}
          onChangeText={app.setFolderNameInput}
          placeholder="Folder name"
        />
        <Button
          title="Create here"
          onPress={() => { void app.createFolder(); setNewFolderOpen(false); }}
          disabled={!app.folderNameInput.trim()}
        />
      </Sheet>

      {/* Row context menu */}
      <Sheet visible={context !== null} title="Actions" onClose={closeContext}>
        {context?.kind === "file" ? (
          <>
            <Button
              title="Open details"
              variant="secondary"
              onPress={() => { const r = context.row; closeContext(); navigation.navigate("FileDetail", { fileId: r.fileId }); }}
            />
            <Button
              title="Download"
              variant="secondary"
              icon="download"
              onPress={() => { const r = context.row; closeContext(); void app.downloadOne(r.file); }}
            />
            <Button
              title="Move"
              variant="secondary"
              icon="move"
              onPress={() => { const r = context.row; closeContext(); setMoveTargets([r]); }}
            />
            <Button
              title="Rename"
              variant="secondary"
              icon="edit"
              onPress={() => {
                const r = context.row;
                app.setFileNameInput(r.name);
                closeContext();
                setRenameTarget({ kind: "file", row: r });
              }}
            />
            <Button
              title="Select"
              variant="secondary"
              icon="check"
              onPress={() => { const r = context.row; closeContext(); setSelected(new Set([r.fileId])); }}
            />
            <Button
              title="Delete"
              variant="destructive"
              onPress={() => { const r = context.row; closeContext(); app.deleteFile(r.file); }}
            />
          </>
        ) : context?.kind === "folder" ? (
          (() => {
            const folder = app.folders.find((f) => f.folder_id === context.id);
            if (!folder) return null;
            return (
              <>
                <Button
                  title="Open"
                  variant="secondary"
                  onPress={() => { closeContext(); app.setCurrentFolderId(folder.folder_id); }}
                />
                <Button
                  title="Rename"
                  variant="secondary"
                  icon="edit"
                  onPress={() => {
                    app.setFolderNameInput(app.folderLabel(folder));
                    closeContext();
                    setRenameTarget({ kind: "folder", folder });
                  }}
                />
                <Button
                  title="Properties"
                  variant="secondary"
                  icon="more"
                  onPress={() => { closeContext(); setPropertiesFolder(folder); }}
                />
                <Button
                  title="Delete"
                  variant="destructive"
                  onPress={() => { closeContext(); app.deleteFolder(folder); }}
                />
              </>
            );
          })()
        ) : null}
      </Sheet>

      <Sheet visible={renameTarget !== null} title="Rename" onClose={() => setRenameTarget(null)}>
        <TextField
          label="New name"
          value={renameTarget?.kind === "file" ? app.fileNameInput : app.folderNameInput}
          onChangeText={renameTarget?.kind === "file" ? app.setFileNameInput : app.setFolderNameInput}
        />
        <Button
          title="Save"
          onPress={() => {
            if (renameTarget?.kind === "file") void app.renameFile(renameTarget.row.file);
            else if (renameTarget?.kind === "folder") void app.renameFolder(renameTarget.folder);
            setRenameTarget(null);
          }}
        />
      </Sheet>

      {/* Folder properties */}
      <Sheet visible={propertiesFolder !== null} title="Folder properties" onClose={() => setPropertiesFolder(null)}>
        {propertiesFolder
          ? (() => {
              const childFolders = app.folders.filter(
                (f) => (f.parent_folder_id ?? null) === propertiesFolder.folder_id,
              ).length;
              const childFiles = app.files.filter(
                (f) => (f.parent_folder_id ?? null) === propertiesFolder.folder_id,
              ).length;
              return (
                <View style={{ gap: theme.spacing.sm }}>
                  <PropRow label="Name" value={app.folderLabel(propertiesFolder)} />
                  <PropRow label="Type" value="Folder" />
                  <PropRow label="Contents" value={`${childFiles} file(s) · ${childFolders} folder(s)`} />
                  <PropRow label="Created" value={timeAgo(propertiesFolder.created_at)} />
                  <PropRow label="Modified" value={timeAgo(propertiesFolder.updated_at)} />
                  <PropRow label="ID" value={`${propertiesFolder.folder_id.slice(0, 16)}…`} mono />
                </View>
              );
            })()
          : null}
      </Sheet>

      {/* Destination picker for move (single or bulk) */}
      <Sheet
        visible={moveTargets !== null}
        title={moveTargets && moveTargets.length > 1 ? `Move ${moveTargets.length} files` : "Move to"}
        onClose={() => setMoveTargets(null)}
      >
        <Button
          title="Root"
          variant="secondary"
          onPress={() => {
            const targets = moveTargets;
            setMoveTargets(null);
            if (!targets) return;
            void (targets.length === 1
              ? app.moveFileToFolder(targets[0]!.file, null)
              : app.moveFilesTo(targets.map((t) => t.file), null));
            setSelected(new Set());
          }}
        />
        {folderOptions.map((option) => (
          <Button
            key={option.id}
            title={option.label}
            variant="secondary"
            onPress={() => {
              const targets = moveTargets;
              setMoveTargets(null);
              if (!targets) return;
              void (targets.length === 1
                ? app.moveFileToFolder(targets[0]!.file, option.id)
                : app.moveFilesTo(targets.map((t) => t.file), option.id));
              setSelected(new Set());
            }}
          />
        ))}
      </Sheet>

      <ConfirmDialog
        visible={confirmBulkDelete}
        title={`Delete ${selected.size} file(s)?`}
        message="They are soft-deleted and can be restored from Deleted files."
        confirmLabel="Delete"
        destructive
        onConfirm={() => {
          setConfirmBulkDelete(false);
          void app.deleteFiles(selectedRows.map((r) => r.file));
          setSelected(new Set());
        }}
        onCancel={() => setConfirmBulkDelete(false)}
      />
    </View>
  );
}

/**
 * Best-effort thumbnail for an image row/tile. Starts from the session cache so
 * a remount is instant, then asks the runtime to download+decrypt once. Returns
 * null for non-images or until a preview is ready (caller shows the ext badge).
 */
function usePreview(row: FileRow): string | null {
  const app = useApp();
  const image = isImageName(row.name);
  const [uri, setUri] = React.useState<string | null>(() =>
    image ? getCachedPreview(row.fileId, row.latestVersionNumber) : null,
  );
  const previewImage = app.previewImage;
  React.useEffect(() => {
    if (!image) return;
    let cancelled = false;
    void previewImage(row.file, row.name).then((next) => {
      if (!cancelled) setUri(next);
    });
    return () => {
      cancelled = true;
    };
  }, [previewImage, image, row.file, row.name, row.fileId, row.latestVersionNumber]);
  return uri;
}

function PropRow({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  const theme = useTheme();
  return (
    <View style={{ flexDirection: "row", justifyContent: "space-between", gap: theme.spacing.md }}>
      <ThemedText variant="caption" tone="muted">
        {label}
      </ThemedText>
      <ThemedText variant={mono ? "monoSmall" : "caption"} style={{ flexShrink: 1, textAlign: "right" }}>
        {value}
      </ThemedText>
    </View>
  );
}

/** Status stripe colour shared by the list row and the grid tile. */
function statusColor(row: FileRow, theme: ReturnType<typeof useTheme>): string {
  if (row.status === "synced") return theme.status.synced;
  if (row.status === "pending") return theme.status.pending;
  if (row.status === "conflict") return theme.status.conflict;
  if (row.status === "offline") return theme.status.offline;
  return theme.status.local;
}

function FileRowView({
  row,
  selectionMode,
  selected,
  onOpen,
  onLongPress,
  onMore,
}: {
  row: FileRow;
  selectionMode: boolean;
  selected: boolean;
  onOpen: () => void;
  onLongPress: () => void;
  onMore: () => void;
}) {
  const theme = useTheme();
  const ext = row.name.includes(".") ? row.name.split(".").pop()?.toUpperCase() : undefined;
  const barColor = statusColor(row, theme);
  // Encrypted image bytes must be downloaded+decrypted; falls back to the ext
  // badge until the preview resolves (or if it is not an eligible image).
  const preview = usePreview(row);
  return (
    <Pressable
      onPress={onOpen}
      onLongPress={onLongPress}
      style={({ pressed }) => [
        {
          flexDirection: "row",
          alignItems: "center",
          gap: theme.spacing.md,
          paddingHorizontal: theme.spacing.md,
          paddingVertical: theme.spacing.md,
          opacity: pressed ? 0.7 : 1,
          backgroundColor: selected ? `${theme.colors.accent}10` : "transparent",
        },
      ]}
    >
      {selectionMode ? (
        <View
          style={{
            width: 20,
            height: 20,
            borderRadius: theme.radius.sm,
            borderWidth: 1,
            borderColor: selected ? theme.colors.accent : theme.colors.border,
            backgroundColor: selected ? theme.colors.accent : "transparent",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          {selected ? <Icon name="check" size={13} color={theme.colors.accentForeground} /> : null}
        </View>
      ) : (
        <View style={{ width: 2, height: 36, borderRadius: theme.radius.full, backgroundColor: barColor }} />
      )}
      <View
        style={{
          width: 36,
          height: 36,
          borderWidth: 1,
          borderColor: theme.colors.border,
          backgroundColor: theme.colors.secondary,
          alignItems: "center",
          justifyContent: "center",
          overflow: "hidden",
        }}
      >
        {preview ? (
          <Image source={{ uri: preview }} style={{ width: "100%", height: "100%" }} resizeMode="cover" />
        ) : (
          <ThemedText variant="monoSmall" tone="muted">
            {ext && ext.length <= 4 ? ext : "FILE"}
          </ThemedText>
        )}
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <ThemedText variant="body" numberOfLines={1}>
          {row.name}
        </ThemedText>
        <ThemedText variant="monoSmall" tone="muted">
          {row.sizeBytes != null ? formatBytes(row.sizeBytes) : "—"} · {timeAgo(row.updatedAt)}
        </ThemedText>
      </View>
      <StatusBadge status={row.status} variant="dot" />
      {/* Visible 3-dot trigger so actions are discoverable without a long-press;
          the press target inside the row may not bubble to the row's onPress. */}
      <IconButton
        name="more"
        size={22}
        color={theme.colors.mutedForeground}
        accessibilityLabel={`Actions for ${row.name}`}
        onPress={onMore}
      />
    </Pressable>
  );
}

/**
 * Grid-view folder card. Opens on tap and exposes the same context actions as
 * the list row (long-press or the 3-dot button). `width` comes from the shared
 * icon-scale basis so it lines up with the file tiles.
 */
// Grid-view folder card. Deliberately the same header + media + footer shape as
// `FileTile` so folders and files share one grid and rows line up (the earlier
// centered-glyph tile rendered at a different height and left a gap).
function FolderTile({
  label,
  width,
  onOpen,
  onMore,
}: {
  label: string;
  width: DimensionValue;
  onOpen: () => void;
  onMore: () => void;
}) {
  const theme = useTheme();
  return (
    <Pressable
      onPress={onOpen}
      onLongPress={onMore}
      style={({ pressed }) => [
        {
          width,
          padding: theme.spacing.sm,
          gap: theme.spacing.sm,
          borderRadius: theme.radius.md,
          borderWidth: 1,
          borderColor: theme.colors.border,
          backgroundColor: theme.colors.card,
          opacity: pressed ? 0.7 : 1,
        },
      ]}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: theme.spacing.sm, minWidth: 0 }}>
        <View
          style={{
            width: 28,
            height: 28,
            borderRadius: theme.radius.sm,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: theme.colors.accent,
          }}
        >
          <Icon name="folder" size={15} color={theme.colors.accentForeground} />
        </View>
        <ThemedText variant="caption" numberOfLines={1} style={{ flex: 1, minWidth: 0 }}>
          {label}
        </ThemedText>
        <IconButton
          name="more"
          size={22}
          color={theme.colors.mutedForeground}
          accessibilityLabel={`Actions for ${label}`}
          onPress={onMore}
        />
      </View>
      <View
        style={{
          width: "100%",
          aspectRatio: 4 / 3,
          borderRadius: theme.radius.sm,
          borderWidth: 1,
          borderColor: theme.colors.border,
          backgroundColor: theme.colors.secondary,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Icon name="folder" size={36} color={theme.colors.accent} />
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
        <ThemedText variant="monoSmall" tone="muted">
          Folder
        </ThemedText>
      </View>
    </Pressable>
  );
}

/** Grid-view file card; parallel to `FolderTile`, opens details or selection. */
function FileTile({
  row,
  width,
  selected,
  selectionMode,
  onOpen,
  onMore,
}: {
  row: FileRow;
  width: DimensionValue;
  selected: boolean;
  selectionMode: boolean;
  onOpen: () => void;
  onMore: () => void;
}) {
  const theme = useTheme();
  const isImage = isImageName(row.name);
  const ext = row.name.includes(".") ? row.name.split(".").pop()?.toUpperCase() : undefined;
  const preview = usePreview(row);
  return (
    <Pressable
      onPress={onOpen}
      onLongPress={onMore}
      style={({ pressed }) => [
        {
          width,
          padding: theme.spacing.sm,
          gap: theme.spacing.sm,
          borderRadius: theme.radius.md,
          borderWidth: 1,
          borderColor: selected ? theme.colors.accent : theme.colors.border,
          backgroundColor: selected ? `${theme.colors.accent}10` : theme.colors.card,
          opacity: pressed ? 0.7 : 1,
        },
      ]}
    >
      {/* Header: type glyph, name, and a larger 3-dot target (the card's main
          action surface). Tap opens; long-press also opens the menu. */}
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: theme.spacing.sm,
          minWidth: 0,
        }}
      >
        <View
          style={{
            width: 28,
            height: 28,
            borderRadius: theme.radius.sm,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: isImage ? theme.colors.accent : theme.colors.secondary,
          }}
        >
          <Icon
            name={isImage ? "image" : "file"}
            size={15}
            color={isImage ? theme.colors.accentForeground : theme.colors.mutedForeground}
          />
        </View>
        <ThemedText variant="caption" numberOfLines={1} style={{ flex: 1, minWidth: 0 }}>
          {row.name}
        </ThemedText>
        <IconButton
          name="more"
          size={22}
          color={theme.colors.mutedForeground}
          accessibilityLabel={`Actions for ${row.name}`}
          onPress={onMore}
        />
      </View>
      {/* Media: decrypted image preview, or the extension placeholder. */}
      <View
        style={{
          width: "100%",
          aspectRatio: 4 / 3,
          borderRadius: theme.radius.sm,
          borderWidth: 1,
          borderColor: theme.colors.border,
          backgroundColor: theme.colors.secondary,
          alignItems: "center",
          justifyContent: "center",
          overflow: "hidden",
        }}
      >
        {preview ? (
          <Image source={{ uri: preview }} style={{ width: "100%", height: "100%" }} resizeMode="cover" />
        ) : (
          <ThemedText variant="mono" tone="muted">
            {ext && ext.length <= 4 ? ext : "FILE"}
          </ThemedText>
        )}
      </View>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: theme.spacing.sm,
        }}
      >
        <ThemedText variant="monoSmall" tone="muted" numberOfLines={1} style={{ flexShrink: 1 }}>
          {row.sizeBytes != null ? formatBytes(row.sizeBytes) : "—"}
        </ThemedText>
        <StatusBadge status={row.status} variant="dot" />
      </View>
    </Pressable>
  );
}
