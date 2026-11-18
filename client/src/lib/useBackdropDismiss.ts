import { useMemo, useRef } from 'react';
import type { MouseEvent } from 'react';

/**
 * Close-on-backdrop for modal dialogs. Spread the result onto the backdrop
 * element (the full-screen scrim that contains the dialog).
 *
 * A plain `onClick` on the backdrop also fires when a press starts inside the
 * dialog and is released outside it, because the browser sends the click to
 * the nearest common ancestor. Dragging to select text in a field and
 * overshooting the dialog edge then closed it and threw the edit away. Here a
 * click only dismisses when the press began on the backdrop too.
 */
export function useBackdropDismiss(onClose: () => void) {
  const pressedInsideRef = useRef(false);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  return useMemo(() => ({
    onMouseDown: (e: MouseEvent<HTMLElement>) => {
      pressedInsideRef.current = e.target !== e.currentTarget;
    },
    onClick: (e: MouseEvent<HTMLElement>) => {
      const pressedInside = pressedInsideRef.current;
      pressedInsideRef.current = false;
      if (e.target === e.currentTarget && !pressedInside) onCloseRef.current();
    },
  }), []);
}
