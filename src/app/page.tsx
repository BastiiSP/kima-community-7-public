import { CommunityApp } from "@/components/community-app";
import { connection } from "next/server";

export default async function Page() {
  // Nonces must be generated per response, never shared through prerendering.
  await connection();
  return <CommunityApp />;
}
