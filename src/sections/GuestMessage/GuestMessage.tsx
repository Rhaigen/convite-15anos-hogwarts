import { useRef } from 'react';
import { gsap, ScrollTrigger } from '../../animations/gsap';
import { revealHeading } from '../../animations/reveal';
import { ChapterHeading } from '../../components/ui/ChapterHeading';
import { Quill } from '../../components/ui/Ornaments';
import { guestMessage } from '../../content/texts';
import { useGsapScene } from '../../hooks/useGsapScene';
import './message.css';

/** Ponta da pena no desenho (`Quill`, viewBox 80×200), em fração da largura/altura. */
const TIP_X = 0.375;
const TIP_Y = 0.98;

/**
 * Capítulo IV — mensagem aos convidados. O pergaminho se desenrola com a
 * rolagem; cada parágrafo é "escrito" com tinta (máscara de cima para baixo)
 * enquanto a pena percorre as linhas. O texto final permanece estático e legível.
 */
export function GuestMessage() {
  const ref = useRef<HTMLElement>(null);

  useGsapScene(ref, ({ root, reducedMotion }) => {
    if (reducedMotion) return;
    revealHeading(root);

    const paper = root.querySelector<HTMLElement>('.scroll__paper');
    const quill = root.querySelector<SVGSVGElement>('.scroll__quill');
    if (!paper || !quill) return;

    // Desenrolar: o papel abre a partir do centro e os rolos se afastam.
    const half = () => paper.offsetHeight * 0.46;
    gsap
      .timeline({
        scrollTrigger: { trigger: '.scroll', start: 'top 88%', end: 'top 30%', scrub: 0.6, invalidateOnRefresh: true },
      })
      .fromTo(paper, { clipPath: 'inset(46% 0% 46% 0%)' }, { clipPath: 'inset(0% 0% 0% 0%)', ease: 'none' }, 0)
      .fromTo('.scroll__roller--top', { y: half }, { y: 0, ease: 'none' }, 0)
      .fromTo('.scroll__roller--bottom', { y: () => -half() }, { y: 0, ease: 'none' }, 0);

    // Escrita: a ponta da pena percorre cada linha do parágrafo, da esquerda
    // para a direita, enquanto a tinta aparece; no fim traça a assinatura e
    // só então sai do pergaminho. Os trechos entram numa fila (rolar depressa
    // não faz a pena pular) e cada um mede o texto na hora em que começa.
    const signature = root.querySelector<HTMLElement>('.scroll__signature');
    const paragraphs = Array.from(root.querySelectorAll<HTMLElement>('[data-ink]'));
    gsap.set(quill, { opacity: 0 });
    gsap.set(paragraphs, { '--ink': '-25%' });
    if (signature) gsap.set(signature, { clipPath: 'inset(0% 100% 0% 0%)' });

    /**
     * Posição (x, y) da pena para a ponta tocar o ponto (px, py) do papel. A pena
     * é um `<svg>` (sem offsetLeft/offsetWidth): o lugar de origem vem do CSS
     * (`top` e `right` no papel), sem as transformações do GSAP.
     */
    const tip = (px: number, py: number) => {
      const cs = getComputedStyle(quill);
      const width = parseFloat(cs.width);
      const left = paper.clientWidth - parseFloat(cs.right) - width;
      return { x: px - left - width * TIP_X, y: py - parseFloat(cs.top) - parseFloat(cs.height) * TIP_Y };
    };
    /** Linhas do elemento, em coordenadas do papel (uma caixa por linha). */
    const lines = (el: HTMLElement) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      const origin = paper.getBoundingClientRect();
      const found: { left: number; right: number; base: number }[] = [];
      for (const r of Array.from(range.getClientRects())) {
        if (r.width < 1) continue;
        const base = r.bottom - origin.top - r.height * 0.22;
        const same = found.find((l) => Math.abs(l.base - base) < r.height / 2);
        if (same) {
          same.left = Math.min(same.left, r.left - origin.left);
          same.right = Math.max(same.right, r.right - origin.left);
        } else found.push({ left: r.left - origin.left, right: r.right - origin.left, base });
      }
      return found.sort((a, b) => a.base - b.base);
    };
    /** Leva a ponta da pena ao início de `line` (aparece ali se ainda estiver oculta). */
    const approach = (tl: gsap.core.Timeline, line: { left: number; base: number }) => {
      const start = tip(line.left, line.base);
      if (Number(gsap.getProperty(quill, 'opacity')) < 0.5) {
        tl.set(quill, { ...start, y: start.y - 24, rotation: -8 }).to(quill, { y: start.y, opacity: 1, duration: 0.4 });
      } else {
        tl.to(quill, { ...start, rotation: -8, duration: 0.6, ease: 'power2.inOut' });
      }
    };

    const writeParagraph = (p: HTMLElement) => {
      const tl = gsap.timeline();
      const rows = lines(p);
      if (rows.length === 0) return tl.set(p, { '--ink': '125%' });
      approach(tl, rows[0]!);
      const per = Math.max(0.45, Math.min(0.75, 2.4 / rows.length));
      tl.addLabel('ink').fromTo(p, { '--ink': '0%' }, { '--ink': '125%', duration: per * rows.length, ease: 'none' }, 'ink');
      rows.forEach((row, i) => {
        const at = `ink+=${i * per}`;
        if (i > 0) tl.to(quill, { ...tip(row.left, row.base), duration: per * 0.15, ease: 'power1.inOut' }, at);
        const sweep = i > 0 ? per * 0.85 : per;
        tl.to(quill, { ...tip(row.right, row.base), duration: sweep, ease: 'none' }, i > 0 ? `${at}+=${per * 0.15}` : at);
        tl.fromTo(quill, { rotation: -8 }, { rotation: 4, duration: sweep / 4, ease: 'sine.inOut', repeat: 3, yoyo: true }, i > 0 ? `${at}+=${per * 0.15}` : at);
      });
      return tl.to(quill, { rotation: 0, duration: 0.3 });
    };

    const writeSignature = (sig: HTMLElement) => {
      const tl = gsap.timeline();
      const row = lines(sig)[0];
      if (!row) return tl.set(sig, { clipPath: 'inset(0% 0% 0% 0%)' });
      approach(tl, row);
      tl.addLabel('sign')
        .to(sig, { clipPath: 'inset(0% 0% 0% 0%)', duration: 1.8, ease: 'power1.inOut' }, 'sign')
        .to(quill, { x: tip(row.right, row.base).x, duration: 1.8, ease: 'power1.inOut' }, 'sign')
        .to(quill, { y: '-=14', rotation: 6, duration: 0.225, ease: 'sine.inOut', repeat: 7, yoyo: true }, 'sign');
      // Termina o traço, ergue-se e some ainda sobre o pergaminho.
      return tl.to(quill, { y: '-=70', x: '-=10', rotation: 14, opacity: 0, duration: 1, ease: 'power2.in' }, '+=0.25');
    };

    const writing = gsap.context(() => {});
    let queue = Promise.resolve();
    let alive = true;
    const enqueue = (build: () => gsap.core.Timeline) => {
      queue = queue.then(() => {
        if (!alive) return;
        let tl!: gsap.core.Timeline;
        writing.add(() => (tl = build()));
        return new Promise<void>((done) => tl.eventCallback('onComplete', () => done()));
      });
    };
    paragraphs.forEach((p) =>
      ScrollTrigger.create({ trigger: p, start: 'top 80%', once: true, onEnter: () => enqueue(() => writeParagraph(p)) }),
    );
    if (signature) {
      ScrollTrigger.create({
        trigger: signature,
        start: 'top 85%',
        once: true,
        onEnter: () => enqueue(() => writeSignature(signature)),
      });
    }

    return () => {
      alive = false;
      writing.revert();
    };
  });

  return (
    <section ref={ref} id="mensagem" className="message section-shell" data-scene="message" aria-labelledby="message-title">
      <ChapterHeading id="message-title" kicker={guestMessage.kicker} title={guestMessage.title} />

      <div className="scroll">
        <div className="scroll__roller scroll__roller--top" aria-hidden="true" />
        <div className="scroll__paper parchment">
          <Quill className="scroll__quill" />
          <blockquote className="scroll__text">
            {guestMessage.paragraphs.map((text) => (
              <p key={text} className="scroll__para" data-ink>
                {text}
              </p>
            ))}
            <footer className="scroll__signature">{guestMessage.signature}</footer>
          </blockquote>
        </div>
        <div className="scroll__roller scroll__roller--bottom" aria-hidden="true" />
      </div>
    </section>
  );
}
