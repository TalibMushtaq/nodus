"use client";

import { useState } from "react";
import { Button } from "@repo/ui/primitives/button";
import { Breadcrumb } from "@repo/ui/primitives/breadcrumb";
import { FileRow as FileRowComp } from "@repo/ui/domain/file-row";
import { FileDetailPanel } from "@repo/ui/domain/file-detail-panel";
import { ConflictModal } from "@repo/ui/domain/conflict-modal";
import { files, mockVersions } from "../../../lib/mock-data";
import type { FileRow as FileRowType } from "@repo/ui/domain/types";

export default function FilesPage() {
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [detailFile, setDetailFile] = useState<FileRowType | null>(null);
  const [conflictFile, setConflictFile] = useState<FileRowType | null>(null);

  const toggleCheck = (id: string) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  return (
    <div className="flex h-full">
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* Toolbar */}
        <div className="flex items-center gap-3 px-5 py-3 border-b border-border shrink-0 bg-background">
          <Breadcrumb items={["Home", "All files"]} />
          <div className="flex-1" />
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span>{checked.size} selected</span>
          </div>
          <Button variant="primary" size="sm">Upload</Button>
        </div>

        {/* Table */}
        <div className="flex-1 overflow-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-border text-[10px] text-muted-foreground uppercase tracking-wider">
                <th className="w-10 px-3 py-2"><input type="checkbox" className="accent-accent size-3.5" /></th>
                <th className="text-left px-3 py-2 font-medium">Name</th>
                <th className="text-left px-3 py-2 font-medium hidden md:table-cell">Size</th>
                <th className="text-left px-3 py-2 font-medium hidden lg:table-cell">Modified</th>
                <th className="text-left px-3 py-2 font-medium hidden lg:table-cell">Location</th>
                <th className="text-left px-3 py-2 font-medium">Status</th>
                <th className="w-10 px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {files.map((f) => (
                <FileRowComp
                  key={f.id}
                  file={f}
                  selected={checked.has(f.id)}
                  onToggle={toggleCheck}
                  onSelect={(file) => setDetailFile(file)}
                  onResolve={(id) => setConflictFile(files.find((x) => x.id === id) || null)}
                />
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Detail panel */}
      {detailFile && (
        <FileDetailPanel file={detailFile} versions={mockVersions} onClose={() => setDetailFile(null)} />
      )}

      {/* Conflict modal */}
      {conflictFile && (
        <ConflictModal
          fileName={conflictFile.name}
          versionA={{ label: "Local", device: "MacBook Pro", time: "Today 10:00", size: "84 MB" }}
          versionB={{ label: "Home NAS", device: "Home NAS", time: "Today 09:30", size: "89 MB" }}
          onClose={() => setConflictFile(null)}
        />
      )}
    </div>
  );
}