import type { ButtonHTMLAttributes } from "react";

type Variant = "primary" | "secondary" | "ghost" | "destructive" | "link";

const base =
  "inline-flex items-center justify-center gap-1.5 rounded-lg text-xs font-medium transition-all select-none hover:-translate-y-px active:translate-y-0 disabled:opacity-40 disabled:pointer-events-none";

// Button variants mirror the prototype's vocabulary: the accent-gradient
// primary action, bordered "secondary" buttons, and the destructive outlines.
// Filled/bordered variants sit on the card elevation so they read as tappable
// surfaces; ghost and link stay flat.
const variants: Record<Variant, string> = {
  primary: "accent-gradient text-accent-foreground elev-card hover:opacity-95",
  secondary: "border border-border bg-card text-foreground elev-card hover:border-accent/40 hover:text-accent",
  ghost: "text-muted-foreground hover:text-foreground hover:bg-secondary",
  destructive: "border border-destructive/40 bg-card text-destructive elev-card hover:bg-destructive/10",
  link: "text-accent hover:opacity-80",
};

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: "sm" | "md" | "lg";
}

const sizes = {
  sm: "px-2 py-1",
  md: "px-2.5 py-1.5",
  // `lg` also raises the text size, for toolbar controls that need to be more
  // prominent than the default.
  lg: "px-3.5 py-2 text-sm",
};

export function Button({ variant = "secondary", size = "md", className = "", ...props }: ButtonProps) {
  const variantClass = variants[variant];
  const sizeClass = sizes[size];
  return <button type="button" className={`${base} ${variantClass} ${sizeClass} ${className}`} {...props} />;
}

export type { Variant as ButtonVariant };
