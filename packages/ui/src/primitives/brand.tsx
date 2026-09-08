import { Icon } from "./icons";

export function Logo({ size = 20, className = "" }: { size?: number; className?: string }) {
  return (
    <span className={className}>
      <Icon name="logo" size={size} />
    </span>
  );
}

export function Avatar({ initials, className = "" }: { initials: string; className?: string }) {
  return (
    <div
      className={`w-7 h-7 rounded-sm bg-accent/20 flex items-center justify-center text-accent text-xs font-semibold shrink-0 ${className}`}
    >
      {initials}
    </div>
  );
}