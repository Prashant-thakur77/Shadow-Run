/** What Home knows about a run it just started, so the first frame of the run page already has the task on it. A view
 *  transition can only join two elements that exist in the same instant, and the page hasn't fetched anything yet. */
const pending = new Map<string, { text: string; plan: boolean }>();

export function handOffRun(id: string, text: string, plan: boolean) {
  pending.set(id, { text, plan });
}

export function handedOffRun(id: string): { text: string; plan: boolean } | undefined {
  return pending.get(id);
}
