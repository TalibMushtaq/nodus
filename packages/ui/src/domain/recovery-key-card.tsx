import { Icon } from "../primitives/icons";

// Recovery key card: displayed in the Security page. Shows the seed phrase
// as a numbered grid and the copy/download actions.

const seedWords = [
  "abandon", "ability", "able", "about", "above", "absent",
  "absorb", "abstract", "absurd", "abuse", "access", "accident",
  "account", "accuse", "achieve", "acid", "acoustic", "acquire",
];

export function RecoveryKeyCard() {
  return (
    <div className="border border-border bg-card p-5 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-foreground">Recovery Seed Phrase</h3>
        <div className="flex items-center gap-2">
          <span className="px-2 py-0.5 text-[10px] font-medium border border-destructive/30 text-destructive bg-destructive/5 rounded-sm">12 words &middot; keep secret</span>
        </div>
      </div>
      <div className="grid grid-cols-6 gap-2">
        {seedWords.map((w, i) => (
          <div key={i} className="flex items-center gap-1.5 px-2 py-1.5 bg-secondary border border-border">
            <span className="text-[9px] font-mono text-muted-foreground w-3 text-right">{i + 1}.</span>
            <span className="text-xs font-mono text-foreground">{w}</span>
          </div>
        ))}
      </div>
      <div className="flex items-center gap-2">
        <button type="button" className="flex-1 py-2 text-xs border border-border hover:bg-secondary hover:border-accent/30 transition-colors text-foreground flex items-center justify-center gap-1.5">
          <Icon name="copy" size={12} />
          Copy
        </button>
        <button type="button" className="flex-1 py-2 text-xs border border-border hover:bg-secondary hover:border-accent/30 transition-colors text-foreground flex items-center justify-center gap-1.5">
          <Icon name="download" size={12} />
          Download
        </button>
      </div>
    </div>
  );
}