import { cookies } from "next/headers";
import AgentChatClient from "./AgentChatClient";

/**
 * Server component — fetches agentDetails from the /api/agents proxy
 * using the muapi_key cookie for auth, then renders the client chat component.
 *
 * URL: /agents/[agent_id]   (new chat — no conversation ID yet)
 */
export async function generateMetadata({ params }) {
  const { agent_id } = await params;
  return {
    title: `Agent Chat — Open Generative AI`,
  };
}

// Server-side fetches use the local proxy routes — no direct external calls.
const LOCAL_BASE = process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000';

async function fetchAgentDetails(agentId, apiKey) {
  if (!apiKey) return null;
  
  // Try fetching by slug first
  try {
    console.log(`[AgentPage] Fetching agent by slug: ${agentId}`);
    const res = await fetch(
      `${LOCAL_BASE}/api/agents/by-slug/${agentId}`,
      {
        cache: "no-store",
        headers: { "x-api-key": apiKey },
      }
    );
    if (res.ok) return await res.json();
    
    // If by-slug fails, try fetching by direct ID (if it looks like a UUID)
    if (agentId.length > 20) {
      console.log(`[AgentPage] Fetch by slug failed, trying by ID: ${agentId}`);
      const resId = await fetch(
        `${LOCAL_BASE}/api/agents/${agentId}`,
        {
          cache: "no-store",
          headers: { "x-api-key": apiKey },
        }
      );
      if (resId.ok) return await resId.json();
    }
    
    console.warn(`[AgentPage] Failed to fetch agent details for: ${agentId}`);
    return null;
  } catch (error) {
    console.error("[AgentPage] Fetch error:", error);
    return null;
  }
}

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

export default async function AgentPage({ params }) {
  const { agent_id } = await params;
  const cookieStore = await cookies();
  const apiKey = cookieStore.get("muapi_key")?.value;

  console.log(`[AgentPage] Loading page for agent: ${agent_id}, hasKey: ${!!apiKey}`);

  const [agentDetails, userData] = await Promise.all([
    fetchAgentDetails(agent_id, apiKey),
    fetchUserData(apiKey)
  ]);

  return (
    <AgentChatClient 
      agentDetails={agentDetails} 
      initialHistory={null} 
      userData={userData}
    />
  );
}
