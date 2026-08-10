import { useEffect, useRef } from 'react'

/**
 * Admit people who knock with a valid invite link, while this workspace is open.
 *
 * A Matrix invite names a user, and someone holding a link has no user id until
 * they sign up — so a link cannot be an invite. They knock instead, and someone
 * already in the room has to decide. That decision is made HERE rather than on
 * a server, because a server that could admit members would be a party with
 * power over an end-to-end encrypted workspace, and there is deliberately no
 * such party (issue 5e362d42).
 *
 * The consequence is honest and has to be said in the UI: a link only admits
 * someone while a member's client is actually running. See `JoinPage`, which
 * says so.
 *
 * Runs for every member, not just admins. Whoever gets there first admits; the
 * rest fail harmlessly because the knock is already resolved. Restricting it to
 * admins would make links silently stop working for teams whose admin is on
 * holiday, which is the failure this whole design is trying to avoid.
 */
export function useAutoAdmit(workspace: any, syncCount?: number) {
  // Never admit the same person twice for one token. Two ticks can overlap when
  // a sync lands mid-flight, and the second would count a second use against a
  // limited link for a member who is already in.
  const handled = useRef<Set<string>>(new Set())
  const running = useRef(false)

  useEffect(() => {
    if (!workspace) return
    if (typeof workspace.listKnocks !== 'function') return
    if (typeof workspace.admitKnock !== 'function') return
    if (running.current) return

    let cancelled = false
    running.current = true

    void (async () => {
      try {
        const knocks = JSON.parse(await workspace.listKnocks()) as Array<{
          userId: string
          token: string | null
        }>
        for (const knock of knocks) {
          if (cancelled) return
          // No token means they found the room some other way. A person can
          // still be admitted by hand; nothing here will do it for them.
          if (!knock.token) continue
          const key = `${knock.userId}:${knock.token}`
          if (handled.current.has(key)) continue
          handled.current.add(key)
          try {
            await workspace.admitKnock(knock.userId, knock.token)
          } catch {
            // Expired, revoked, exhausted, or already admitted by another
            // member's client. All of those are the answer being "no" or
            // "already done", neither of which is this hook's problem to
            // report — an admin sees pending requests in the share dialog.
          }
        }
      } catch {
        // Reading knocks failed (offline, or not permitted). The next sync
        // tries again.
      } finally {
        running.current = false
      }
    })()

    return () => {
      cancelled = true
    }
  }, [workspace, syncCount])
}
