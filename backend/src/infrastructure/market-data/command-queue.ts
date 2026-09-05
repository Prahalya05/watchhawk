export type AdminCommandType =
  | "VOLUME_SPIKE"
  | "GAP_OPEN"
  | "FIFTY_TWO_WEEK_EXTREME"
  | "NEWS"
  | "RATING_CHANGE"
  | "CORPORATE_ACTION"
  | "DIVERGE"
  | "FREEZE"
  | "UNFREEZE";

export interface AdminCommand {
  symbol: string;
  type: AdminCommandType;
  severity?: "MINOR" | "NOTABLE" | "CRITICAL";
  payload?: Record<string, unknown>;
}

// One-shot overrides queued by the admin trigger endpoint and drained by
// market-state-writer.ts on the next poll cycle for that symbol — this keeps a single
// writer in control of all state mutation regardless of which admin command fired.
// FREEZE is the one persistent (non-one-shot) command: it stays active until UNFREEZE.
const pending = new Map<string, AdminCommand[]>();
const frozen = new Set<string>();

export function enqueueCommand(cmd: AdminCommand): void {
  if (cmd.type === "FREEZE") {
    frozen.add(cmd.symbol);
    return;
  }
  if (cmd.type === "UNFREEZE") {
    frozen.delete(cmd.symbol);
    return;
  }
  const list = pending.get(cmd.symbol) ?? [];
  list.push(cmd);
  pending.set(cmd.symbol, list);
}

export function drainCommands(symbol: string): AdminCommand[] {
  const list = pending.get(symbol) ?? [];
  pending.delete(symbol);
  return list;
}

export function isFrozen(symbol: string): boolean {
  return frozen.has(symbol);
}
