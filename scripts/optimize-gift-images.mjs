// Fotos dos presentes da lista (pergaminho do Capítulo VIII).
//
//   1. Coloque as fotos em presentes-originais/ e escreva o nome do arquivo no campo `image`
//      do presente em src/content/gifts.ts.
//   2. Rode: npm run gifts:images
//
// Gera src/assets/presentes/<id>.webp: quadrado de 480 px, produto inteiro centralizado sobre
// fundo branco (as fotos de loja vêm com fundo branco ou transparente), sem metadados.
// E public/presentes/<id>.png (240 px): a foto do item no checkout do Asaas, que a função
// gift-checkout busca no próprio convite (SITE_URL). O Asaas aceita PNG; JPEG do sharp, não.
// Originais e geradas ficam fora do git (fotos de lojas têm dono); o site importa as geradas
// por import.meta.glob e, sem elas, mostra o ícone do presente (e o checkout, o brasão).
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { runnerImport } from 'vite';

const { giftList } = (await runnerImport('./src/content/gifts.ts', { configFile: false, logLevel: 'error' })).module;

const SRC = path.resolve('presentes-originais');
const OUT = path.resolve('src/assets/presentes');
const CHECKOUT_OUT = path.resolve('public/presentes');
const SIZE = 480;
const CHECKOUT_SIZE = 240;
const PADDING = 0.08;

/** Média dos cantos (tom do fundo), em cinza 0–255. */
async function cornerGray(buffer) {
  const { data, info } = await sharp(buffer).greyscale().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info;
  const at = (x, y) => data[y * w + x];
  return Math.round((at(1, 1) + at(w - 2, 1) + at(1, h - 2) + at(w - 2, h - 2)) / 4);
}

fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(CHECKOUT_OUT, { recursive: true });
const wanted = new Set();
let missing = 0;

for (const gift of giftList) {
  if (!gift.image) continue;
  const file = path.join(SRC, gift.image);
  const out = path.join(OUT, `${gift.id}.webp`);
  const checkoutOut = path.join(CHECKOUT_OUT, `${gift.id}.png`);
  wanted.add(path.basename(out)).add(path.basename(checkoutOut));
  if (!fs.existsSync(file)) {
    console.warn(`✗ ${gift.id}: não achei presentes-originais/${gift.image}`);
    missing++;
    continue;
  }
  const inner = Math.round(SIZE * (1 - 2 * PADDING));
  // Fundo de loja cinza-claro (ex.: 239): clareia a foto para esse tom virar o branco do quadro.
  const flat = await sharp(file).rotate().flatten({ background: '#ffffff' }).toBuffer();
  const corner = await cornerGray(flat);
  const gain = corner >= 220 && corner < 255 ? 255 / corner : 1;
  const product = await sharp(flat)
    .linear(gain, 0)
    .trim({ background: '#ffffff', threshold: 12 })
    .resize(inner, inner, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 0 } })
    // PNG sempre: um JPEG com extensão .png manteria o formato e a margem transparente viraria preto.
    .png()
    .toBuffer();
  const square = await sharp({ create: { width: SIZE, height: SIZE, channels: 3, background: '#ffffff' } })
    .composite([{ input: product, gravity: 'center' }])
    .png()
    .toBuffer();
  await sharp(square).webp({ quality: 82 }).toFile(out);
  await sharp(square).resize(CHECKOUT_SIZE, CHECKOUT_SIZE).png({ palette: true, quality: 90, compressionLevel: 9 }).toFile(checkoutOut);
  const kb = (file) => Math.round(fs.statSync(file).size / 1024);
  console.log(`✓ ${gift.id}.webp (${kb(out)} KB) + .png do checkout (${kb(checkoutOut)} KB) ← ${gift.image}`);
}

// Fotos de presentes que saíram da lista não vão para o build.
for (const [dir, ext] of [[OUT, '.webp'], [CHECKOUT_OUT, '.png']]) {
  for (const old of fs.readdirSync(dir)) {
    if (old.endsWith(ext) && !wanted.has(old)) {
      fs.rmSync(path.join(dir, old));
      console.log(`– removida ${old} (presente fora da lista)`);
    }
  }
}
if (missing) process.exitCode = 1;
