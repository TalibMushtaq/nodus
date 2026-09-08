import type { ButtonHTMLAttributes } from "react";

type Variant = "primary" | "secondary" | "ghost" | "destructive" | "link";

const base =
  "inline-flex items-center justify-center gap-1.5 text-xs font-medium transition-colors select-none disabled:opacity-40 disabled:pointer-events-none";

// Button variants mirror the prototype's vocabulary: the accent-gradient
// primary action, bordered "secondary" buttons, and the destructive outlines.
const variants: Record<Variant, string> = {
  primary: "accent-gradient text-accent-foreground hover:opacity-90",
  secondary: "border border-border text-foreground hover:bg-secondary hover:border-accent/30",
  ghost: "text-muted-foreground hover:text-foreground hover:bg-secondary",
  destructive: "border border-destructive text-destructive hover:bg-destructive/10",
  link: "text-accent hover:opacity-80",
};

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: "sm" | "md" | "lg";
}

const sizes = {
  sm: "px-2 py-1",
  md: "px-2.5 py-1.5",
  lg: "px-3 py-2",
};

export function Button({ variant = "secondary", size = "md", className = "", ...props }: ButtonProps) {
  const variantClass = variants[variant];
  const sizeClass = sizes[size];
  return <button type="button" className={`${base} ${variantClass} ${sizeClass} ${className}`} {...props} />;
}

export type { Variant as ButtonVariant };