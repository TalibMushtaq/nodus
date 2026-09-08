// Network topology panel: shows the relay/node/client connectivity at a glance.
// This is one of the most design-specific panels in the prototype — it uses
// inline node icons and dashed/dotted lines to communicate connection quality.

interface TopologyNode {
  type: "client" | "node" | "relay";
  label: string;
  sublabel: string;
  active: boolean;
  primary?: boolean;
}

const nodes: TopologyNode[] = [
  { type: "client", label: "Web client", sublabel: "MacBook Pro", active: true },
  { type: "node", label: "Storage Node", sublabel: "Home NAS", active: true, primary: true },
  { type: "relay", label: "Go Relay", sublabel: "relay.nodus.dev", active: true },
  { type: "client", label: "Mobile", sublabel: "iPhone 15", active: false },
];

export function NetworkTopology() {
  return (
    <div className="bg-gradient-to-br from-orange-50/60 to-amber-50/40 border border-border rounded-xl p-5 dark:from-amber-950/20 dark:to-orange-950/10">
      <div className="flex items-center justify-center gap-0 overflow-x-auto">
        {nodes.map((n, i) => (
          <div key={n.label} className="contents">
            {/* Connector line (between nodes, skip before first) */}
            {i > 0 && (
              <div className="flex flex-col items-center justify-center mx-2">
                <div className={`w-12 border-t ${i === 1 ? "border-dashed border-accent/60" : i === 3 ? "border-dashed border-border" : "border-dotted border-muted-foreground/50"}`} />
                <span className={`text-[9px] font-mono mt-0.5 ${i === 1 ? "text-accent" : "text-muted-foreground/60"}`}>
                  {i === 1 ? "Local P2P" : i === 2 ? "Relay \u2191" : "Relay \u2193"}
                </span>
              </div>
            )}
            {/* Node */}
            <div className={`flex flex-col items-center gap-1 min-w-[80px] ${!n.active ? "opacity-70" : ""}`}>
              <div className={`w-12 h-12 border-2 rounded-sm flex items-center justify-center ${
                n.primary ? "border-accent bg-accent/10" : "border-border bg-secondary"
              }`}>
                {n.type === "node" ? (
                  <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                    <rect x="3" y="2" width="14" height="16" rx="1" stroke="currentColor" strokeWidth="1.5" />
                    <path d="M7 6h6M7 9h6M7 12h4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
                  </svg>
                ) : n.type === "relay" ? (
                  <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                    <path d="M10 2C5.5 2 2 5.5 2 10s3.5 8 8 8 8-3.5 8-8-3.5-8-8-8z" stroke="currentColor" strokeWidth="1.5" />
                    <path d="M6 10c0-2.2 1.8-4 4-4s4 1.8 4 4-1.8 4-4 4-4-1.8-4-4z" stroke="currentColor" strokeWidth="1.3" />
                    <circle cx="10" cy="10" r="1.5" fill="currentColor" />
                  </svg>
                ) : (
                  <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                    <rect x="2" y="4" width="16" height="12" rx="1" stroke="currentColor" strokeWidth="1.5" />
                    <path d="M6 16v2M14 16v2M4 18h12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                  </svg>
                )}
              </div>
              <span className={`text-[10px] font-mono text-center leading-tight ${n.primary ? "text-accent font-medium" : "text-muted-foreground"}`}>
                {n.label}<br />{n.sublabel}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}