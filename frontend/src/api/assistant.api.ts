import { apiClient } from "./client";
import type { AssistantResult, AssistantStatus, ExplainResponse } from "../types";

export async function runCommand(text: string, confirm = false): Promise<AssistantResult> {
  const { data } = await apiClient.post<AssistantResult>("/assistant/command", { text, confirm });
  return data;
}

export async function fetchAssistantStatus(): Promise<AssistantStatus> {
  const { data } = await apiClient.get<AssistantStatus>("/assistant/status");
  return data;
}

export async function explainEvent(symbol: string, eventType: string, occurredAt?: string): Promise<ExplainResponse> {
  const { data } = await apiClient.post<ExplainResponse>("/assistant/explain", { symbol, eventType, occurredAt });
  return data;
}
