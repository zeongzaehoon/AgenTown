export interface LoopControl {
  state: 'available' | 'local_authority' | 'competing_owner' | 'storage_failure' | 'closed';
  can_control: boolean;
  message: string;
}
export function canControl(control?: LoopControl | null): boolean {
  return control?.can_control === true && (control.state === 'available' || control.state === 'local_authority');
}
export function controlText(control?: LoopControl | null): string {
  if (control && (control.state === 'available' || control.state === 'local_authority') && !canControl(control)) return 'Local Loop control unavailable: authority was not granted. Inspect again before explicitly retrying.';
  switch (control?.state) {
    case 'available': return 'Local Loop control available. Start or stop only by explicit action.';
    case 'local_authority': return 'This server owns Loop execution. Local Loop control available.';
    case 'competing_owner': return 'Local Loop control unavailable: another server owns execution. Stop through the owning MCP server (stop_loop_v1) or web server. After shutting down that owner, inspect again and explicitly retry here.';
    case 'storage_failure': return 'Local Loop control unavailable: storage failure. Check database and lock-file access, then inspect again before explicitly retrying.';
    case 'closed': return 'Local Loop control unavailable: this service is closed. Reconnect to a running server.';
    default: return 'Local Loop control unavailable: unknown authority. Inspect again before explicitly retrying.';
  }
}
export function sourceText(source?: string | null): string {
  return `Caller-declared source (unverified): ${source || 'Unknown / legacy session'}. This label does not identify the execution owner.`;
}
