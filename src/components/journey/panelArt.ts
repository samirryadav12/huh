import type { Project } from "@/data/projects";
import { getStoreBundlesForProject } from "@/data/stores";
import type { PanelPreview, StationKind } from "./stage";

/* The floating panels of the panel journey: what each one previews (straight from the project's data) and how
   it is painted onto a canvas that becomes the panel's texture. */

// remote images go through Next's image endpoint so they arrive same-origin (a cross-origin image would taint the
// canvas and could not be uploaded to WebGL); local ones are used as they are
const sameOrigin = (src?: string) =>
  !src ? undefined : /^https?:\/\//.test(src) ? `/_next/image?url=${encodeURIComponent(src)}&w=640&q=75` : encodeURI(src);

export function panelPreviews(project: Project, chapters: { id: StationKind; label: string }[]): PanelPreview[] {
  const bom = project.bom ?? [], pins = project.pinout ?? [], steps = project.steps ?? [], faqs = project.faqs ?? [];
  const code = (project.arduinoCode ?? "").split("\n").filter((l) => l.trim());
  const stores = getStoreBundlesForProject(project);
  const photo = sameOrigin(project.realImage ?? project.image);
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
  return chapters.map((c, i) => {
    const eyebrow = `${String(i + 1).padStart(2, "0")} · ${c.label}`;
    switch (c.id) {
      case "overview":
        return { eyebrow, title: project.title, stats: [project.level, project.timeEstimate, plural(project.partsCount, "part")], thumb: photo, lines: [project.shortDescription ?? project.description] };
      case "bom":
        return { eyebrow, title: "Every part, laid out", stats: [plural(bom.length, "part"), plural(new Set(bom.map((b) => b.category)).size, "category")], lines: bom.slice(0, 6).map((b) => `${b.qty}× ${b.name}`) };
      case "wiring":
        return { eyebrow, title: "Follow every wire", stats: [plural(pins.length, "connection"), plural(new Set(pins.map((p) => p.wireColor)).size, "wire colour")], thumb: sameOrigin(project.wiringImage ?? `/robotics/wiring/${project.slug}/wiring.png`), lines: pins.slice(0, 6).map((p) => `${p.componentPin} → ${p.targetPin}`) };
      case "pinout":
        return { eyebrow, title: "Where each wire lands", stats: [plural(pins.length, "pin"), project.microcontroller], thumb: sameOrigin(`/robotics/pinout/${project.slug}/pinout.png`), lines: pins.slice(0, 6).map((p) => `${p.targetPin}  ${p.componentPin}`) };
      case "steps":
        return { eyebrow, title: "Build it step by step", stats: [plural(steps.length, "step"), project.timeEstimate], lines: steps.slice(0, 6).map((s) => `${s.stepNumber}. ${s.title}`) };
      case "view3d":
        return { eyebrow, title: "Turn it around in 3D", stats: ["Drag to rotate", "Tap any part"], thumb: photo, lines: ["The finished robot in 3D."] };
      case "code":
        return { eyebrow, title: "Give it a brain", stats: [plural(code.length, "line"), project.microcontroller], lines: code.slice(0, 13), code: true };
      case "stores":
        return { eyebrow, title: "Get the parts", stats: [plural(stores.length, "store"), stores.find((s) => s.isTopStock)?.name ?? "Compare prices"].filter(Boolean) as string[], lines: stores.slice(0, 6).map((s) => `${s.name} · ${s.availableParts} parts`) };
      case "faq":
        return { eyebrow, title: "Questions, answered", stats: [plural(faqs.length, "question")], lines: faqs.slice(0, 4).map((f) => f.q) };
      default:
        return { eyebrow, title: c.label, stats: [] };
    }
  });
}

const W = 1024, H = 640;

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

function wrap(g: CanvasRenderingContext2D, text: string, maxW: number, maxLines: number) {
  const words = text.split(/\s+/), out: string[] = [];
  let line = "";
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (g.measureText(next).width > maxW && line) { out.push(line); line = w; } else line = next;
    if (out.length === maxLines) break;
  }
  if (out.length < maxLines && line) out.push(line);
  if (out.length === maxLines && words.join(" ") !== out.join(" ")) {
    let last = out[maxLines - 1];
    while (last && g.measureText(`${last}…`).width > maxW) last = last.slice(0, -1);
    out[maxLines - 1] = `${last}…`;
  }
  return out;
}

/* paints one panel; repaints once the page font and the thumbnail have loaded */
export function createPanelArt(p: PanelPreview, onChange: () => void) {
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const g = canvas.getContext("2d")!;
  let img: HTMLImageElement | null = null;
  const family = () => getComputedStyle(document.body).fontFamily || "system-ui, sans-serif";
  const mono = 'ui-monospace, "JetBrains Mono", Menlo, Consolas, monospace';

  function draw() {
    const fam = family();
    g.clearRect(0, 0, W, H);
    roundRect(g, 4, 4, W - 8, H - 8, 44);
    g.fillStyle = "#FFFDF9";
    g.fill();
    g.lineWidth = 4;
    g.strokeStyle = "#E8E2D9";
    g.stroke();

    const side = { x: 600, y: 52, w: 372, h: 436 };
    const leftW = 500;
    g.textBaseline = "alphabetic";
    g.fillStyle = "#C8592E";
    g.font = `700 25px ${mono}`;
    g.fillText(p.eyebrow.toUpperCase(), 56, 96);

    g.fillStyle = "#151B22";
    g.font = `800 60px ${fam}`;
    const titleLines = wrap(g, p.title, leftW, 3);
    titleLines.forEach((l, i) => g.fillText(l, 56, 178 + i * 66));

    // key numbers as chips
    g.font = `700 25px ${fam}`;
    let cx = 56, cy = 178 + titleLines.length * 66 + 24;
    for (const s of p.stats.slice(0, 4)) {
      const text = s.length > 26 ? `${s.slice(0, 25)}…` : s;
      const w = g.measureText(text).width + 40;
      if (cx + w > 56 + leftW) { cx = 56; cy += 58; }
      roundRect(g, cx, cy, w, 46, 23);
      g.fillStyle = "#F3ECE3";
      g.fill();
      g.fillStyle = "#4A525C";
      g.fillText(text, cx + 20, cy + 32);
      cx += w + 12;
    }

    // thumbnail: the image, or a text / code preview
    g.save();
    roundRect(g, side.x, side.y, side.w, side.h, 28);
    g.clip();
    if (img) {
      const s = Math.max(side.w / img.naturalWidth, side.h / img.naturalHeight);
      const iw = img.naturalWidth * s, ih = img.naturalHeight * s;
      g.fillStyle = "#F7F3EC";
      g.fillRect(side.x, side.y, side.w, side.h);
      g.drawImage(img, side.x + (side.w - iw) / 2, side.y + (side.h - ih) / 2, iw, ih);
    } else if (p.lines?.length) {
      g.fillStyle = p.code ? "#151B22" : "#F7F3EC";
      g.fillRect(side.x, side.y, side.w, side.h);
      if (p.code) {
        g.font = `500 19px ${mono}`;
        p.lines.slice(0, 13).forEach((l, i) => {
          const t = l.replace(/\t/g, "  ");
          g.fillStyle = /^\s*(\/\/|\/\*|\*)/.test(t) ? "#6A9955" : /^\s*#/.test(t) ? "#C586C0" : /\b(void|int|const|float|bool|if|else|for|while|return)\b/.test(t) ? "#79B8FF" : "#D4D4D4";
          g.fillText(t.length > 30 ? `${t.slice(0, 29)}…` : t, side.x + 22, side.y + 44 + i * 30);
        });
      } else {
        g.font = `600 23px ${fam}`;
        let y = side.y + 52;
        for (const l of p.lines.slice(0, 6)) {
          const ls = wrap(g, l, side.w - 70, 2);
          g.fillStyle = "#C8592E";
          g.beginPath();
          g.arc(side.x + 30, y - 8, 5, 0, Math.PI * 2);
          g.fill();
          g.fillStyle = "#2A3038";
          ls.forEach((t, i) => g.fillText(t, side.x + 48, y + i * 30));
          y += ls.length * 30 + 22;
          if (y > side.y + side.h - 20) break;
        }
      }
    } else {
      g.fillStyle = "#F7F3EC";
      g.fillRect(side.x, side.y, side.w, side.h);
    }
    g.restore();

    // the call to action
    g.font = `800 27px ${fam}`;
    const cta = "Open  ↗";
    const cw = g.measureText(cta).width + 56;
    roundRect(g, 56, H - 124, cw, 64, 32);
    g.fillStyle = "#C8592E";
    g.fill();
    g.fillStyle = "#FFFFFF";
    g.fillText(cta, 84, H - 81);
    onChange();
  }

  draw();
  document.fonts?.ready.then(draw).catch(() => {});
  if (p.thumb) {
    const im = new Image();
    im.decoding = "async";
    im.onload = () => { img = im; draw(); };
    im.onerror = () => { /* keep the text preview */ };
    im.src = p.thumb;
  }
  return { canvas };
}
