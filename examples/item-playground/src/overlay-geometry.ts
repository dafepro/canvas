export interface FloatingRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export interface ViewportSize {
  width: number;
  height: number;
}

/** Shift a floating panel into the viewport, prioritizing its top-left when it cannot fit. */
export const clampFloatingRect = (
  rect: Readonly<FloatingRect>,
  viewport: Readonly<ViewportSize>,
  inset = 8,
): Readonly<{ x: number; y: number }> => {
  const availableWidth = Math.max(0, viewport.width - inset * 2);
  const availableHeight = Math.max(0, viewport.height - inset * 2);
  const x = rect.width > availableWidth
    ? inset - rect.left
    : rect.left < inset
      ? inset - rect.left
      : rect.right > viewport.width - inset
        ? viewport.width - inset - rect.right
        : 0;
  const y = rect.height > availableHeight
    ? inset - rect.top
    : rect.top < inset
      ? inset - rect.top
      : rect.bottom > viewport.height - inset
        ? viewport.height - inset - rect.bottom
        : 0;
  return Object.freeze({ x, y });
};
