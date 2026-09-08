import { Modal, ModalHeader } from "../primitives/overlay";

// Pair device modal: QR placeholder + manual code entry, matching the
// prototype's mock exactly.

// Deterministic pseudo-random cell pattern so the QR placeholder doesn't
// re-render to a different image (Math.random would be impure).
function isDarkCell(i: number): boolean {
  return (i * 7 + 3) % 5 < 2;
}

export function PairingModal({ onClose }: { onClose: () => void }) {
  return (
    <Modal className="w-[400px]" onClose={onClose}>
      <ModalHeader title="Pair a new device" onClose={onClose} />
      <div className="p-5 space-y-5">
        {/* QR placeholder */}
        <div className="flex flex-col items-center gap-3">
          <div className="w-40 h-40 bg-secondary border border-border flex items-center justify-center">
            <div className="grid grid-cols-7 gap-px opacity-70">
              {Array.from({ length: 49 }, (_, i) => (
                <div key={i} className={`w-4 h-4 ${isDarkCell(i) ? "bg-foreground" : "bg-transparent"}`} />
              ))}
            </div>
          </div>
          <p className="text-xs text-muted-foreground text-center">Scan this code on the device you want to pair</p>
        </div>
        <div className="relative flex items-center gap-3">
          <div className="flex-1 border-t border-border" />
          <span className="text-xs text-muted-foreground">or enter code manually</span>
          <div className="flex-1 border-t border-border" />
        </div>
        <input
          type="text"
          placeholder="XXXX-XXXX-XXXX-XXXX"
          className="w-full px-3 py-2 text-sm font-mono bg-secondary border border-border text-foreground placeholder-muted-foreground outline-none focus:border-accent"
        />
        <div className="flex gap-2">
          <button type="button" className="flex-1 py-2 text-xs border border-border hover:bg-secondary transition-colors text-foreground">Generate new code</button>
          <button type="button" onClick={onClose} className="px-4 py-2 text-xs text-muted-foreground hover:text-foreground transition-colors">Close</button>
        </div>
      </div>
    </Modal>
  );
}