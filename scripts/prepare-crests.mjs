// Prepara os brasões (Hogwarts e Grifinória) a partir das artes em brasoes-originais/.
//
//   npm run crests
//
// As artes vieram em JPG com o "xadrez de transparência" desenhado na própria imagem.
// O script remove esse fundo (cinza/branco sem saturação) por preenchimento a partir
// das bordas, mais as ilhas de xadrez fechadas, suaviza o contorno, recorta e gera
// WebP com transparência em src/assets/brasoes/.
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const srcDir = path.resolve('brasoes-originais');
const outDir = path.resolve('src/assets/brasoes');
const CRESTS = [
  // islandMin: tamanho mínimo de uma ilha fechada de xadrez para ser removida. O de Hogwarts
  // exige os dois tons do xadrez (o elmo e o texugo têm cinza/branco de verdade).
  { file: 'hogwarts.jpg', name: 'hogwarts', widths: [300], islandMin: 600, twoTones: true },
  { file: 'grifinoria.jpg', name: 'grifinoria', widths: [220, 520], islandMin: 25, twoTones: false },
  // Brasão da Sofia (encerramento): prateado, então também exige os dois tons do xadrez.
  { file: 'sofia.jpg', name: 'sofia', widths: [280, 512], islandMin: 600, twoTones: true, speckleMax: 1500 },
];

/** Pixel com cara de xadrez: claro e sem cor. */
const isChecker = (r, g, b) => Math.max(r, g, b) - Math.min(r, g, b) <= 14 && Math.min(r, g, b) >= 196;
/** Franja de borda: claro e quase neutro (mistura do contorno com o xadrez). */
const isFringe = (r, g, b) => Math.max(r, g, b) - Math.min(r, g, b) <= 34 && Math.min(r, g, b) >= 165;

function removeChecker(data, w, h, { islandMin, twoTones, speckleMax = 0 }) {
  const n = w * h;
  const like = new Uint8Array(n);
  for (let i = 0; i < n; i++) like[i] = isChecker(data[i * 3], data[i * 3 + 1], data[i * 3 + 2]) ? 1 : 0;

  // Componentes conexos dos pixels "xadrez".
  const comp = new Int32Array(n).fill(-1);
  const queue = new Int32Array(n);
  const bg = new Uint8Array(n);
  let id = 0;
  for (let s = 0; s < n; s++) {
    if (!like[s] || comp[s] !== -1) continue;
    let head = 0;
    let tail = 0;
    queue[tail++] = s;
    comp[s] = id;
    let touchesBorder = false;
    let gray = 0;
    let white = 0;
    while (head < tail) {
      const p = queue[head++];
      const x = p % w;
      const y = (p / w) | 0;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) touchesBorder = true;
      const lum = data[p * 3 + 1];
      if (lum <= 232) gray++;
      else if (lum >= 246) white++;
      for (const q of [p - 1, p + 1, p - w, p + w]) {
        if (q < 0 || q >= n || comp[q] !== -1 || !like[q]) continue;
        if ((q === p - 1 && x === 0) || (q === p + 1 && x === w - 1)) continue;
        comp[q] = id;
        queue[tail++] = q;
      }
    }
    // Fundo = toca a borda, ou ilha grande com os dois tons do xadrez.
    const size = tail;
    const island = size >= islandMin && (!twoTones || (gray / size >= 0.2 && white / size >= 0.2));
    if (touchesBorder || island) {
      for (let k = 0; k < tail; k++) bg[queue[k]] = 1;
      if (!touchesBorder) console.log(`    ilha de xadrez removida (${size} px)`);
    }
    id++;
  }

  // Remove a franja clara colada ao fundo (2 passadas).
  for (let pass = 0; pass < 2; pass++) {
    const grow = [];
    for (let p = 0; p < n; p++) {
      if (bg[p] || !isFringe(data[p * 3], data[p * 3 + 1], data[p * 3 + 2])) continue;
      const x = p % w;
      if ((x > 0 && bg[p - 1]) || (x < w - 1 && bg[p + 1]) || bg[p - w] || bg[p + w]) grow.push(p);
    }
    for (const p of grow) bg[p] = 1;
  }

  // Resíduos do xadrez (pontos de compressão nas junções dos quadrados): ilhas opacas
  // pequenas, soltas no fundo, viram transparentes. A arte em si é uma peça grande.
  if (speckleMax > 0) {
    const seen = new Uint8Array(n);
    for (let s = 0; s < n; s++) {
      if (bg[s] || seen[s]) continue;
      let head = 0;
      let tail = 0;
      queue[tail++] = s;
      seen[s] = 1;
      while (head < tail) {
        const p = queue[head++];
        const x = p % w;
        for (const q of [p - 1, p + 1, p - w, p + w]) {
          if (q < 0 || q >= n || seen[q] || bg[q]) continue;
          if ((q === p - 1 && x === 0) || (q === p + 1 && x === w - 1)) continue;
          seen[q] = 1;
          queue[tail++] = q;
        }
      }
      if (tail < speckleMax) for (let k = 0; k < tail; k++) bg[queue[k]] = 1;
    }
  }

  // Alfa com borda suavizada (média 3×3, só reduz).
  const rgba = Buffer.alloc(n * 4);
  for (let p = 0; p < n; p++) {
    const x = p % w;
    const y = (p / w) | 0;
    let a = 0;
    if (!bg[p]) {
      let sum = 0;
      let cnt = 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          cnt++;
          sum += bg[yy * w + xx] ? 0 : 1;
        }
      a = Math.round((sum / cnt) * 255);
    }
    rgba[p * 4] = data[p * 3];
    rgba[p * 4 + 1] = data[p * 3 + 1];
    rgba[p * 4 + 2] = data[p * 3 + 2];
    rgba[p * 4 + 3] = a;
  }
  return rgba;
}

fs.mkdirSync(outDir, { recursive: true });
for (const crest of CRESTS) {
  const src = path.join(srcDir, crest.file);
  console.log(`• ${crest.file}`);
  const { data, info } = await sharp(src).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const rgba = removeChecker(data, info.width, info.height, crest);
  const trimmed = await sharp(rgba, { raw: { width: info.width, height: info.height, channels: 4 } })
    .trim({ background: { r: 0, g: 0, b: 0, alpha: 0 }, threshold: 1 })
    .png()
    .toBuffer({ resolveWithObject: true });
  console.log(`    recorte: ${trimmed.info.width}×${trimmed.info.height}`);
  for (const width of crest.widths) {
    const out = path.join(outDir, `${crest.name}-${width}.webp`);
    await sharp(trimmed.data)
      .resize({ width, withoutEnlargement: true })
      .webp({ quality: 86, alphaQuality: 100, effort: 6 })
      .toFile(out);
    console.log(`    ${path.relative(process.cwd(), out)} (${Math.round(fs.statSync(out).size / 1024)} KB)`);
  }
}
