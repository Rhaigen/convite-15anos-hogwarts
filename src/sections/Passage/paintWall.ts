import { createRandom, type BrickCell, type WallLayout } from '../../lib/brickWall';

/**
 * Pinta a parede de tijolos (uma única vez por tamanho de tela).
 *
 * Gera uma textura completa — argamassa, tijolos com lascas, manchas, poros,
 * fuligem e a luz de um lampião — e a distribui em dois destinos:
 * o canvas estático (com o vão do arco recortado) e um canvas por tijolo móvel.
 */

type Ctx = CanvasRenderingContext2D;

/** Tons de tijolo envelhecido: [matiz, saturação, luminosidade] em HSL. */
const BRICK_TONES: ReadonlyArray<readonly [number, number, number]> = [
  [11, 46, 31],
  [8, 42, 27],
  [15, 40, 35],
  [19, 34, 30],
  [6, 36, 23],
  [13, 30, 26],
  [22, 30, 37],
];

function noiseTile(size: number, seed: number): HTMLCanvasElement {
  const tile = document.createElement('canvas');
  tile.width = tile.height = size;
  const ctx = tile.getContext('2d')!;
  const img = ctx.createImageData(size, size);
  const rand = createRandom(seed);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = Math.round(rand() * 255);
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
    img.data[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return tile;
}

/** Contorno levemente irregular, com cantos gastos e lascas ocasionais. */
function brickPath(ctx: Ctx, x: number, y: number, w: number, h: number, rand: () => number) {
  const chip = Math.min(2.4, h * 0.16);
  const corner = Math.min(1.6, h * 0.1);
  const pts: Array<[number, number]> = [];
  const edge = (ax: number, ay: number, bx: number, by: number, nx: number, ny: number) => {
    const len = Math.hypot(bx - ax, by - ay);
    const steps = Math.max(3, Math.round(len / 5));
    for (let i = 0; i < steps; i++) {
      const t = i / steps;
      const inset = rand() < 0.1 ? rand() * chip : rand() * 0.45;
      pts.push([ax + (bx - ax) * t + nx * inset, ay + (by - ay) * t + ny * inset]);
    }
  };
  edge(x + corner, y, x + w - corner, y, 0, 1);
  edge(x + w, y + corner, x + w, y + h - corner, -1, 0);
  edge(x + w - corner, y + h, x + corner, y + h, 0, -1);
  edge(x, y + h - corner, x, y + corner, 1, 0);
  ctx.beginPath();
  pts.forEach(([px, py], i) => (i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py)));
  ctx.closePath();
}

function paintBrick(ctx: Ctx, cell: BrickCell, layout: WallLayout, noise: CanvasPattern, dpr: number) {
  const rand = createRandom(cell.seed);
  const m = layout.mortar / 2;
  const x = cell.x + m;
  const y = cell.y + m;
  const w = cell.w - layout.mortar;
  const h = cell.h - layout.mortar;
  if (w <= 2 || h <= 2) return;

  let [hue, sat, light] = BRICK_TONES[Math.floor(rand() * BRICK_TONES.length)]!;
  const special = rand();
  if (special < 0.06) [hue, sat, light] = [10, 18, 15]; // tijolo requeimado
  else if (special < 0.09) [hue, sat, light] = [30, 30, 42]; // tijolo claro, de outra fornada
  light += (rand() - 0.5) * 7;
  hue += (rand() - 0.5) * 4;

  ctx.save();
  // Sombra do tijolo sobre a junta (luz vinda do alto, à esquerda).
  ctx.shadowColor = 'rgba(0,0,0,0.6)';
  ctx.shadowBlur = 2 * dpr;
  ctx.shadowOffsetX = 0.8 * dpr;
  ctx.shadowOffsetY = 1.4 * dpr;
  brickPath(ctx, x, y, w, h, rand);
  ctx.fillStyle = `hsl(${hue} ${sat}% ${light}%)`;
  ctx.fill();
  ctx.restore();

  ctx.save();
  ctx.clip();

  // Manchas de queima e desgaste.
  const blotches = 3 + Math.floor(rand() * 4);
  for (let i = 0; i < blotches; i++) {
    const bx = x + rand() * w;
    const by = y + rand() * h;
    const r = h * (0.4 + rand() * 1.4);
    const g = ctx.createRadialGradient(bx, by, 0, bx, by, r);
    const dl = rand() < 0.55 ? -9 - rand() * 8 : 6 + rand() * 7;
    g.addColorStop(0, `hsl(${hue + (rand() - 0.5) * 8} ${sat}% ${light + dl}% / ${0.25 + rand() * 0.3})`);
    g.addColorStop(1, `hsl(${hue} ${sat}% ${light + dl}% / 0)`);
    ctx.fillStyle = g;
    ctx.fillRect(x, y, w, h);
  }

  // Granulação da argila.
  noise.setTransform(new DOMMatrix().translateSelf(rand() * 200, rand() * 200).scaleSelf(1 / dpr, 1 / dpr));
  ctx.globalCompositeOperation = 'overlay';
  ctx.globalAlpha = 0.16;
  ctx.fillStyle = noise;
  ctx.fillRect(x, y, w, h);
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;

  // Poros e pedrinhas.
  const pores = Math.round((w * h) / 110);
  for (let i = 0; i < pores; i++) {
    const dark = rand() < 0.78;
    ctx.fillStyle = dark ? `rgba(20,8,6,${0.25 + rand() * 0.35})` : `rgba(235,205,175,${0.12 + rand() * 0.18})`;
    ctx.beginPath();
    ctx.arc(x + rand() * w, y + rand() * h, 0.25 + rand() * 0.6, 0, Math.PI * 2);
    ctx.fill();
  }

  // Volume: face levemente abaulada, aresta superior iluminada e inferior em sombra.
  const shade = ctx.createLinearGradient(x, y, x, y + h);
  shade.addColorStop(0, 'rgba(255,226,196,0.13)');
  shade.addColorStop(0.22, 'rgba(255,226,196,0)');
  shade.addColorStop(0.72, 'rgba(0,0,0,0)');
  shade.addColorStop(1, 'rgba(0,0,0,0.32)');
  ctx.fillStyle = shade;
  ctx.fillRect(x, y, w, h);
  const side = ctx.createLinearGradient(x, y, x + w, y);
  side.addColorStop(0, 'rgba(255,226,196,0.07)');
  side.addColorStop(0.12, 'rgba(255,226,196,0)');
  side.addColorStop(0.9, 'rgba(0,0,0,0)');
  side.addColorStop(1, 'rgba(0,0,0,0.22)');
  ctx.fillStyle = side;
  ctx.fillRect(x, y, w, h);
  ctx.restore();

  ctx.strokeStyle = 'rgba(255,225,190,0.12)';
  ctx.lineWidth = 0.8;
  ctx.beginPath();
  ctx.moveTo(x + 1.5, y + 0.6);
  ctx.lineTo(x + w - 1.5, y + 0.6);
  ctx.stroke();
}

function paintGround(ctx: Ctx, layout: WallLayout, noise: CanvasPattern, rand: () => number) {
  const { width, height, groundY } = layout;
  ctx.fillStyle = '#16120f';
  ctx.fillRect(0, groundY, width, height - groundY);
  // Lajes de pedra que crescem em direção ao observador.
  let y = groundY;
  let rowH = Math.max(3, layout.courseH * 0.35);
  while (y < height) {
    let x = -rand() * 60;
    const slabW = rowH * 3.2;
    while (x < width) {
      const w = slabW * (0.7 + rand() * 0.7);
      const l = 10 + rand() * 9;
      ctx.fillStyle = `hsl(${25 + rand() * 15} 8% ${l}%)`;
      ctx.fillRect(x + 1, y + 1, w - 2, rowH - 2);
      ctx.fillStyle = 'rgba(255,230,200,0.05)';
      ctx.fillRect(x + 1, y + 1, w - 2, 1);
      x += w;
    }
    y += rowH;
    rowH *= 1.45;
  }
  ctx.save();
  ctx.globalCompositeOperation = 'overlay';
  ctx.globalAlpha = 0.25;
  ctx.fillStyle = noise;
  ctx.fillRect(0, groundY, width, height - groundY);
  ctx.restore();
  // Sombra de contato na base da parede.
  const contact = ctx.createLinearGradient(0, groundY - 2, 0, groundY + layout.courseH * 1.5);
  contact.addColorStop(0, 'rgba(0,0,0,0.75)');
  contact.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = contact;
  ctx.fillRect(0, groundY - 2, width, layout.courseH * 1.5 + 2);
}

/** Fuligem, escorrimentos, salitre e a luz noturna — aplicados sobre a parede inteira. */
function paintWeathering(ctx: Ctx, layout: WallLayout, rand: () => number) {
  const { width, height, groundY, arch } = layout;

  // Escorrimentos de chuva a partir do topo.
  for (let i = 0; i < Math.round(width / 70); i++) {
    const sx = rand() * width;
    const sw = 6 + rand() * 30;
    const len = groundY * (0.2 + rand() * 0.6);
    const g = ctx.createLinearGradient(0, 0, 0, len);
    g.addColorStop(0, `rgba(12,8,8,${0.12 + rand() * 0.18})`);
    g.addColorStop(1, 'rgba(12,8,8,0)');
    ctx.fillStyle = g;
    ctx.fillRect(sx, 0, sw, len);
  }

  // Umidade e fuligem subindo do chão.
  const damp = ctx.createLinearGradient(0, groundY - layout.courseH * 7, 0, groundY);
  damp.addColorStop(0, 'rgba(14,12,10,0)');
  damp.addColorStop(1, 'rgba(14,12,10,0.55)');
  ctx.fillStyle = damp;
  ctx.fillRect(0, groundY - layout.courseH * 7, width, layout.courseH * 7);

  // Manchas de salitre perto da base.
  for (let i = 0; i < Math.round(width / 160); i++) {
    const px = rand() * width;
    const py = groundY - layout.courseH * (1 + rand() * 4);
    const r = layout.courseH * (1.5 + rand() * 3);
    const g = ctx.createRadialGradient(px, py, 0, px, py, r);
    g.addColorStop(0, `rgba(205,200,185,${0.08 + rand() * 0.1})`);
    g.addColorStop(1, 'rgba(205,200,185,0)');
    ctx.fillStyle = g;
    ctx.fillRect(px - r, py - r, r * 2, r * 2);
  }

  // Luz: um lampião a gás à esquerda do arco, o resto mergulha na noite fria.
  ctx.save();
  ctx.globalCompositeOperation = 'multiply';
  const lampX = arch.cx - arch.halfWidth * 1.55;
  const lampY = arch.topY + (groundY - arch.topY) * 0.15;
  const reach = Math.max(width, height) * 0.95;
  const light = ctx.createRadialGradient(lampX, lampY, 0, lampX, lampY, reach);
  light.addColorStop(0, 'rgb(255,226,190)');
  light.addColorStop(0.25, 'rgb(205,170,140)');
  light.addColorStop(0.6, 'rgb(105,92,98)');
  light.addColorStop(1, 'rgb(38,36,52)');
  ctx.fillStyle = light;
  ctx.fillRect(0, 0, width, height);
  // Vinheta para o topo (a parede se perde na escuridão).
  const top = ctx.createLinearGradient(0, 0, 0, height * 0.45);
  top.addColorStop(0, 'rgb(60,56,70)');
  top.addColorStop(1, 'rgb(255,255,255)');
  ctx.fillStyle = top;
  ctx.fillRect(0, 0, width, height * 0.45);
  ctx.restore();

  // Brilho quente do lampião sobre os tijolos mais próximos.
  ctx.save();
  ctx.globalCompositeOperation = 'screen';
  const warm = ctx.createRadialGradient(lampX, lampY, 0, lampX, lampY, arch.halfWidth * 1.6);
  warm.addColorStop(0, 'rgba(255,170,90,0.28)');
  warm.addColorStop(1, 'rgba(255,170,90,0)');
  ctx.fillStyle = warm;
  ctx.fillRect(0, 0, width, height);
  ctx.restore();
}

/**
 * Pinta a parede inteira e devolve os destinos preenchidos.
 * `bricks` mapeia o índice da célula para o canvas do tijolo móvel.
 */
export function paintWall(layout: WallLayout, dpr: number, staticCanvas: HTMLCanvasElement, bricks: Map<number, HTMLCanvasElement>) {
  const { width, height } = layout;
  const texture = document.createElement('canvas');
  texture.width = Math.round(width * dpr);
  texture.height = Math.round(height * dpr);
  const ctx = texture.getContext('2d')!;
  ctx.scale(dpr, dpr);
  const rand = createRandom(1502);
  const noise = ctx.createPattern(noiseTile(192, 77), 'repeat')!;

  // Argamassa: cal envelhecida, granulada.
  ctx.fillStyle = '#5d564d';
  ctx.fillRect(0, 0, width, layout.groundY);
  noise.setTransform(new DOMMatrix().scaleSelf(1 / dpr, 1 / dpr));
  ctx.save();
  ctx.globalCompositeOperation = 'overlay';
  ctx.globalAlpha = 0.3;
  ctx.fillStyle = noise;
  ctx.fillRect(0, 0, width, layout.groundY);
  ctx.restore();

  for (const cell of layout.cells) paintBrick(ctx, cell, layout, noise, dpr);
  paintGround(ctx, layout, noise, rand);
  paintWeathering(ctx, layout, rand);

  // Canvas estático: a parede inteira, com o vão recortado.
  staticCanvas.width = texture.width;
  staticCanvas.height = texture.height;
  const sctx = staticCanvas.getContext('2d')!;
  sctx.drawImage(texture, 0, 0);
  for (const cell of layout.cells) {
    if (cell.inArch) sctx.clearRect(cell.x * dpr, cell.y * dpr, cell.w * dpr, cell.h * dpr);
  }

  // Um recorte da mesma textura para cada tijolo móvel: encaixe perfeito.
  for (const cell of layout.cells) {
    const canvas = bricks.get(cell.index);
    if (!canvas) continue;
    canvas.width = Math.max(1, Math.round(cell.w * dpr));
    canvas.height = Math.max(1, Math.round(cell.h * dpr));
    canvas.getContext('2d')!.drawImage(texture, cell.x * dpr, cell.y * dpr, cell.w * dpr, cell.h * dpr, 0, 0, canvas.width, canvas.height);
  }

  // Libera a memória da textura intermediária.
  texture.width = texture.height = 0;
}
