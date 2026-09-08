import type { KeyEnvelope } from "./types";

// Key envelope table: Security page's "Key Envelopes" section.
// Shows which devices hold decryption keys for which file groups.

interface KeyEnvelopeTableProps {
  envelopes: KeyEnvelope[];
}

export function KeyEnvelopeTable({ envelopes }: KeyEnvelopeTableProps) {
  return (
    <div className="border border-border rounded-xl overflow-hidden bg-card">
      <div className="px-5 py-3 border-b border-border">
        <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Key Envelopes</h3>
      </div>
      <table className="w-full">
        <thead>
          <tr className="border-b border-border text-[10px] text-muted-foreground uppercase tracking-wider">
            <th className="text-left px-5 py-2 font-medium">Device</th>
            <th className="text-left px-3 py-2 font-medium">Key ID</th>
            <th className="text-right px-3 py-2 font-medium">Files</th>
            <th className="text-right px-5 py-2 font-medium">Updated</th>
          </tr>
        </thead>
        <tbody>
          {envelopes.map((e) => (
            <tr key={e.id} className="hover:bg-secondary/40 transition-colors">
              <td className="px-5 py-2.5 text-xs text-foreground font-medium">{e.device}</td>
              <td className="px-3 py-2.5 text-[10px] font-mono text-muted-foreground">{e.id}</td>
              <td className="px-3 py-2.5 text-xs font-mono text-right text-muted-foreground">{e.files}</td>
              <td className="px-5 py-2.5 text-[10px] font-mono text-right text-muted-foreground">{e.updated}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}