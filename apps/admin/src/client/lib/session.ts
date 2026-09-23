import type { ConsoleProfile } from "@inquiry-platform/core";
import { useQuery } from "@tanstack/react-query";
import { api } from "./api";

export interface Session {
  email?: string;
  role: string;
  mailConfigured: boolean;
  profile: ConsoleProfile;
}

/** The signed-in operator and the deployment's names. One query for every
 * screen, so the header and the composer never disagree. */
export function useSession() {
  return useQuery({
    queryKey: ["session"],
    queryFn: () => api.get<Session>("/api/session"),
    staleTime: 5 * 60 * 1000,
  });
}
