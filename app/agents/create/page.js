import { cookies } from "next/headers";
import AgentCreateClient from "./AgentCreateClient";

// Server-side fetches use the local proxy routes — no direct external calls.
const LOCAL_BASE = process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000';

async function fetchUserData(apiKey) {
  if (!apiKey) return null;
  try {
    const res = await fetch(`${LOCAL_BASE}/api/api/v1/account/balance`, {
      cache: "no-store",
      headers: { "x-api-key": apiKey },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export default async function CreateAgentPage() {
  const cookieStore = await cookies();
  const apiKey = cookieStore.get("muapi_key")?.value;

  const userData = await fetchUserData(apiKey);

  return (
    <AgentCreateClient userData={userData} />
  );
}
