// Prepara as molduras da torre de retratos (Capítulo III) a partir das artes em molduras-originais/.
//
//   npm run frames
//
// As artes vêm com fundo e abertura em verde puro (chroma key). O script torna o verde
// transparente (com alfa suave e limpeza da franja esverdeada), recorta a margem vazia,
// detecta a abertura interna (onde entra a foto) e gera WebP com transparência em
// src/assets/molduras/ + src/sections/SofiaGallery/frames.ts com as medidas.
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const srcDir = path.resolve('molduras-originais');
const outDir = path.resolve('src/assets/molduras');
const metaFile = path.resolve('src/sections/SofiaGallery/frames.ts');
const FRAMES = [
  { name: 'vertical', widths: [420, 1280] },
  { name: 'horizontal', widths: [640, 1280] },
];
/** A foto entra um pouco por baixo da borda interna da moldura (% do lado). */
const WINDOW_OVERLAP = 0.8;

const findSource = (name) => {
  const file = fs.readdirSync(srcDir).find((f) => new RegExp(`^moldura-${name}\\.(png|jpe?g|webp)$`, 'i').test(f));
  if (!file) throw new Error(`Faltando molduras-originais/moldura-${name}.(png|jpg|webp)`);
  return path.join(srcDir, file);
};

/** Verde do chroma key → alfa 0; cores da moldura → alfa 1; transição suave entre os dois. */
function keyGreen(data, channels, n) {
  const rgba = Buffer.alloc(n * 4);
  for (let p = 0; p < n; p++) {
    const r = data[p * channels];
    let g = data[p * channels + 1];
    const b = data[p * channels + 2];
    const srcAlpha = channels === 4 ? data[p * channels + 3] : 255;
    const greenness = g - Math.max(r, b);
    let a = greenness <= 30 ? 1 : greenness >= 90 ? 0 : 1 - (greenness - 30) / 60;
    a *= srcAlpha / 255;
    // Franja: o verde que sobra no contorno vira o tom da moldura (dourado tem r ≥ g).
    if (greenness > 0) g = Math.max(r, b);
    rgba[p * 4] = r;
    rgba[p * 4 + 1] = g;
    rgba[p * 4 + 2] = b;
    rgba[p * 4 + 3] = Math.round(a * 255);
  }
  return rgba;
}

/** Caixa dos pixels opacos (para recortar a margem vazia). */
function opaqueBox(rgba, w, h) {
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (rgba[(y * w + x) * 4 + 3] > 24) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
  return { left: x0, top: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}

/** Abertura interna: região transparente que contém o centro da imagem. */
function windowBox(rgba, w, h) {
  const n = w * h;
  const seen = new Uint8Array(n);
  const queue = new Int32Array(n);
  const start = ((h / 2) | 0) * w + ((w / 2) | 0);
  if (rgba[start * 4 + 3] > 128) throw new Error('O centro da moldura não é transparente: abertura não encontrada.');
  let head = 0;
  let tail = 0;
  queue[tail++] = start;
  seen[start] = 1;
  let x0 = w;
  let y0 = h;
  let x1 = 0;
  let y1 = 0;
  while (head < tail) {
    const p = queue[head++];
    const x = p % w;
    const y = (p / w) | 0;
    if (x === 0 || y === 0 || x === w - 1 || y === h - 1) throw new Error('A abertura vaza para fora da moldura.');
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
    for (const q of [p - 1, p + 1, p - w, p + w]) {
      if (seen[q] || rgba[q * 4 + 3] > 128) continue;
      seen[q] = 1;
      queue[tail++] = q;
    }
  }
  return { x0, y0, x1: x1 + 1, y1: y1 + 1 };
}

const pct = (v) => Math.round((v * 100 - WINDOW_OVERLAP) * 100) / 100;

fs.mkdirSync(outDir, { recursive: true });
const meta = [];
for (const frame of FRAMES) {
  const src = findSource(frame.name);
  console.log(`• ${path.relative(process.cwd(), src)}`);
  const { data, info } = await sharp(src).raw().toBuffer({ resolveWithObject: true });
  const keyed = keyGreen(data, info.channels, info.width * info.height);
  const box = opaqueBox(keyed, info.width, info.height);
  const { data: cropped } = await sharp(keyed, { raw: { width: info.width, height: info.height, channels: 4 } })
    .extract(box)
    .raw()
    .toBuffer({ resolveWithObject: true });
  const win = windowBox(cropped, box.width, box.height);
  const insets = {
    top: pct(win.y0 / box.height),
    right: pct(1 - win.x1 / box.width),
    bottom: pct(1 - win.y1 / box.height),
    left: pct(win.x0 / box.width),
  };
  console.log(`    recorte ${box.width}×${box.height}; abertura (%) ${JSON.stringify(insets)}`);
  const files = [];
  for (const width of frame.widths) {
    const { data: webp, info: o } = await sharp(cropped, { raw: { width: box.width, height: box.height, channels: 4 } })
      .resize({ width, withoutEnlargement: true })
      .webp({ quality: 86, alphaQuality: 90, effort: 6 })
      .toBuffer({ resolveWithObject: true });
    // Nome pela largura real (a arte pode ser menor que a largura pedida).
    const out = path.join(outDir, `moldura-${frame.name}-${o.width}.webp`);
    fs.writeFileSync(out, webp);
    files.push({ out, width: o.width });
    console.log(`    ${path.relative(process.cwd(), out)} (${Math.round(fs.statSync(out).size / 1024)} KB)`);
  }
  meta.push({ ...frame, box, insets, files });
}

const ident = (name, width) => `${name}${width}`;
const lines = [
  '// Gerado por `npm run frames` (scripts/prepare-frames.mjs). Não editar à mão.',
  ...meta.flatMap((f) => f.files.map((file) => `import ${ident(f.name, file.width)} from '../../assets/molduras/${path.basename(file.out)}';`)),
  '',
  'export interface FrameArt {',
  '  /** `srcset` da moldura (WebP com transparência). */',
  '  srcSet: string;',
  '  src: string;',
  '  /** Largura ÷ altura da moldura inteira. */',
  '  ratio: number;',
  '  /** Abertura onde entra a foto, em % de cada lado. */',
  '  window: { top: number; right: number; bottom: number; left: number };',
  '}',
  '',
  'export const frameArt: Record<"v" | "h", FrameArt> = {',
  ...meta.map((f) => {
    const key = f.name === 'vertical' ? 'v' : 'h';
    const srcSet = f.files.map((file) => `\${${ident(f.name, file.width)}} ${file.width}w`).join(', ');
    const largest = ident(f.name, f.files[f.files.length - 1].width);
    return `  ${key}: {\n    srcSet: \`${srcSet}\`,\n    src: ${largest},\n    ratio: ${Math.round((f.box.width / f.box.height) * 10000) / 10000},\n    window: ${JSON.stringify(f.insets).replace(/"/g, '').replace(/:/g, ': ').replace(/,/g, ', ').replace('{', '{ ').replace('}', ' }')},\n  },`;
  }),
  '};',
  '',
];
fs.writeFileSync(metaFile, lines.join('\n').replace('Record<"v" | "h"', "Record<'v' | 'h'"));
console.log(`✓ ${path.relative(process.cwd(), metaFile)}`);
