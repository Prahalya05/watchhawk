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
