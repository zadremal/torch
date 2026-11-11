// The size of the docked details panel, remembered in the browser between visits. It is a viewer's
// convenience, not address state: a link opens the panel at the size the reader chose. The width is shared by
// the side docks of the timeline and the overview; the height belongs to the bottom dock.
import { useState } from "react";

const WIDTH_KEY = "torch.panel.width";
const HEIGHT_KEY = "torch.panel.height";

function read(key: string): number | undefined {
  try {
    const value = Number(localStorage.getItem(key));
    return Number.isFinite(value) && value > 0 ? value : undefined;
  } catch {
    // No storage (server rendering, blocked site data): the panel keeps its default size.
    return undefined;
  }
}

function write(key: string, size: number | undefined): void {
  try {
    if (size === undefined) localStorage.removeItem(key);
    else localStorage.setItem(key, String(size));
  } catch {
    // The size still applies until the page is reloaded.
  }
}

/** A remembered size in pixels; `undefined` is the default size from CSS. */
function useStoredSize(key: string): [number | undefined, (size: number | undefined) => void] {
  const [size, setSize] = useState(() => read(key));
  const set = (next: number | undefined) => {
    write(key, next);
    setSize(next);
  };
  return [size, set];
}

export const usePanelWidth = () => useStoredSize(WIDTH_KEY);
export const usePanelHeight = () => useStoredSize(HEIGHT_KEY);
