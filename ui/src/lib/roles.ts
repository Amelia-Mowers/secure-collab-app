/**
 * Workspace roles.
 *
 * These are Matrix power levels, not an application-level ACL — which is the
 * whole point. Everywhere else in this app the client is the trust boundary
 * (the server sees only ciphertext), so a permission we merely *honoured* in
 * the UI would be advisory: a modified client could ignore it. A power level is
 * checked by the homeserver on every event, so a viewer's writes are refused
 * even if their client tries.
 *
 * - `admin`  (PL 100) — manage members and roles. The room creator starts here.
 * - `editor` (PL 0)   — the default; may send events, i.e. edit data.
 * - `viewer` (PL -1)  — below `events_default`, so the server rejects writes.
 *
 * Cell updates are ordinary timeline events, so `events_default` is exactly the
 * gate that decides who can change data.
 */

export type Role = 'admin' | 'editor' | 'viewer'

export const ROLE_LABELS: Record<Role, string> = {
  admin: 'Admin',
  editor: 'Editor',
  viewer: 'Viewer',
}

export const ROLE_DESCRIPTIONS: Record<Role, string> = {
  admin: 'Can edit data and manage members and roles',
  editor: 'Can edit data',
  viewer: 'Read-only',
}

/** A member of the workspace room, with the role their power level maps to. */
export interface WorkspaceMember {
  id: string
  name: string
  role: Role
}

/** Whether this role may change data. */
export function canEdit(role: Role): boolean {
  return role !== 'viewer'
}

/** Whether this role may manage members, roles, and the workspace itself. */
export function canAdminister(role: Role): boolean {
  return role === 'admin'
}
