import { source } from "@/lib/source";
import { createFromSource } from "fumadocs-core/search/server";

// Server-side full-text search over the compiled docs source.
export const { GET } = createFromSource(source, {
  language: "english",
});
