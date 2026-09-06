import { apiClient } from "./client";
import type { AuthUser } from "../types";

interface AuthResponse {
  user: AuthUser;
  token: string;
}

export async function register(email: string, password: string): Promise<AuthResponse> {
  const { data } = await apiClient.post<AuthResponse>("/auth/register", { email, password });
  return data;
}

export async function login(email: string, password: string): Promise<AuthResponse> {
  const { data } = await apiClient.post<AuthResponse>("/auth/login", { email, password });
  return data;
}

export async function me(): Promise<AuthUser> {
  const { data } = await apiClient.get<AuthUser>("/auth/me");
  return data;
}

interface WsTicket {
  ticket: string;
  expiresInSeconds: number;
}

// The WebSocket's credential. Fetched fresh for every connection attempt, including
// reconnects — a ticket is single-use and lives about half a minute, so there is nothing
// worth caching here. The session token travels in the Authorization header on this call
// and never reaches the socket itself.
export async function requestWsTicket(): Promise<string> {
  const { data } = await apiClient.post<WsTicket>("/auth/ws-ticket");
  return data.ticket;
}
