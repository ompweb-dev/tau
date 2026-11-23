"use client";

import { useMemo, type CSSProperties } from "react";
import { CodeBlock } from "./MermaidBlock";

interface SvgBlockProps {
  code: string;
  isStreaming?: boolean;
}

// TUI theme variable aliases. The TUI-facing svg conventions use
// --fg / --muted / --surface / --c1..--c6, which do not exist in the web
// theme; without aliases those fills resolve to nothing and the drawing
// turns black on a dark background. --c1..--c6 map to status colours as an
// approximation (#421).
const SVG_THEME_ALIASES: Record<string, string> = {
  "--fg": "var(--text)",
  "--muted": "var(--text-muted)",
  "--surface": "var(--bg-panel)",
  "--c1": "var(--accent)",
  "--c2": "var(--status-success)",
  "--c3": "var(--status-warning)",
  "--c4": "var(--status-error)",
  "--c5": "var(--status-modified)",
  "--c6": "var(--status-renamed)",
};

// Only these SVG elements survive; everything else (script, foreignObject,
// style, set/animate, which can retarget an href to javascript:, and any
// non-SVG element) is removed with its content. An allowlist, because the
// markup is re-parsed as HTML on insertion: HTML element names inside <svg>
// break out of foreign content there. <style> stays out: inline SVG CSS
// applies to the whole document.
const SVG_NS = "http://www.w3.org/2000/svg";
const ALLOWED_ELEMENTS = new Set([
  "svg", "g", "defs", "symbol", "use", "title", "desc", "a", "image",
  "path", "rect", "circle", "ellipse", "line", "polyline", "polygon",
  "text", "tspan", "textPath", "marker", "pattern", "clipPath", "mask",
  "linearGradient", "radialGradient", "stop", "filter",
  "feBlend", "feColorMatrix", "feComponentTransfer", "feComposite", "feConvolveMatrix",
  "feDiffuseLighting", "feDisplacementMap", "feDistantLight", "feDropShadow", "feFlood",
  "feFuncA", "feFuncB", "feFuncG", "feFuncR", "feGaussianBlur", "feImage", "feMerge",
  "feMergeNode", "feMorphology", "feOffset", "fePointLight", "feSpecularLighting",
  "feSpotLight", "feTile", "feTurbulence",
]);
// Block every data: URI, not just data:text/html: a <use> or <image> can
// reference data:image/svg+xml,<svg><script>…</script></svg> and the browser
// parses and executes the nested SVG's scripts. vbscript: is dead in modern
// browsers but still honored by some embedded WebViews — block it too. URL
// parsing drops tabs, newlines and other control characters inside a scheme
// (`java&#9;script:`), so they are removed before the test.
const UNSAFE_HREF = /^(javascript|vbscript|data):/i;
const UNSAFE_ATTRIBUTE = /^on/i;
// A style attribute can smuggle code through url(javascript:…) or the legacy
// IE expression(…); match inside url(…) rather than at the value start,
// since the URL sits after a property name (background: url(…)).
const UNSAFE_STYLE = /expression\s*\(|url\s*\(\s*['"]?\s*(javascript|vbscript|data):/i;
const squash = (value: string) => value.replace(/[\u0000-\u0020\u007f-\u009f]/g, "");

function sanitizeSvg(root: Element): void {
  const doc = root.ownerDocument;
  const walk = (node: Node): void => {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === 1) {
        const el = child as Element;
        // A fence without xmlns parses into no namespace; the HTML parser makes it SVG.
        if ((el.namespaceURI !== SVG_NS && el.namespaceURI !== null) || !ALLOWED_ELEMENTS.has(el.localName)) {
          el.remove();
          continue;
        }
        walk(el);
      } else if (child.nodeType === 4) {
        // CDATA would be serialized as <![CDATA[…]]>, which the HTML parser
        // reads as a bogus comment ending at the first ">": its text could
        // become live markup. As a text node its "<" is escaped.
        child.replaceWith(doc.createTextNode(child.nodeValue ?? ""));
      } else if (child.nodeType !== 3) {
        // Comments and processing instructions: nothing to show, and a
        // processing instruction re-parses as a bogus comment too.
        child.remove();
      }
    }
  };
  walk(root);
  // The walk covers descendants only — the root itself can also carry an on*
  // handler or a javascript: href, so sweep it too.
  for (const el of [root, ...root.querySelectorAll("*")]) {
    for (const attr of [...el.attributes]) {
      // localName, so any prefix bound to the xlink namespace is caught too.
      if (UNSAFE_ATTRIBUTE.test(attr.localName)
        || (attr.localName.toLowerCase() === "href" && UNSAFE_HREF.test(squash(attr.value)))
        || (attr.localName.toLowerCase() === "style" && UNSAFE_STYLE.test(squash(attr.value)))) {
        el.removeAttributeNode(attr);
      }
    }
  }
}

/**
 * Parse + sanitize an SVG fence into embeddable markup, or null when the
 * source is not a well-formed `<svg>` document (malformed input, or a fence
 * still streaming half-written markup). Pure except for DOMParser /
 * XMLSerializer, so tests drive it directly.
 */
export function parseSvgMarkup(code: string): string | null {
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(code, "image/svg+xml");
  } catch {
    return null;
  }
  if (doc.querySelector("parsererror")) return null;
  const root = doc.documentElement;
  if (!root || root.nodeName.toLowerCase() !== "svg") return null;
  sanitizeSvg(root);
  const style = root.getAttribute("style");
  root.setAttribute("style", `${style ? `${style};` : ""}max-width:100%;height:auto`);
  if (!root.hasAttribute("fill")) root.setAttribute("fill", "currentColor");
  if (!root.hasAttribute("xmlns")) root.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  return new XMLSerializer().serializeToString(root);
}

export function SvgBlock({ code, isStreaming }: SvgBlockProps) {
  const markup = useMemo(() => parseSvgMarkup(code), [code]);

  // Streaming generates half-written markup; fall back to the code block until
  // the fence closes.
  if (!markup) {
    return <CodeBlock code={code} lang="svg" isStreaming={isStreaming} />;
  }
  return (
    <div
      className="markdown-svg-block"
      style={{
        ...SVG_THEME_ALIASES,
        color: "var(--text)",
        display: "flex",
        justifyContent: "center",
        overflow: "auto",
        padding: "4px 0",
      } as CSSProperties}
      dangerouslySetInnerHTML={{ __html: markup }}
    />
  );
}
