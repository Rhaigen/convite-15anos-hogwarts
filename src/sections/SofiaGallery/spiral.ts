/**
 * Geometria da torre espiral de retratos (Capítulo III).
 * Funções puras (sem APIs de navegador) para poderem ser testadas.
 *
 * Os quadros ficam em volta de um eixo vertical invisível. O quadro em foco
 * fica na frente (x = 0, z = 0); cada quadro seguinte está um quarto de volta
 * adiante e um "degrau" mais abaixo. A rolagem avança o foco, e a espiral
 * gira e sobe trazendo cada quadro para a frente.
 */

/** Ângulo entre quadros consecutivos na espiral (graus). */
export const ANGLE_STEP = 90;
/**
 * Os quadros giram acompanhando a curva, mas aliviados nos lados:
 * giro = θ − ROTATION_EASE·sen θ. Os laterais (θ = ±90°) ficam a ±50°, com a
 * frente visível em perspectiva (a 90° estariam de perfil); os de trás
 * (θ = 180°) mostram o verso inteiro.
 */
export const ROTATION_EASE = 40;
/** Escurecimento máximo dos quadros mais distantes (0–1). */
export const MAX_SHADE = 0.72;
/** Distância (em quadros) a partir da qual o quadro começa a sumir, e onde some de vez. */
export const FADE_START = 2;
export const FADE_END = 3;
/** Distância (em quadros) até a qual o quadro conta como "o da frente". */
export const FRONT_RANGE = 0.5;

export interface TowerMetrics {
  /** Largura de um quadro vertical, px. */
  verticalWidth: number;
  /** Largura de um quadro horizontal, px. */
  horizontalWidth: number;
  /** Raio da espiral, px. */
  radius: number;
  /** Descida vertical entre quadros consecutivos, px. */
  step: number;
  /** `perspective` do palco, px. */
  perspective: number;
}

export interface FramePose {
  x: number;
  y: number;
  z: number;
  /** Giro em torno do eixo vertical (graus). */
  rotY: number;
  /** 0 (na frente) a 1 (bem atrás): profundidade para o escurecimento. */
  shade: number;
  opacity: number;
  visible: boolean;
  front: boolean;
}

/** Medidas da torre para um palco de `width` × `height` px. */
export function towerMetrics(width: number, height: number): TowerMetrics {
  const compact = width < 700;
  // Moldura vertical ≈ 0,68 (largura ÷ altura), ocupando até 64% da altura do palco.
  const verticalWidth = Math.round(Math.min(width * 0.66, height * 0.64 * 0.68));
  const horizontalWidth = Math.round(Math.min(verticalWidth * 1.6, width * 0.9));
  return {
    verticalWidth,
    horizontalWidth,
    // Em tela estreita a espiral é mais fechada, para os quadros laterais não saírem do palco.
    radius: Math.round(verticalWidth * (compact ? 0.85 : 1.1)),
    step: Math.round(height * 0.34),
    perspective: compact ? 900 : 1400,
  };
}

/** Foco (índice fracionário do quadro na frente) para o progresso 0–1 da rolagem. */
export function focusAt(progress: number, count: number): number {
  const p = Math.min(1, Math.max(0, progress));
  return p * Math.max(0, count - 1);
}

/** Progresso 0–1 da rolagem que traz o quadro `index` para a frente (inverso de `focusAt`). */
export function progressFor(index: number, count: number): number {
  if (count <= 1) return 0;
  return Math.min(1, Math.max(0, index / (count - 1)));
}

/** Posição do quadro `index` quando o foco está em `focus`. */
export function framePose(index: number, focus: number, m: TowerMetrics): FramePose {
  const d = index - focus;
  const theta = (d * ANGLE_STEP * Math.PI) / 180;
  const cos = Math.cos(theta);
  const far = Math.abs(d);
  const opacity = Math.min(1, Math.max(0, (FADE_END - far) / (FADE_END - FADE_START)));
  return {
    x: m.radius * Math.sin(theta),
    y: d * m.step,
    z: m.radius * (cos - 1),
    rotY: d * ANGLE_STEP - ROTATION_EASE * Math.sin(theta),
    shade: (1 - cos) / 2,
    opacity,
    visible: opacity > 0,
    front: far < FRONT_RANGE,
  };
}
