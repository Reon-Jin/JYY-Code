/**
 * Whether the server rejected an interactive reply because the request is no
 * longer pending. Permission and question requests live in server memory and
 * are dropped when they time out, when their session is cancelled, or when
 * another client answers them, so a card rendered from an older snapshot can
 * still be on screen when the user clicks.
 *
 * The SDK keeps the decoded error body and the HTTP status under `cause`.
 */
export function isMissingRequestError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const cause: unknown = error.cause
  if (typeof cause !== "object" || cause === null) return false
  if ("status" in cause && cause.status === 404) return true
  if (!("body" in cause)) return false
  const body: unknown = cause.body
  if (typeof body !== "object" || body === null || !("_tag" in body)) return false
  return body._tag === "PermissionNotFoundError" || body._tag === "QuestionNotFoundError"
}
