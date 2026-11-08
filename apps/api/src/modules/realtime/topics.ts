import type { AuthPrincipal } from '../auth/principal';

/** Each event belongs to one topic; seeing a topic in a branch needs the matching read right there. */
export const TOPIC_PERMISSION = {
  orders: 'orders.read',
  kitchen: 'kot.read',
  tables: 'tables.read',
  payments: 'payments.read',
} as const;

export type Topic = keyof typeof TOPIC_PERMISSION;
export const TOPICS = Object.keys(TOPIC_PERMISSION) as Topic[];

export function canSeeBranch(actor: AuthPrincipal, branchId: string): boolean {
  const access = actor.permissions.accessibleBranches();
  return access === 'ALL' || access.includes(branchId);
}

/** The requested topics (default: all) that the caller may see in the branch. */
export function permittedTopics(actor: AuthPrincipal, branchId: string, requested?: string[]): Topic[] {
  if (!canSeeBranch(actor, branchId)) return [];
  const wanted = requested?.length ? TOPICS.filter((t) => requested.includes(t)) : TOPICS;
  return wanted.filter((t) => actor.permissions.has(TOPIC_PERMISSION[t], branchId));
}

export const roomFor = (branchId: string, topic: Topic) => `b:${branchId}:${topic}`;
