/** Viewport geometry and event ownership without DOM mutations. */

/**
 * Read an unzoomed visible rectangle; null means retain the previous layout during user zoom.
 * @param {object} viewport - Browser VisualViewport measurements in CSS pixels.
 * @returns {object|null} Visible rectangle, or null during zoom or an empty transition frame.
 */
export function viewportFrame(viewport) {
  if (Math.abs(viewport.scale - 1) > 0.01 || viewport.width <= 0 || viewport.height <= 0) return null;
  return { width: viewport.width, height: viewport.height, top: viewport.offsetTop, left: viewport.offsetLeft };
}

/**
 * Publish at most once per animation frame and cancel all owned work on disposal.
 * @param {object} source - Viewport/page event targets, frame scheduling and a current-value reader.
 * @param {Function} publish - Receives each current value, including the initial one.
 * @returns {Function} Removes listeners and cancels an outstanding frame.
 */
export function watchViewport(source, publish) {
  let frame = null;
  const update = () => { frame = null; publish(source.read()); };
  const schedule = () => {
    if (frame === null) frame = source.requestFrame(update);
  };
  const events = [
    [source.viewport, 'resize'], [source.viewport, 'scroll'],
    [source.page, 'resize'], [source.page, 'orientationchange'], [source.page, 'pageshow'],
  ];
  for (const [target, name] of events) target.addEventListener(name, schedule);
  update();
  return () => {
    for (const [target, name] of events) target.removeEventListener(name, schedule);
    if (frame !== null) source.cancelFrame(frame);
  };
}
