import { Modal, ModalHeader } from "../primitives/overlay";

// Conflict resolution modal: two version cards side-by-side with Keep A / Keep
// B / Keep both / Cancel actions.

interface ConflictModalProps {
  fileName: string;
  versionA: { label: string; device: string; time: string; size: string };
  versionB: { label: string; device: string; time: string; size: string };
  onClose: () => void;
}

export function ConflictModal({ fileName, versionA, versionB, onClose }: ConflictModalProps) {
  return (
    <Modal className="w-[520px]" onClose={onClose}>
      <ModalHeader title={`Resolve conflict \u2014 ${fileName}`} onClose={onClose} />

      <div className="p-5 grid grid-cols-2 gap-4">
        {[versionA, versionB].map((v) => (
          <div key={v.label} className="border border-border p-3 space-y-2">
            <div className="text-xs font-semibold text-foreground">{v.label}</div>
            <div className="bg-secondary h-20 flex items-center justify-center text-xs text-muted-foreground font-mono">
              Preview unavailable<br />(encrypted)
            </div>
            <div className="text-[10px] font-mono text-muted-foreground">{v.device}</div>
            <div className="text-[10px] font-mono text-muted-foreground">{v.time} &middot; {v.size}</div>
          </div>
        ))}
      </div>

      <div className="flex items-center gap-2 px-5 pb-5">
        {["Keep A", "Keep B", "Keep both (rename)"].map((a) => (
          <button key={a} type="button" onClick={onClose} className="flex-1 py-2 text-xs border border-border hover:border-accent hover:text-accent transition-colors text-foreground rounded-sm">{a}</button>
        ))}
        <button type="button" onClick={onClose} className="px-4 py-2 text-xs text-muted-foreground hover:text-foreground transition-colors">Cancel</button>
      </div>
    </Modal>
  );
}