// SVG is the single source for both preview and PNG export. No generated HTML/SVG is accepted.
import { zipSync } from "./vendor/fflate-0.8.2.js";
const NS = "http://www.w3.org/2000/svg";
const font = "Arial, Apple SD Gothic Neo, sans-serif";
const accents = { ink: "#172331", blue: "#2457c5", green: "#14705c" };
const measure = document.createElement("canvas").getContext("2d");
export const defaultStyle = {
  brand: "N.ENGINEERING",
  accent: "ink",
  paper: "white",
};
function svgNode(tag, attrs = {}, text) {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  if (text !== undefined) n.textContent = text;
  return n;
}
function lines(text, size, width, weight) {
  measure.font = `${weight} ${size}px ${font}`;
  return String(text || "")
    .split("\n")
    .flatMap((p) => {
      const out = [];
      let line = "";
      for (const c of p) {
        if (line && measure.measureText(line + c).width > width) {
          out.push(line);
          line = "";
        }
        line += c;
      }
      out.push(line);
      return out;
    });
}
function block(
  parent,
  text,
  {
    x = 64,
    y,
    width = 952,
    height,
    size = 32,
    min = 26,
    weight = 400,
    color = "#172331",
  },
) {
  let wrapped;
  do {
    wrapped = lines(text, size, width, weight);
    if (wrapped.length * size * 1.45 <= height) break;
    size -= 2;
  } while (size >= min);
  if (size < min)
    throw new Error(
      "본문이 카드 영역을 넘어요. 문장을 줄이거나 다른 카드로 나눠 주세요.",
    );
  const n = svgNode("text", {
    "font-family": font,
    "font-size": size,
    "font-weight": weight,
    fill: color,
  });
  wrapped.forEach((l, i) =>
    n.append(svgNode("tspan", { x, y: y + i * size * 1.45 }, l)),
  );
  parent.append(n);
  return wrapped.length * size * 1.45;
}
let mathReady;
async function loadMath() {
  if (!mathReady)
    mathReady = new Promise((resolve, reject) => {
      window.MathJax = {
        startup: { typeset: false },
        tex: { packages: ["base", "ams"], maxBuffer: 5000, maxMacros: 1000 },
        svg: { fontCache: "none" },
        options: { enableMenu: false },
      };
      const script = document.createElement("script");
      script.src = new URL("./vendor/mathjax-3.2.2.js", import.meta.url).href;
      script.onload = () =>
        window.MathJax.startup.promise.then(resolve, reject);
      script.onerror = () => {
        mathReady = null;
        script.remove();
        reject(
          new Error("수식 표시 도구를 불러오지 못했어요. 다시 시도해 주세요."),
        );
      };
      document.head.append(script);
    });
  await mathReady;
}
async function formulaNode(formula) {
  await loadMath();
  const tex = formula
    .trim()
    .replace(/^\$\$([\s\S]*)\$\$$/, "$1")
    .replace(/^\\\[([\s\S]*)\\\]$/, "$1")
    .replace(/^\\\(([\s\S]*)\\\)$/, "$1");
  if (/\\(href|url|style|class|cssId|html|require|includegraphics)\b/.test(tex))
    throw new Error("수식에는 외부 링크나 HTML을 사용할 수 없어요.");
  const container = window.MathJax.tex2svg(tex, { display: true });
  if (container.querySelector('[data-mml-node="merror"]'))
    throw new Error(
      "LaTeX 수식을 확인해 주세요. 수식 오류가 있어 이미지로 내보낼 수 없어요.",
    );
  const svg = container.querySelector("svg");
  // Keep geometry only, including no event handlers, links or foreignObject.
  const tags = new Set([
    "svg",
    "g",
    "path",
    "rect",
    "line",
    "polyline",
    "polygon",
    "circle",
    "ellipse",
    "text",
    "title",
  ]);
  const attrs = new Set([
    "viewBox",
    "d",
    "transform",
    "x",
    "y",
    "x1",
    "x2",
    "y1",
    "y2",
    "width",
    "height",
    "rx",
    "ry",
    "cx",
    "cy",
    "r",
    "points",
    "fill",
    "stroke",
    "stroke-width",
    "font-size",
    "font-family",
    "text-anchor",
  ]);
  function clean(n) {
    if (!tags.has(n.localName))
      throw new Error("지원하지 않는 수식 표현입니다.");
    for (const a of [...n.attributes])
      if (!attrs.has(a.name)) n.removeAttribute(a.name);
    for (const child of n.children) clean(child);
  }
  clean(svg);
  return svg;
}
export async function renderCard(card, index, total, style = {}) {
  style = { ...defaultStyle, ...style };
  const ink = accents[style.accent] || accents.ink;
  const root = svgNode("svg", {
    xmlns: NS,
    viewBox: "0 0 1080 1080",
    width: 1080,
    height: 1080,
    role: "img",
    "aria-label": `${index + 1}번 카드: ${card.title}`,
  });
  root.append(
    svgNode("rect", {
      width: 1080,
      height: 1080,
      fill: style.paper === "warm" ? "#faf7f0" : "#ffffff",
    }),
  );
  block(root, style.brand, {
    y: 64,
    height: 45,
    size: 25,
    min: 25,
    weight: 700,
    color: ink,
  });
  root.append(
    svgNode("line", {
      x1: 64,
      y1: 95,
      x2: 1016,
      y2: 95,
      stroke: ink,
      "stroke-width": 2,
    }),
  );
  const titleHeight = block(root, card.title, {
    y: 164,
    height: 145,
    size: 48,
    min: 36,
    weight: 700,
    color: ink,
  });
  let y = 164 + titleHeight + 36;
  const artwork = card.artwork || [];
  const reserve =
    (artwork.length ? 300 : 0) +
    (card.formula ? 130 : 0) +
    (card.conditions ? 105 : 0);
  const bodyHeight = block(root, card.body, {
    y,
    height: 930 - y - reserve,
    size: 34,
    min: 26,
  });
  y += bodyHeight + 24;
  if (card.formula?.trim()) {
    const math = await formulaNode(card.formula);
    const vb = math.getAttribute("viewBox").split(/\s+/).map(Number);
    if (
      vb.length !== 4 ||
      !vb.every(Number.isFinite) ||
      vb[2] <= 0 ||
      vb[3] <= 0
    )
      throw new Error("수식 크기를 계산할 수 없어요.");
    const scale = Math.min(952 / vb[2], 100 / vb[3], 0.045);
    if (scale < 0.012)
      throw new Error("수식이 너무 길어요. 여러 줄로 나눠 주세요.");
    math.setAttribute("x", "64");
    math.setAttribute("y", y - 10);
    math.setAttribute("width", vb[2] * scale);
    math.setAttribute("height", vb[3] * scale);
    math.setAttribute("color", ink);
    // MathJax uses currentColor for paths.
    math
      .querySelectorAll('[fill="currentColor"]')
      .forEach((n) => n.setAttribute("fill", ink));
    math
      .querySelectorAll('[stroke="currentColor"]')
      .forEach((n) => n.setAttribute("stroke", ink));
    root.append(math);
    y += 120;
  }
  if (artwork.length) {
    const g = svgNode("g", { transform: `translate(64 ${y - 5}) scale(.8)` });
    const markerId = `arrow-${index}`;
    const defs = svgNode("defs");
    const marker = svgNode("marker", {
      id: markerId,
      viewBox: "0 0 10 10",
      refX: 9,
      refY: 5,
      markerWidth: 9,
      markerHeight: 9,
      orient: "auto-start-reverse",
    });
    marker.append(svgNode("path", { d: "M 0 0 L 10 5 L 0 10 z", fill: ink }));
    defs.append(marker);
    root.append(defs);
    for (const e of artwork) {
      let shape;
      if (e.kind === "line" || e.kind === "arrow")
        shape = svgNode("line", {
          x1: e.x,
          y1: e.y,
          x2: e.x2,
          y2: e.y2,
          stroke: ink,
          "stroke-width": 3,
          ...(e.kind === "arrow" ? { "marker-end": `url(#${markerId})` } : {}),
        });
      else if (e.kind === "circle")
        shape = svgNode("ellipse", {
          cx: (e.x + e.x2) / 2,
          cy: (e.y + e.y2) / 2,
          rx: Math.abs(e.x2 - e.x) / 2,
          ry: Math.abs(e.y2 - e.y) / 2,
          fill: "none",
          stroke: ink,
          "stroke-width": 3,
        });
      else if (e.kind === "rect")
        shape = svgNode("rect", {
          x: Math.min(e.x, e.x2),
          y: Math.min(e.y, e.y2),
          width: Math.abs(e.x2 - e.x),
          height: Math.abs(e.y2 - e.y),
          fill: "none",
          stroke: ink,
          "stroke-width": 3,
        });
      if (shape) g.append(shape);
      if (e.text) {
        measure.font = `26px ${font}`;
        if (e.x + measure.measureText(e.text).width > 1000 || e.y < 26)
          throw new Error(
            "도식 라벨이 영역을 넘어요. 위치나 글자 수를 조정해 주세요.",
          );
        g.append(
          svgNode(
            "text",
            { x: e.x, y: e.y, "font-size": 26, "font-family": font, fill: ink },
            e.text,
          ),
        );
      }
    }
    root.append(g);
    y += 300;
  }
  if (card.conditions?.trim())
    block(root, `적용 조건 · ${card.conditions}`, {
      y,
      height: 100,
      size: 26,
      min: 24,
      color: "#526274",
    });
  root.append(
    svgNode("line", { x1: 64, y1: 996, x2: 1016, y2: 996, stroke: "#d8dee5" }),
  );
  block(
    root,
    `${String(index + 1).padStart(2, "0")} / ${String(total).padStart(2, "0")}`,
    { y: 1040, height: 40, size: 22, min: 22, color: "#526274" },
  );
  return root;
}
export function saveBlob(filename, blob) {
  const url = URL.createObjectURL(blob),
    a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
export async function png(svg) {
  const url = URL.createObjectURL(
    new Blob([new XMLSerializer().serializeToString(svg)], {
      type: "image/svg+xml;charset=utf-8",
    }),
  );
  try {
    const image = new Image();
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error("카드 이미지 변환에 실패했어요."));
      image.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1080;
    canvas.getContext("2d").drawImage(image, 0, 0, 1080, 1080);
    return await new Promise((resolve, reject) =>
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error("PNG 저장에 실패했어요."))),
        "image/png",
      ),
    );
  } finally {
    URL.revokeObjectURL(url);
  }
}
export async function exportCards(doc, onlyIndex = null) {
  const snapshot = structuredClone(doc),
    cards = snapshot.draft.cards,
    files = {};
  for (let i = 0; i < cards.length; i++) {
    if (onlyIndex !== null && i !== onlyIndex) continue;
    let blob;
    try {
      blob = await png(
        await renderCard(cards[i], i, cards.length, snapshot.style),
      );
    } catch (e) {
      throw new Error(`${i + 1}번 카드: ${e.message}`);
    }
    const name = `card-${String(i + 1).padStart(2, "0")}.png`;
    if (onlyIndex !== null) {
      saveBlob(name, blob);
      return;
    }
    files[name] = new Uint8Array(await blob.arrayBuffer());
  }
  files["editable-cards.json"] = new TextEncoder().encode(
    JSON.stringify(
      { draft: snapshot.draft, style: snapshot.style || defaultStyle },
      null,
      2,
    ),
  );
  saveBlob(
    "cards.zip",
    new Blob([zipSync(files, { level: 0 })], { type: "application/zip" }),
  );
}
