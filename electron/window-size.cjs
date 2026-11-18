/**
 * Window sizing from the display's work area (screen minus menu bar / dock /
 * taskbar). Pure functions so they can be unit tested without Electron.
 */

const FILL = 0.9; // fraction of the work area a new window takes
const MIN_WIDTH = 1024;
const MIN_HEIGHT = 640;

/** Initial bounds + minimum size for a window on the given work area. */
function initialWindowBounds(workArea) {
  const minWidth = Math.min(MIN_WIDTH, workArea.width);
  const minHeight = Math.min(MIN_HEIGHT, workArea.height);
  const width = Math.min(workArea.width, Math.max(minWidth, Math.round(workArea.width * FILL)));
  const height = Math.min(workArea.height, Math.max(minHeight, Math.round(workArea.height * FILL)));
  return {
    x: workArea.x + Math.round((workArea.width - width) / 2),
    y: workArea.y + Math.round((workArea.height - height) / 2),
    width,
    height,
    minWidth,
    minHeight,
  };
}

/** New bounds that keep the window fully inside the work area, or null if it
 *  already fits (used when the resolution or display layout changes). */
function fitBoundsToWorkArea(bounds, workArea) {
  const width = Math.min(bounds.width, workArea.width);
  const height = Math.min(bounds.height, workArea.height);
  const x = Math.min(Math.max(bounds.x, workArea.x), workArea.x + workArea.width - width);
  const y = Math.min(Math.max(bounds.y, workArea.y), workArea.y + workArea.height - height);
  if (x === bounds.x && y === bounds.y && width === bounds.width && height === bounds.height) return null;
  return { x, y, width, height };
}

module.exports = { initialWindowBounds, fitBoundsToWorkArea };
