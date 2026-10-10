/** Private document cleanup with a restoration listener that outlives application disposal. */

/**
 * Discard private state while retaining one BFcache restoration reload.
 * *
 * @param event - browser page departure facts.
 * *
 * @param target - departing document's window; its unload owns the one-shot listener.
 * *
 * @param discard - synchronously clear the page and start disposing its application.
 * *
 * @param reload - load a fresh document whose authentication is checked again.
 */
export function discardPrivatePage(
  event: Pick<PageTransitionEvent, 'persisted'>, target: Pick<Window, 'addEventListener'>,
  discard: () => void, reload: () => void,
): void {
  if (event.persisted) target.addEventListener('pageshow', reload, { once: true })
  discard()
}
