import { createRandom, type WallLayout } from '../../lib/brickWall';

/**
 * Pinta o Beco Diagonal visto através do arco: rua de pedras em perspectiva,
 * fachadas tortas com vitrines acesas, letreiros, lampiões, bandeirolas
 * vermelhas e douradas e o banco Gringotes ao fundo.
 *
 * Coordenadas do "mundo" em px medidos no plano da parede (Z = 1);
 * Z cresce para dentro do beco. O ponto de fuga coincide com o eixo do arco.
 */

type Pt = [number, number];

const Z_NEAR = 0.6;
const Z_END = 9;
const SIGN_NAMES = ['Olivaras', 'Floreios e Borrões', 'Empório de Corujas', 'Madame Malkin', 'Caldeirões', 'Gemialidades', 'Boticário'];
const FACADE_TONES = ['#3a2a20', '#4a3a2c', '#5a2a24', '#26352d', '#262b40', '#3b2541', '#6a5233', '#5b4f42', '#2f2524'];
const SERIF = "'Cinzel Variable', Cinzel, Georgia, serif";

interface Building {
  side: -1 | 1;
  z0: number;
  z1: number;
  top0: number;
  top1: number;
  lean: number;
  tone: string;
  seed: number;
  sign: string | null;
}

interface Prop {
  z: number;
  draw: () => void;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

export function paintAlley(canvas: HTMLCanvasElement, layout: WallLayout, dpr: number) {
  const { width: W, height: H, arch, vanishY } = layout;
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  const ctx = canvas.getContext('2d')!;
  ctx.scale(dpr, dpr);

  const cx = arch.cx;
  const u = arch.bottomY - arch.topY; // altura do arco = "um andar"
  const Y0 = -(layout.groundY - vanishY); // altura do chão
  const S = arch.halfWidth * 1.3; // meia largura da rua
  const rand = createRandom(9);

  const P = (X: number, Y: number, Z: number): Pt => [cx + X / Z, vanishY - Y / Z];
  const facadeX = (b: Pick<Building, 'side' | 'lean'>, Y: number) => b.side * (S - b.lean * (Y - Y0));
  const fp = (b: Building, z: number, Y: number) => P(facadeX(b, Y), Y, z);
  const poly = (pts: Pt[]) => {
    ctx.beginPath();
    pts.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
    ctx.closePath();
  };
  const facadeQuad = (b: Building, za: number, ya: number, zb: number, yb: number) =>
    poly([fp(b, za, ya), fp(b, zb, ya), fp(b, zb, yb), fp(b, za, yb)]);
  const haze = (z: number) => clamp01((z - 1) / (Z_END - 1)) * 0.6;

  // ---------------------------------------------------------------- céu
  const sky = ctx.createLinearGradient(0, 0, 0, vanishY);
  sky.addColorStop(0, '#05060d');
  sky.addColorStop(0.7, '#1a1222');
  sky.addColorStop(1, '#3d2329');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, W, H);
  for (let i = 0; i < 90; i++) {
    ctx.fillStyle = `rgba(255,244,220,${0.25 + rand() * 0.6})`;
    ctx.fillRect(rand() * W, rand() * vanishY * 0.8, rand() < 0.15 ? 1.6 : 1, rand() < 0.15 ? 1.6 : 1);
  }

  // ---------------------------------------------------------------- Gringotes
  {
    const z = Z_END;
    const top = Y0 + u * 4.2;
    const [lx, by] = P(-S, Y0, z);
    const [rx, ty] = P(S, top, z);
    const fw = rx - lx;
    const fh = by - ty;
    const marble = ctx.createLinearGradient(0, ty, 0, by);
    marble.addColorStop(0, '#8f8577');
    marble.addColorStop(0.6, '#d9cdb6');
    marble.addColorStop(1, '#f1dfba');
    ctx.fillStyle = marble;
    ctx.fillRect(lx, ty, fw, fh);
    // Frontão
    ctx.fillStyle = '#b3a690';
    poly([[lx - fw * 0.04, ty], [rx + fw * 0.04, ty], [cx, ty - fh * 0.16]]);
    ctx.fill();
    ctx.fillStyle = '#a0937d';
    ctx.fillRect(lx - fw * 0.03, ty, fw * 1.06, fh * 0.1);
    // Colunas
    const cols = 8;
    for (let i = 0; i < cols; i++) {
      const x = lx + (fw * (i + 0.5)) / cols - fw * 0.025;
      const col = ctx.createLinearGradient(x, 0, x + fw * 0.05, 0);
      col.addColorStop(0, '#fff3da');
      col.addColorStop(1, '#a89b84');
      ctx.fillStyle = col;
      ctx.fillRect(x, ty + fh * 0.1, fw * 0.05, fh * 0.78);
    }
    // Portas de bronze iluminadas
    const dw = fw * 0.2;
    const dh = fh * 0.3;
    const glow = ctx.createRadialGradient(cx, by - dh * 0.5, 0, cx, by - dh * 0.5, dw * 1.6);
    glow.addColorStop(0, 'rgba(255,200,120,0.75)');
    glow.addColorStop(1, 'rgba(255,200,120,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(cx - dw * 2, by - dh * 2, dw * 4, dh * 2.5);
    ctx.fillStyle = '#7a4a1f';
    ctx.fillRect(cx - dw / 2, by - fh * 0.05 - dh, dw, dh);
    ctx.fillStyle = 'rgba(255,214,140,0.85)';
    ctx.fillRect(cx - dw * 0.04, by - fh * 0.05 - dh, dw * 0.08, dh);
    // Escadaria
    for (let i = 0; i < 4; i++) {
      ctx.fillStyle = i % 2 ? '#cbbd9f' : '#e7d6b1';
      ctx.fillRect(lx + fw * 0.05 * i, by - fh * 0.05 + (fh * 0.05 * i) / 4, fw - fw * 0.1 * i, fh * 0.0125);
    }
    const name = fh * 0.05;
    if (name >= 5) {
      ctx.fillStyle = '#4b3b28';
      ctx.font = `600 ${name}px ${SERIF}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('GRINGOTES', cx, ty + fh * 0.05, fw * 0.8);
    }
    ctx.fillStyle = 'rgba(70,40,40,0.35)';
    ctx.fillRect(lx - fw * 0.05, ty - fh * 0.2, fw * 1.1, fh * 1.2);
  }

  // ---------------------------------------------------------------- fachadas
  const buildings: Building[] = [];
  let signIndex = 0;
  for (const side of [-1, 1] as const) {
    let z = Z_NEAR;
    while (z < Z_END) {
      const len = 0.75 + rand() * 1.1;
      const base = u * (2.6 + rand() * 1.4);
      const hasSign = rand() < 0.6 && z > 1.4 && signIndex < SIGN_NAMES.length;
      buildings.push({
        side,
        z0: z,
        z1: Math.min(Z_END, z + len),
        top0: Y0 + base + (rand() - 0.5) * u * 0.5,
        top1: Y0 + base + (rand() - 0.5) * u * 0.5,
        lean: 0.03 + rand() * 0.09,
        tone: FACADE_TONES[Math.floor(rand() * FACADE_TONES.length)]!,
        seed: Math.floor(rand() * 2 ** 31),
        sign: hasSign ? SIGN_NAMES[signIndex++]! : null,
      });
      z += len;
    }
  }
  buildings.sort((a, b) => b.z0 - a.z0);

  const props: Prop[] = [];
  const groundFloor = u * 1.05;
  const floorH = u * 0.85;

  for (const b of buildings) {
    const r = createRandom(b.seed);
    const len = b.z1 - b.z0;
    const zmid = (b.z0 + b.z1) / 2;

    // Parede
    poly([fp(b, b.z0, Y0), fp(b, b.z1, Y0), fp(b, b.z1, b.top1), fp(b, b.z0, b.top0)]);
    ctx.fillStyle = b.tone;
    ctx.fill();
    const [, topScreen] = fp(b, b.z0, Math.max(b.top0, b.top1));
    const [, footScreen] = fp(b, b.z0, Y0);
    const dark = ctx.createLinearGradient(0, topScreen, 0, footScreen);
    dark.addColorStop(0, 'rgba(5,4,8,0.88)');
    dark.addColorStop(0.55, 'rgba(5,4,8,0.4)');
    dark.addColorStop(1, 'rgba(5,4,8,0.5)');
    ctx.fillStyle = dark;
    ctx.fill();

    // Beiral e chaminé
    ctx.fillStyle = '#120d10';
    poly([fp(b, b.z0, b.top0), fp(b, b.z1, b.top1), fp(b, b.z1, b.top1 + u * 0.12), fp(b, b.z0, b.top0 + u * 0.12)]);
    ctx.fill();
    if (r() < 0.7) {
      const cz = b.z0 + len * (0.2 + r() * 0.5);
      const ctop = Math.max(b.top0, b.top1) + u * (0.35 + r() * 0.4);
      facadeQuad(b, cz, Math.min(b.top0, b.top1), cz + len * 0.12, ctop);
      ctx.fillStyle = '#1d1416';
      ctx.fill();
    }

    // Andar térreo: cornija, vitrine e porta
    facadeQuad(b, b.z0, Y0 + u * 0.84, b.z1, Y0 + u * 0.98);
    ctx.fillStyle = 'rgba(10,6,8,0.65)';
    ctx.fill();
    const wz0 = b.z0 + len * 0.12;
    const wz1 = b.z0 + len * 0.6;
    facadeQuad(b, wz0, Y0 + u * 0.22, wz1, Y0 + u * 0.74);
    const [sx0, sy0] = fp(b, wz0, Y0 + u * 0.74);
    const [sx1, sy1] = fp(b, wz1, Y0 + u * 0.22);
    const shop = ctx.createLinearGradient(sx0, sy0, sx1, sy1);
    const shopLit = r() < 0.8;
    shop.addColorStop(0, shopLit ? '#e9a24c' : '#2a2026');
    shop.addColorStop(1, shopLit ? '#6e2c12' : '#120c10');
    ctx.fillStyle = shop;
    ctx.fill();
    // Mercadorias na vitrine (silhuetas) e caixilhos
    ctx.fillStyle = 'rgba(40,18,12,0.55)';
    for (let i = 0; i < 6; i++) {
      const iz = wz0 + (wz1 - wz0) * (0.05 + r() * 0.8);
      const iy = Y0 + u * (0.24 + (i % 2) * 0.24);
      facadeQuad(b, iz, iy, iz + (wz1 - wz0) * 0.12, iy + u * (0.1 + r() * 0.12));
      ctx.fill();
    }
    ctx.strokeStyle = 'rgba(20,10,8,0.9)';
    ctx.lineWidth = Math.max(0.6, 2.2 / zmid);
    for (let i = 1; i < 4; i++) {
      const mz = wz0 + ((wz1 - wz0) * i) / 4;
      ctx.beginPath();
      ctx.moveTo(...fp(b, mz, Y0 + u * 0.22));
      ctx.lineTo(...fp(b, mz, Y0 + u * 0.74));
      ctx.stroke();
    }
    facadeQuad(b, b.z0 + len * 0.7, Y0, b.z0 + len * 0.86, Y0 + u * 0.72);
    ctx.fillStyle = '#1a0f0a';
    ctx.fill();

    // Janelas dos andares superiores
    const floors = Math.max(1, Math.floor((Math.min(b.top0, b.top1) - Y0 - groundFloor) / floorH));
    const perFloor = Math.max(1, Math.round(len / 0.5));
    for (let f = 0; f < floors; f++) {
      const fy0 = Y0 + groundFloor + f * floorH + floorH * 0.22;
      const fy1 = fy0 + floorH * 0.5;
      for (let j = 0; j < perFloor; j++) {
        const za = b.z0 + (len * (j + 0.22)) / perFloor;
        const zb = b.z0 + (len * (j + 0.78)) / perFloor;
        const lit = r() < 0.55;
        facadeQuad(b, za, fy0, zb, fy1);
        ctx.fillStyle = lit ? `hsl(${30 + r() * 12} 90% ${42 + r() * 14}%)` : '#0c0d16';
        ctx.fill();
        ctx.strokeStyle = '#0d0808';
        ctx.lineWidth = Math.max(0.5, 2 / zmid);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(...fp(b, (za + zb) / 2, fy0));
        ctx.lineTo(...fp(b, (za + zb) / 2, fy1));
        ctx.moveTo(...fp(b, za, (fy0 + fy1) / 2));
        ctx.lineTo(...fp(b, zb, (fy0 + fy1) / 2));
        ctx.stroke();
        if (lit) {
          const [gx, gy] = fp(b, (za + zb) / 2, (fy0 + fy1) / 2);
          const gr = (u * 0.5) / zmid;
          ctx.save();
          ctx.globalCompositeOperation = 'lighter';
          const g = ctx.createRadialGradient(gx, gy, 0, gx, gy, gr);
          g.addColorStop(0, 'rgba(255,160,70,0.1)');
          g.addColorStop(1, 'rgba(255,170,80,0)');
          ctx.fillStyle = g;
          ctx.fillRect(gx - gr, gy - gr, gr * 2, gr * 2);
          ctx.restore();
        }
      }
    }

    // Divisa entre prédios e névoa da distância
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.lineWidth = Math.max(0.6, 3 / b.z0);
    ctx.beginPath();
    ctx.moveTo(...fp(b, b.z0, Y0));
    ctx.lineTo(...fp(b, b.z0, b.top0));
    ctx.stroke();
    poly([fp(b, b.z0, Y0), fp(b, b.z1, Y0), fp(b, b.z1, b.top1 + u * 0.12), fp(b, b.z0, b.top0 + u * 0.12)]);
    ctx.fillStyle = `rgba(78,44,42,${haze(zmid)})`;
    ctx.fill();

    // Lampião na divisa
    const lz = b.z0 + 0.04;
    const ly = Y0 + u * 1.12;
    props.push({ z: lz, draw: () => drawLantern(b, lz, ly) });
    if (b.sign) {
      const sz = b.z0 + len * 0.45;
      const name = b.sign;
      props.push({ z: sz, draw: () => drawSign(b, sz, Y0 + u * (b.side < 0 ? 1.12 : 1.42) + u * r() * 0.12, name) });
    }
  }

  function drawLantern(b: Building, z: number, Y: number) {
    const arm = u * 0.09;
    const xf = facadeX(b, Y + u * 0.1);
    const xl = xf - b.side * arm;
    const [ax, ay] = P(xf, Y + u * 0.1, z);
    const [bx, by] = P(xl, Y + u * 0.1, z);
    const [lx, ly] = P(xl, Y, z);
    const s = u / z;
    ctx.strokeStyle = '#0d0a0a';
    ctx.lineWidth = Math.max(0.6, s * 0.012);
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
    ctx.lineTo(lx, ly - s * 0.034);
    ctx.stroke();
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const g = ctx.createRadialGradient(lx, ly, 0, lx, ly, s * 0.32);
    g.addColorStop(0, `rgba(255,170,70,${0.42 - haze(z) * 0.3})`);
    g.addColorStop(0.35, `rgba(255,140,50,${0.12 - haze(z) * 0.08})`);
    g.addColorStop(1, 'rgba(255,140,50,0)');
    ctx.fillStyle = g;
    ctx.fillRect(lx - s * 0.32, ly - s * 0.32, s * 0.64, s * 0.64);
    // Reflexo no chão molhado
    const [, gy] = P(xl, Y0, z);
    ctx.globalAlpha = 0.22 - haze(z) * 0.18;
    const refl = ctx.createLinearGradient(0, gy, 0, gy + s * 0.3);
    refl.addColorStop(0, 'rgba(255,170,80,0.7)');
    refl.addColorStop(1, 'rgba(255,170,80,0)');
    ctx.fillStyle = refl;
    ctx.fillRect(lx - s * 0.015, gy, s * 0.03, s * 0.3);
    ctx.restore();
    // Corpo do lampião: armação escura, vidro âmbar e chama clara no centro.
    ctx.fillStyle = '#120c09';
    ctx.fillRect(lx - s * 0.02, ly - s * 0.034, s * 0.04, s * 0.064);
    ctx.fillStyle = '#f0a040';
    ctx.fillRect(lx - s * 0.013, ly - s * 0.026, s * 0.026, s * 0.048);
    ctx.fillStyle = '#fff1c4';
    ctx.fillRect(lx - s * 0.004, ly - s * 0.012, s * 0.008, s * 0.018);
  }

  function drawSign(b: Building, z: number, Y: number, name: string) {
    const s = u / z;
    const xf = facadeX(b, Y);
    const near = xf - b.side * u * 0.05;
    const far = near - b.side * u * 0.32;
    const [x0, y0] = P(near, Y + u * 0.1, z);
    const [x1, y1] = P(far, Y - u * 0.06, z);
    const left = Math.min(x0, x1);
    const w = Math.abs(x1 - x0);
    const top = y0;
    const h = y1 - y0;
    ctx.strokeStyle = '#0d0a0a';
    ctx.lineWidth = Math.max(0.6, s * 0.01);
    const [fx, fy] = P(xf, Y + u * 0.15, z);
    ctx.beginPath();
    ctx.moveTo(fx, fy);
    ctx.lineTo(b.side > 0 ? left : left + w, fy);
    ctx.moveTo(left + w * 0.1, fy);
    ctx.lineTo(left + w * 0.1, top);
    ctx.moveTo(left + w * 0.9, fy);
    ctx.lineTo(left + w * 0.9, top);
    ctx.stroke();
    const wood = ctx.createLinearGradient(0, top, 0, top + h);
    wood.addColorStop(0, '#3a2416');
    wood.addColorStop(1, '#1e120b');
    ctx.fillStyle = wood;
    ctx.fillRect(left, top, w, h);
    ctx.strokeStyle = '#b8893c';
    ctx.lineWidth = Math.max(0.5, s * 0.008);
    ctx.strokeRect(left + h * 0.08, top + h * 0.08, w - h * 0.16, h * 0.84);
    const size = h * 0.34;
    if (size >= 4) {
      ctx.fillStyle = '#e7c46e';
      ctx.font = `600 ${size}px ${SERIF}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(name, left + w / 2, top + h * 0.53, w * 0.84);
    }
    ctx.fillStyle = `rgba(78,44,42,${haze(z)})`;
    ctx.fillRect(left, top, w, h);
  }

  // ---------------------------------------------------------------- calçamento
  {
    // O chão começa antes da parede para cobrir a tela quando a câmera avança.
    const [lx0, gy0] = P(-S, Y0, Z_NEAR);
    const [rx0] = P(S, Y0, Z_NEAR);
    const [lxe, gye] = P(-S, Y0, Z_END);
    const [rxe] = P(S, Y0, Z_END);
    poly([[lx0, gy0], [rx0, gy0], [rxe, gye], [lxe, gye]]);
    const base = ctx.createLinearGradient(0, gye, 0, gy0);
    base.addColorStop(0, '#4a3328');
    base.addColorStop(1, '#17110e');
    ctx.fillStyle = base;
    ctx.fill();

    // Paralelepípedos arredondados: pedra escura, borda de cima pegando a luz
    // do fim do beco e rejunte de terra entre eles.
    let z = Z_NEAR;
    let row = 0;
    while (z < Z_END) {
      const zb = z * 1.032;
      const [, ya] = P(0, Y0, z);
      const [, yb] = P(0, Y0, zb);
      if (ya - yb < 1.2) break;
      const gapZ = (zb - z) * 0.14;
      const gapX = u * 0.006;
      let x = -S - ((row++ % 2) * u * 0.035 + rand() * u * 0.02);
      while (x < S) {
        const w = u * 0.07 * (0.75 + rand() * 0.5);
        const l = 9 + rand() * 11;
        const a = P(x + gapX, Y0, z + gapZ * 0.5);
        const b = P(x + w - gapX, Y0, z + gapZ * 0.5);
        const c = P(x + w - gapX, Y0, zb - gapZ * 0.5);
        const d = P(x + gapX, Y0, zb - gapZ * 0.5);
        ctx.beginPath();
        ctx.moveTo(a[0], a[1]);
        ctx.quadraticCurveTo((a[0] + b[0]) / 2, a[1] + (ya - yb) * 0.12, b[0], b[1]);
        ctx.lineTo(c[0], c[1]);
        ctx.quadraticCurveTo((c[0] + d[0]) / 2, c[1] - (ya - yb) * 0.25, d[0], d[1]);
        ctx.closePath();
        ctx.fillStyle = `hsl(${20 + rand() * 18} ${5 + rand() * 7}% ${l}%)`;
        ctx.fill();
        ctx.fillStyle = `rgba(255,190,120,${0.06 + rand() * 0.1})`;
        ctx.fillRect(d[0] + (c[0] - d[0]) * 0.15, d[1], (c[0] - d[0]) * 0.7, Math.max(0.5, (ya - yb) * 0.14));
        x += w;
      }
      z = zb;
    }
    // Brilho da rua molhada refletindo as luzes do fim do beco
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    const sheen = ctx.createRadialGradient(cx, gye, 0, cx, gye, (gy0 - gye) * 1.1);
    sheen.addColorStop(0, 'rgba(255,170,100,0.28)');
    sheen.addColorStop(0.5, 'rgba(255,150,90,0.06)');
    sheen.addColorStop(1, 'rgba(255,150,90,0)');
    ctx.fillStyle = sheen;
    poly([[lx0, gy0], [rx0, gy0], [rxe, gye], [lxe, gye]]);
    ctx.fill();
    ctx.restore();
  }

  // ---------------------------------------------------------------- bandeirolas
  for (const z of [1.6, 2.5, 3.7, 5.3]) {
    const Yb = Y0 + u * (1.95 + rand() * 0.45);
    const lean = 0.07;
    const xl = -(S - lean * (Yb - Y0));
    const xr = S - lean * (Yb - Y0);
    const sag = u * 0.3;
    props.push({
      z,
      draw: () => {
        const at = (t: number): Pt => P(xl + (xr - xl) * t, Yb - sag * 4 * t * (1 - t), z);
        ctx.strokeStyle = 'rgba(20,14,12,0.9)';
        ctx.lineWidth = Math.max(0.5, (u * 0.008) / z);
        ctx.beginPath();
        for (let i = 0; i <= 24; i++) {
          const [x, y] = at(i / 24);
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
        const flags = 16;
        const fw = (u * 0.09) / z;
        const fh = (u * 0.15) / z;
        for (let i = 1; i < flags; i++) {
          const [x, y] = at(i / flags);
          ctx.fillStyle = i % 2 ? '#8e1b2c' : '#c99a3a';
          poly([[x - fw / 2, y], [x + fw / 2, y], [x, y + fh]]);
          ctx.fill();
          ctx.fillStyle = `rgba(78,44,42,${haze(z)})`;
          ctx.fill();
        }
      },
    });
  }

  props.sort((a, b) => b.z - a.z).forEach((p) => p.draw());

  // ---------------------------------------------------------------- atmosfera
  ctx.save();
  ctx.globalCompositeOperation = 'screen';
  const glow = ctx.createRadialGradient(cx, vanishY, 0, cx, vanishY, u * 0.9);
  glow.addColorStop(0, 'rgba(255,184,110,0.3)');
  glow.addColorStop(0.4, 'rgba(255,150,90,0.07)');
  glow.addColorStop(1, 'rgba(255,150,90,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);
  ctx.restore();
}
