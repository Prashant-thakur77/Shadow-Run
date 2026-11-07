// Which runs this browser started, so its Recent runs list leads with them. A convenience: without storage the list just
// shows the examples, with Show all for the rest.
const KEY = 'sr.myRuns';
const KEEP = 30;

export function myRuns(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string').slice(0, KEEP) : [];
  } catch {
    return [];
  }
}

export function rememberRun(id: string): void {
  try {
    localStorage.setItem(KEY, JSON.stringify([id, ...myRuns().filter((x) => x !== id)].slice(0, KEEP)));
  } catch {
    // Storage may be blocked. The list then shows the examples.
  }
}
