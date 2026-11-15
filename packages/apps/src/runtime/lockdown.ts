// Runs before any App code. CSP can't stop WebRTC (its directive hasn't shipped) or WebKit's preconnects, so the
// runtime removes what an App never needs. A fresh realm can't be borrowed back: the frame's opaque origin makes any
// child frame cross-origin to it (tested in all three engines).
//
// Every built-in the checks below rely on is captured here, before App code exists, and called through those
// captured references. An App can replace Set.prototype.has, String.prototype.toLowerCase, Array.prototype.pop,
// Symbol.hasInstance or an accessor like localName afterwards; the checks never look at the replacements. (A first
// version used the live prototypes, and a <link> got through in WebKit that way.)
const apply = Reflect.apply;
const defineProperty = Object.defineProperty;
const getDescriptor = Object.getOwnPropertyDescriptor;
const Str = String;
const DOMEx = DOMException;
const setHas = Set.prototype.has;
const toLower = String.prototype.toLowerCase;
const lastIndexOf = String.prototype.lastIndexOf;
const strSlice = String.prototype.slice;
const nodeTypeOf = (getDescriptor(Node.prototype, "nodeType") as PropertyDescriptor).get as () => number;
const localNameOf = (getDescriptor(Element.prototype, "localName") as PropertyDescriptor).get as () => string;
const elementQuery = Element.prototype.querySelector;
const fragmentQuery = DocumentFragment.prototype.querySelector;

const refuse = (what: string) => () => {
  throw new DOMEx(`${what} isn't available to Apps`, "SecurityError");
};

export function lockdown(): void {
  const w = window as unknown as Record<string, unknown>;
  for (const k of [
    "RTCPeerConnection",
    "webkitRTCPeerConnection",
    "RTCDataChannel",
    "WebTransport",
    "SharedWorker",
    "Worker",
    "WebSocket",
    "EventSource",
    "XMLHttpRequest",
    "fetch",
    "DOMParser",
    "XSLTProcessor",
    "BroadcastChannel",
  ]) {
    try {
      defineProperty(window, k, { value: undefined, configurable: false, writable: false });
    } catch {
      w[k] = undefined;
    }
  }
  try {
    defineProperty(Navigator.prototype, "sendBeacon", { value: refuse("sendBeacon"), configurable: false });
  } catch {
    /* ignore */
  }

  // Elements an App never renders: anything that fetches, navigates or embeds. The kit draws links through the host.
  const blocked = new Set([
    "link",
    "meta",
    "base",
    "iframe",
    "frame",
    "object",
    "embed",
    "script",
    "form",
    "a",
    "area",
    "portal",
    "audio",
    "video",
    "source",
    "track",
    "image",
    "use",
    "foreignobject",
  ]);
  const isBlocked = (name: string) => apply(setHas, blocked, [apply(toLower, name, [])]) as boolean;
  const localPart = (name: string) => apply(strSlice, name, [apply(lastIndexOf, name, [":"]) + 1]) as string;
  const sel = "link,meta,base,iframe,frame,object,embed,script,form,a,area,portal,audio,video,source,track";

  const create = Document.prototype.createElement;
  defineProperty(Document.prototype, "createElement", {
    configurable: false,
    writable: false,
    value: function (this: Document, tag: unknown, opts?: ElementCreationOptions) {
      const name = Str(tag); // converted once: the same string is checked and created
      if (isBlocked(name)) throw new DOMEx(`<${name}> isn't available to Apps`, "SecurityError");
      return apply(create, this, [name, opts]);
    },
  });
  const createNS = Document.prototype.createElementNS;
  defineProperty(Document.prototype, "createElementNS", {
    configurable: false,
    writable: false,
    value: function (this: Document, ns: unknown, tag: unknown, opts?: ElementCreationOptions) {
      const name = Str(tag);
      if (isBlocked(localPart(name))) throw new DOMEx(`<${name}> isn't available to Apps`, "SecurityError");
      return apply(createNS, this, [ns == null ? null : Str(ns), name, opts]);
    },
  });

  // Cloning or importing one of them, or a tree holding one.
  const guard = <T extends Node>(n: T): T => {
    const type = apply(nodeTypeOf, n, []) as number;
    if (type === 1 && (isBlocked(apply(localNameOf, n, []) as string) || apply(elementQuery, n, [sel])))
      throw new DOMEx("That element can't be copied in an App", "SecurityError");
    if (type === 11 && apply(fragmentQuery, n, [sel]))
      throw new DOMEx("That fragment can't be copied in an App", "SecurityError");
    return n;
  };
  const clone = Node.prototype.cloneNode;
  defineProperty(Node.prototype, "cloneNode", {
    configurable: false,
    writable: false,
    value: function (this: Node, deep?: boolean) {
      return guard(apply(clone, this, [deep]) as Node);
    },
  });
  const imp = Document.prototype.importNode;
  defineProperty(Document.prototype, "importNode", {
    configurable: false,
    writable: false,
    value: function (this: Document, n: Node, deep?: boolean) {
      return guard(apply(imp, this, [guard(n), deep]) as Node);
    },
  });
  const adopt = Document.prototype.adoptNode;
  defineProperty(Document.prototype, "adoptNode", {
    configurable: false,
    writable: false,
    value: function (this: Document, n: Node) {
      return apply(adopt, this, [guard(n)]);
    },
  });

  // Every way to turn a string into DOM. Clearing with "" is how libraries empty a node; anything else is refused.
  for (const [proto, prop] of [
    [Element.prototype, "innerHTML"],
    [Element.prototype, "outerHTML"],
    [ShadowRoot.prototype, "innerHTML"],
  ] as const) {
    const d = getDescriptor(proto, prop);
    if (d)
      defineProperty(proto, prop, {
        configurable: false,
        get: d.get,
        set(this: Element, v: unknown) {
          if (v === "" && d.set) return apply(d.set, this, [""]);
          refuse(prop)();
        },
      });
  }
  for (const [proto, prop] of [
    [Element.prototype, "insertAdjacentHTML"],
    [Element.prototype, "setHTMLUnsafe"],
    [ShadowRoot.prototype, "setHTMLUnsafe"],
    [Range.prototype, "createContextualFragment"],
    [Document.prototype, "write"],
    [Document.prototype, "writeln"],
    [Document.prototype, "open"],
    [Document.prototype, "execCommand"],
    [DOMImplementation.prototype, "createHTMLDocument"],
    [DOMImplementation.prototype, "createDocument"],
  ] as const) {
    if (prop in proto) defineProperty(proto, prop, { configurable: false, writable: false, value: refuse(prop) });
  }
  if ("parseHTMLUnsafe" in Document)
    defineProperty(Document, "parseHTMLUnsafe", {
      configurable: false,
      writable: false,
      value: refuse("parseHTMLUnsafe"),
    });
  for (const k of ["open", "print"])
    defineProperty(window, k, { configurable: false, writable: false, value: refuse(k) });
}
