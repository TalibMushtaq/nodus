import { FilesClient } from "./files-client";

// Server component wrapper. The view is client-side because the catalog lives
// in IndexedDB and names are decrypted with the device-only FEK.
export default function FilesPage() {
  return <FilesClient />;
}
