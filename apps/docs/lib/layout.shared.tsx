import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";

// Shared chrome for both the docs layout and the home layout. Keeping the nav
// title in one place ensures the wordmark and repo link stay consistent.
export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: "Nodus",
    },
    githubUrl: "https://github.com/TalibMushtaq/nodus",
  };
}
