/**
 * Host half of dsh-notify.
 *
 * The feature is browser-side: the Client half reads the Session list snapshot
 * (`ctx.sessions.list`), notices `running` falling edges, and posts a system
 * notification while the page is not in front. The Host half therefore only
 * exists so the bundle patch can mount the plugin row and publish its Client
 * module; it declares no service and stays active in any profile that mounts
 * a Web UI.
 *
 * @module dsh-notify
 */

/** No host service is required; the Client half owns all behavior. */
export function apply() {}
