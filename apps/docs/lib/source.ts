import { defineDocs } from "fumadocs-mdx/macro";
import { loader } from "fumadocs-core/source";

// The macro is evaluated at build time and compiles every MDX/meta file under
// `content/docs` into a typed page collection. `loader` exposes lookup helpers
// and the page tree used by the docs layout and search route.
const docs = defineDocs({
  dir: "content/docs",
});

export const source = loader({
  baseUrl: "/docs",
  source: docs.toFumadocsSource(),
});
