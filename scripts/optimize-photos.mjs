// Otimiza as fotografias reais da galeria.
//
//   1. Coloque os originais (JPG, PNG, WebP ou TIFF) em fotos-originais/
//      (ex.: fotografia1.jpg, fotografia2.webp…; a lista sai em ordem numérica: 2 antes de 10).
//   2. Rode: npm run photos
//      Só algumas fotos: node scripts/optimize-photos.mjs <pasta com as fotos> public/fotos
//   3. Cole a lista impressa no final em src/content/gallery.ts e revise os textos alternativos.
//      A ordem da lista em gallery.ts é a ordem na galeria.
//
// Gera em public/fotos/: AVIF e WebP em 640/1280/1920 px de largura + um JPG de fallback,
// já com a orientação EXIF corrigida e sem metadados (localização GPS etc.).
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const srcDir = path.resolve(process.argv[2] ?? 'fotos-originais');
const outDir = path.resolve(process.argv[3] ?? 'public/fotos');
const WIDTHS = [640, 1280, 1920];

if (!fs.existsSync(srcDir)) {
  console.error(`Pasta não encontrada: ${srcDir}`);
  process.exit(1);
}
fs.mkdirSync(outDir, { recursive: true });

const files = fs
  .readdirSync(srcDir)
  .filter((f) => /\.(jpe?g|png|webp|tiff?)$/i.test(f))
  .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

if (files.length === 0) {
  console.log(`Nenhuma imagem em ${srcDir}.`);
  process.exit(0);
}

const slugify = (name) =>
  name
    .replace(/\.[^.]+$/, '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

const entries = [];
for (const file of files) {
  const slug = slugify(file);
  const input = sharp(path.join(srcDir, file)).rotate(); // aplica EXIF e descarta metadados
  const { width: origW, height: origH } = await input.clone().toBuffer({ resolveWithObject: true }).then((r) => r.info);
  const widths = WIDTHS.filter((w) => w <= origW);
  // Fotos menores que 1920 px também ganham uma variação na largura original.
  if (origW < WIDTHS.at(-1) && !widths.includes(origW)) widths.push(origW);

  const avif = [];
  const webp = [];
  for (const w of widths) {
    const resized = input.clone().resize({ width: w, withoutEnlargement: true });
    await resized.clone().avif({ quality: 55, effort: 5 }).toFile(path.join(outDir, `${slug}-${w}.avif`));
    await resized.clone().webp({ quality: 78 }).toFile(path.join(outDir, `${slug}-${w}.webp`));
    avif.push(`/fotos/${slug}-${w}.avif ${w}w`);
    webp.push(`/fotos/${slug}-${w}.webp ${w}w`);
  }
  const fallbackW = Math.min(1280, origW);
  await input.clone().resize({ width: fallbackW }).jpeg({ quality: 80, mozjpeg: true }).toFile(path.join(outDir, `${slug}.jpg`));

  entries.push({ slug, width: origW, height: origH, avif, webp });
  console.log(`✓ ${file} → ${slug} (${origW}×${origH})`);
}

console.log('\n// ---- Cole em src/content/gallery.ts (galleryPhotos) e revise os textos "alt" ----');
console.log('export const galleryPhotos: GalleryPhoto[] = [');
for (const e of entries) {
  console.log(`  {
    id: '${e.slug}',
    src: '/fotos/${e.slug}.jpg',
    sources: [
      { type: 'image/avif', srcSet: '${e.avif.join(', ')}' },
      { type: 'image/webp', srcSet: '${e.webp.join(', ')}' },
    ],
    width: ${e.width},
    height: ${e.height},
    alt: 'DESCREVA A FOTO AQUI',
    position: '50% 40%',
    caption: null,
  },`);
}
console.log('];');
