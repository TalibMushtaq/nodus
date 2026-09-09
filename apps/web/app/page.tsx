import { redirect } from "next/navigation";
import { getSession } from "../lib/session";

// Phase 7a §3 route guard: authenticated users land on the dashboard, everyone
// else on the auth wizard.
export default async function RootPage() {
  const session = await getSession();
  redirect(session ? "/overview" : "/auth");
}