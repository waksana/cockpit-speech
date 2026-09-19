export function keyboardDOM() {
  let mutation: (() => void) | undefined;
  let observers = 0;
  const window = Object.assign(new EventTarget(), {
    innerWidth: 1000, innerHeight: 800,
    getComputedStyle: (element: { style: { visibility: string; display: string } }) => element.style,
    MutationObserver: class {
      constructor(callback: () => void) { mutation = callback; }
      observe() { observers++; }
      disconnect() { observers--; mutation = undefined; }
    },
  });
  const document = Object.assign(new EventTarget(), {
    focused: true, visibilityState: 'visible', defaultView: window,
    hasFocus: () => document.focused,
    activeElement: null as unknown, body: {}, documentElement: {},
    overlays: [] as unknown[],
    querySelectorAll: () => document.overlays,
  });
  document.activeElement = document.body;
  function editor() {
    const node = {
      ownerDocument: document, isConnected: true, hidden: false, disabled: false, readOnly: false, value: '',
      style: { visibility: 'visible', display: 'block' },
      rect: { left: 0, right: 200, top: 0, bottom: 80 },
      selectionStart: 0, selectionEnd: 0,
      closest: () => node.hidden ? node : null,
      getBoundingClientRect: () => node.rect,
      getClientRects: () => node.style.display === 'none' ? [] : [node.rect],
      focus() { document.activeElement = node; document.dispatchEvent(new Event('focusin')); },
      setSelectionRange(start: number, end: number) { node.selectionStart = start; node.selectionEnd = end; },
    };
    return node;
  }
  const key = (type: 'keydown' | 'keyup', patch: Partial<KeyboardEvent> = {}) => {
    const event = Object.assign(new Event(type, { cancelable: true }), {
      key: 'F8', code: 'F8', repeat: false, isComposing: false, keyCode: 119,
      altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...patch,
    });
    document.dispatchEvent(event);
    return event;
  };
  return { window, document, editor, key, mutate: () => mutation?.(), observers: () => observers };
}
