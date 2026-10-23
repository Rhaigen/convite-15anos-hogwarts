// Gera as imagens de ESPAÇO RESERVADO da galeria (public/fotos/espaco-reservado-N.svg).
// São provisórias e claramente identificadas; substitua pelas fotos reais (veja src/content/gallery.ts).
import fs from 'node:fs';
import path from 'node:path';

const outDir = path.resolve('public/fotos');
fs.mkdirSync(outDir, { recursive: true });

const specs = [
  { n: 1, w: 1920, h: 1080, hue: ['#3b0915', '#1a0a10', '#c58a3c'] },
  { n: 2, w: 1200, h: 1500, hue: ['#2b0d18', '#120a10', '#d8b15a'] },
  { n: 3, w: 1200, h: 1600, hue: ['#40121a', '#160a0e', '#e8a046'] },
  { n: 4, w: 1200, h: 1600, hue: ['#22101c', '#0e080c', '#d8b15a'] },
  { n: 5, w: 1200, h: 1500, hue: ['#4a0d1b', '#1a0709', '#f6d98a'] },
  { n: 6, w: 2400, h: 1000, hue: ['#300b14', '#0d070a', '#e8a046'] },
];

for (const { n, w, h, hue } of specs) {
  const [a, b, light] = hue;
  const s = Math.min(w, h);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <defs>
    <radialGradient id="bg" cx="${n % 2 ? 35 : 65}%" cy="35%" r="85%">
      <stop offset="0" stop-color="${a}"/>
      <stop offset="1" stop-color="${b}"/>
    </radialGradient>
    <radialGradient id="light" cx="${n % 2 ? 30 : 70}%" cy="28%" r="45%">
      <stop offset="0" stop-color="${light}" stop-opacity=".38"/>
      <stop offset="1" stop-color="${light}" stop-opacity="0"/>
    </radialGradient>
    <filter id="grain"><feTurbulence type="fractalNoise" baseFrequency=".9" numOctaves="2" stitchTiles="stitch"/><feColorMatrix values="0 0 0 0 1 0 0 0 0 .9 0 0 0 0 .7 0 0 0 .06 0"/></filter>
  </defs>
  <rect width="100%" height="100%" fill="url(#bg)"/>
  <rect width="100%" height="100%" fill="url(#light)"/>
  <rect width="100%" height="100%" filter="url(#grain)"/>
  <rect x="${s * 0.04}" y="${s * 0.04}" width="${w - s * 0.08}" height="${h - s * 0.08}" fill="none" stroke="#d8b15a" stroke-opacity=".35" stroke-width="${Math.max(2, s * 0.003)}"/>
  <g transform="translate(${w / 2} ${h / 2})" fill="none" stroke="#f6d98a" stroke-opacity=".7" stroke-width="${s * 0.004}">
    <rect x="${-s * 0.06}" y="${-s * 0.075}" width="${s * 0.12}" height="${s * 0.085}" rx="${s * 0.012}"/>
    <circle cy="${-s * 0.032}" r="${s * 0.024}"/>
    <path d="M${-s * 0.025} ${-s * 0.075} l${s * 0.01} ${-s * 0.016} h${s * 0.03} l${s * 0.01} ${s * 0.016}"/>
  </g>
  <text x="50%" y="${h / 2 + s * 0.07}" text-anchor="middle" font-family="Georgia, 'Times New Roman', serif" font-size="${s * 0.045}" letter-spacing="${s * 0.012}" fill="#f6d98a" fill-opacity=".85">FOTOGRAFIA ${n}</text>
  <text x="50%" y="${h / 2 + s * 0.115}" text-anchor="middle" font-family="Georgia, 'Times New Roman', serif" font-style="italic" font-size="${s * 0.028}" fill="#f8f0e2" fill-opacity=".6">Espaço reservado — substitua pela foto real</text>
</svg>
`;
  fs.writeFileSync(path.join(outDir, `espaco-reservado-${n}.svg`), svg);
  console.log(`✓ espaco-reservado-${n}.svg (${w}×${h})`);
}
