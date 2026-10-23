import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
  BookOpen,
  Cake,
  Camera,
  ChevronLeft,
  CreditCard,
  Crown,
  ExternalLink,
  Feather,
  Gem,
  Gift as GiftGlyph,
  Heart,
  LoaderCircle,
  Music,
  Plane,
  QrCode,
  Shirt,
  Sparkles,
  Star,
  WandSparkles,
  Watch,
  X,
  type LucideIcon,
} from 'lucide-react';
import { gsap } from '../../animations/gsap';
import { useEffects } from '../../components/effects/EffectsContext';
import { Divider } from '../../components/ui/Ornaments';
import { WaxSeal } from '../../components/ui/WaxSeal';
import { giftsConfig } from '../../content/settings';
import { gifts as copy } from '../../content/texts';
import {
  checkoutEndpoint,
  fetchProgress,
  loadGifts,
  progressEndpoint,
  simulateCheckout,
  startCheckout,
  type LoadedGifts,
  type ReturnState,
} from '../../lib/giftCheckout';
import { formatBRL, toCents, type PaymentMethod } from '../../lib/giftPricing';
import {
  chargePerMethod,
  fundAmountError,
  GIFT_MESSAGE_MAX,
  GIFT_SIGNATURE_MAX,
  parseReais,
  quotaBaseCents,
  safeHttpsUrl,
} from '../../lib/gifts';
import type { FreeGift, FundGift, Gift, GiftIcon, QuotaGift } from '../../types/content';
import { PixVault } from './PixVault';
import './giftScroll.css';

const ICONS: Record<GiftIcon, LucideIcon> = {
  gift: GiftGlyph,
  wand: WandSparkles,
  book: BookOpen,
  plane: Plane,
  camera: Camera,
  music: Music,
  gem: Gem,
  shirt: Shirt,
  sparkles: Sparkles,
  crown: Crown,
  feather: Feather,
  cake: Cake,
  heart: Heart,
  star: Star,
  watch: Watch,
};

// Fotos geradas por `npm run gifts:images` (src/assets/presentes/<id>.webp, fora do git):
// num clone sem elas, o glob vem vazio e o cartão mostra o ícone.
const PHOTOS: Record<string, string> = Object.fromEntries(
  Object.entries(import.meta.glob<string>('../../assets/presentes/*.webp', { eager: true, import: 'default' })).map(([file, url]) => [
    file.replace(/^.*\/([^/]+)\.webp$/, '$1'),
    url,
  ]),
);

/** Foto do presente (se houver) ou o ícone; decorativa, o nome vem logo abaixo. */
function GiftVisual({ gift, large = false }: { gift: Gift; large?: boolean }) {
  const photo = gift.image ? PHOTOS[gift.id] : undefined;
  if (photo) {
    return (
      <span className={`gift-photo${large ? ' gift-photo--large' : ''}`}>
        <img src={photo} alt="" width={480} height={480} loading="lazy" decoding="async" />
      </span>
    );
  }
  const Icon = ICONS[gift.icon ?? 'gift'] ?? GiftGlyph;
  return (
    <span className="gift-card__icon" aria-hidden="true">
      <Icon size={22} strokeWidth={1.5} />
    </span>
  );
}

type View = { kind: 'list' } | { kind: 'gift'; id: string } | { kind: 'thanks'; demo: boolean };

interface GiftScrollProps {
  open: boolean;
  /** Volta do Asaas: "enviado" abre o agradecimento; os outros, a lista com um aviso. */
  returnState: ReturnState | null;
  onClose: () => void;
}

/**
 * A lista de presentes num <dialog> nativo em forma de pergaminho (foco preso, Esc e
 * clique fora fecham, o navegador devolve o foco ao botão). Ao abrir, o papel se
 * desenrola entre duas varetas douradas; com movimento reduzido, só um fade (CSS).
 * Três visões no mesmo papel: a lista, o presente escolhido (valor, mensagem, assinatura)
 * e o agradecimento na volta do Asaas.
 */
export default function GiftScroll({ open, returnState, onClose }: GiftScrollProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const sceneRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const timeline = useRef<gsap.core.Timeline | null>(null);
  const closing = useRef(false);
  const firstView = useRef(true);
  const { reducedMotion } = useEffects();
  const [data, setData] = useState<LoadedGifts | null>(null);
  const [progress, setProgress] = useState<Map<string, number> | null>(null);
  const [view, setView] = useState<View>(returnState === 'enviado' ? { kind: 'thanks', demo: false } : { kind: 'list' });
  const [notice, setNotice] = useState<ReturnState | null>(returnState === 'enviado' ? null : returnState);

  useEffect(() => {
    let cancelled = false;
    loadGifts().then((loaded) => {
      if (!cancelled) setData(loaded);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Progresso das vaquinhas: lido ao abrir (só se houver vaquinha). Falhou: mostra só a meta.
  useEffect(() => {
    if (!open || !data || !data.gifts.some((g) => g.kind === 'fund')) return;
    if (data.demoProgress) {
      setProgress(new Map(Object.entries(data.demoProgress)));
      return;
    }
    const url = progressEndpoint();
    if (!url) return;
    const abort = new AbortController();
    fetchProgress(url, abort.signal)
      .then(setProgress)
      .catch(() => {});
    return () => abort.abort();
  }, [open, data]);

  const focusHeading = () => sceneRef.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus({ preventScroll: true });

  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      closing.current = false;
      dialog.showModal();
      if (reducedMotion) focusHeading();
      else timeline.current = playOpening();
    }
    if (!open && dialog.open) dialog.close();
    // Abre uma vez por clique; a preferência de movimento vale para a próxima abertura.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function playOpening(): gsap.core.Timeline | null {
    const scene = sceneRef.current;
    const paper = scene?.querySelector<HTMLElement>('.gift-scroll__paper');
    const rods = scene?.querySelectorAll<HTMLElement>('.gift-scroll__rod');
    if (!scene || !paper || !rods || rods.length < 2) return null;
    ref.current?.focus({ preventScroll: true });
    const half = paper.getBoundingClientRect().height / 2;
    const tl = gsap.timeline({ defaults: { ease: 'power3.inOut' } });
    tl.from(scene, { autoAlpha: 0, scale: 0.94, y: 20, duration: 0.45, ease: 'power2.out' });
    tl.addLabel('unroll', '-=0.05');
    tl.fromTo(paper, { clipPath: 'inset(50% 0% 50% 0%)' }, { clipPath: 'inset(0% 0% 0% 0%)', duration: 1.05 }, 'unroll');
    tl.fromTo(rods[0]!, { y: half }, { y: 0, duration: 1.05 }, 'unroll');
    tl.fromTo(rods[1]!, { y: -half }, { y: 0, duration: 1.05 }, 'unroll');
    tl.from(scene.querySelectorAll('.gift-scroll__reveal'), { autoAlpha: 0, y: 12, stagger: 0.05, duration: 0.5, ease: 'power2.out' }, 'unroll+=0.7');
    tl.call(focusHeading, undefined, 'unroll+=0.8');
    return tl;
  }

  function requestClose() {
    const dialog = ref.current;
    const scene = sceneRef.current;
    if (!dialog || closing.current) return;
    closing.current = true;
    timeline.current?.progress(1);
    if (reducedMotion || !scene) {
      dialog.close();
      return;
    }
    gsap.to(scene, { autoAlpha: 0, y: 24, scale: 0.97, duration: 0.3, ease: 'power2.in', onComplete: () => dialog.close() });
  }

  // Ao fechar: limpa o que a coreografia deixou (a próxima abertura começa do zero).
  useLayoutEffect(() => {
    if (open) return;
    timeline.current?.kill();
    timeline.current = null;
    const scene = sceneRef.current;
    if (scene) gsap.set([scene, ...Array.from(scene.querySelectorAll('.gift-scroll__paper, .gift-scroll__rod, .gift-scroll__reveal'))], { clearProps: 'all' });
  }, [open]);

  // Trocar de visão: o papel volta ao topo e o foco vai para o título da nova visão.
  useEffect(() => {
    if (firstView.current) {
      firstView.current = false;
      return;
    }
    bodyRef.current?.scrollTo({ top: 0 });
    focusHeading();
  }, [view]);

  const handleClosed = () => {
    setView({ kind: 'list' });
    setNotice(null);
    onClose();
  };

  return (
    <dialog
      ref={ref}
      tabIndex={-1}
      className="gift-dialog"
      aria-labelledby="gift-scroll-title"
      onClose={handleClosed}
      onCancel={(e) => {
        e.preventDefault();
        requestClose();
      }}
      onClick={(e) => {
        // Clique fora do pergaminho (e dos botões) fecha.
        if (!(e.target as Element).closest('.gift-scroll__paper, .gift-scroll__rod, button')) requestClose();
      }}
    >
      <div ref={sceneRef} className="gift-scroll">
        <span className="gift-scroll__rod" aria-hidden="true" />
        <div className="gift-scroll__paper parchment">
          <div ref={bodyRef} className="gift-scroll__body">
            {view.kind === 'thanks' ? (
              <ThanksView demo={view.demo} onBack={() => setView({ kind: 'list' })} onClose={requestClose} />
            ) : view.kind === 'gift' && data ? (
              <GiftForm
                gift={data.gifts.find((g) => g.id === view.id)!}
                demo={data.demo}
                onBack={() => setView({ kind: 'list' })}
                onSimulated={() => setView({ kind: 'thanks', demo: true })}
              />
            ) : (
              <ListView data={data} progress={progress} notice={notice} onPick={(id) => setView({ kind: 'gift', id })} />
            )}
          </div>
        </div>
        <span className="gift-scroll__rod" aria-hidden="true" />
      </div>
      <button type="button" className="icon-btn gift-dialog__close" aria-label={copy.close} onClick={requestClose}>
        <X aria-hidden="true" size={22} strokeWidth={1.5} />
      </button>
    </dialog>
  );
}

function ScrollHeader({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <header className="gift-scroll__header gift-scroll__reveal">
      <p className="gift-scroll__kicker">{copy.scrollKicker}</p>
      <h2 id="gift-scroll-title" className="gift-scroll__title" tabIndex={-1} data-autofocus>
        {title}
      </h2>
      <Divider className="gift-scroll__divider" />
      {children}
    </header>
  );
}

/* ----------------------------------------------------------------------------
   Lista
   ---------------------------------------------------------------------------- */
interface ListViewProps {
  data: LoadedGifts | null;
  progress: Map<string, number> | null;
  notice: ReturnState | null;
  onPick: (id: string) => void;
}

function ListView({ data, progress, notice, onPick }: ListViewProps) {
  const gifts = data?.gifts ?? [];
  const quotas = gifts.filter((g): g is QuotaGift => g.kind === 'quota');
  const funds = gifts.filter((g): g is FundGift => g.kind === 'fund');
  const free = gifts.filter((g): g is FreeGift => g.kind === 'free');
  const canPay = Boolean(checkoutEndpoint()) || simulateCheckout(Boolean(data?.demo));

  return (
    <>
      <ScrollHeader title={copy.scrollTitle}>
        <p className="gift-scroll__intro">{copy.scrollIntro(giftsConfig.maxInstallments)}</p>
        {data?.demo && <p className="gift-scroll__demo">{copy.demoBadge}</p>}
      </ScrollHeader>

      {notice && (
        <p className="notice notice-pending gift-scroll__notice" role="status">
          {notice === 'cancelado' ? copy.canceledText : copy.expiredText}
        </p>
      )}

      {data && gifts.length === 0 && <p className="gift-scroll__empty gift-scroll__reveal">{copy.empty}</p>}
      {!canPay && quotas.length + funds.length > 0 && <p className="notice notice-pending gift-scroll__notice">{copy.checkoutSoon}</p>}

      {quotas.length > 0 && (
        <section className="gift-section" aria-labelledby="gift-quotas">
          <h3 id="gift-quotas" className="gift-section__title gift-scroll__reveal">
            {copy.quotaTitle}
          </h3>
          <ul className="gift-grid">
            {quotas.map((g) => (
              <li key={g.id} className="gift-card gift-scroll__reveal">
                <GiftVisual gift={g} />
                <h4 className="gift-card__name">{g.name}</h4>
                {g.description && <p className="gift-card__desc">{g.description}</p>}
                <p className="gift-card__price">{formatBRL(quotaBaseCents(g))}</p>
                {canPay && (
                  <button type="button" className="btn btn-ink gift-card__cta" onClick={() => onPick(g.id)} aria-label={`${copy.giveButton}: ${g.name}`}>
                    {copy.giveButton}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {funds.length > 0 && (
        <section className="gift-section" aria-labelledby="gift-funds">
          <h3 id="gift-funds" className="gift-section__title gift-scroll__reveal">
            {copy.fundTitle}
          </h3>
          <p className="gift-section__hint gift-scroll__reveal">{copy.fundHint}</p>
          <ul className="gift-grid gift-grid--wide">
            {funds.map((g) => (
              <li key={g.id} className="gift-card gift-card--fund gift-scroll__reveal">
                <GiftVisual gift={g} />
                <h4 className="gift-card__name">{g.name}</h4>
                {g.description && <p className="gift-card__desc">{g.description}</p>}
                <FundProgressBar gift={g} raised={progress?.get(g.id) ?? null} />
                {canPay && (
                  <button type="button" className="btn btn-ink gift-card__cta" onClick={() => onPick(g.id)} aria-label={`${copy.contributeButton}: ${g.name}`}>
                    {copy.contributeButton}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {free.length > 0 && (
        <section className="gift-section" aria-labelledby="gift-free">
          <h3 id="gift-free" className="gift-section__title gift-scroll__reveal">
            {copy.freeTitle}
          </h3>
          <p className="gift-section__hint gift-scroll__reveal">{copy.freeHint}</p>
          <ul className="gift-free">
            {free.map((g) => {
              const url = safeHttpsUrl(g.url);
              return (
                <li key={g.id} className="gift-free__item gift-scroll__reveal">
                  <GiftVisual gift={g} />
                  <div>
                    <h4 className="gift-card__name">{g.name}</h4>
                    {g.description && <p className="gift-card__desc">{g.description}</p>}
                    {url && (
                      <a className="gift-free__link" href={url} target="_blank" rel="noopener noreferrer">
                        <ExternalLink aria-hidden="true" size={14} />
                        {copy.freeLink(g.storeName)}
                        <span className="sr-only">(abre em nova aba)</span>
                      </a>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <div className="gift-section gift-scroll__reveal">
        <PixVault variant="scroll" />
      </div>
    </>
  );
}

function FundProgressBar({ gift, raised }: { gift: FundGift; raised: number | null }) {
  const goal = toCents(gift.goal);
  if (raised === null) return <p className="gift-card__price">{copy.goal(formatBRL(goal))}</p>;
  const pct = Math.min(100, Math.round((raised / goal) * 100));
  const text = copy.raised(formatBRL(raised), formatBRL(goal));
  return (
    <div className="gift-fund">
      <div className="gift-fund__bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-valuetext={text} aria-label={gift.name}>
        <span className="gift-fund__fill" style={{ width: `${pct}%` }} />
      </div>
      <p className="gift-fund__text">{text}</p>
    </div>
  );
}

/* ----------------------------------------------------------------------------
   Presente escolhido
   ---------------------------------------------------------------------------- */
interface GiftFormProps {
  gift: QuotaGift | FundGift | FreeGift;
  demo: boolean;
  onBack: () => void;
  onSimulated: () => void;
}

type Status = { kind: 'idle' } | { kind: 'sending'; method: PaymentMethod } | { kind: 'error'; text: string };

const METHOD_ICONS: Record<PaymentMethod, LucideIcon> = { pix: QrCode, card: CreditCard };

function GiftForm({ gift, demo, onBack, onSimulated }: GiftFormProps) {
  const [amountText, setAmountText] = useState('');
  const [amountTouched, setAmountTouched] = useState(false);
  const [withMessage, setWithMessage] = useState(false);
  const [message, setMessage] = useState('');
  const [signMode, setSignMode] = useState<'name' | 'secret'>('name');
  const [signature, setSignature] = useState('');
  const [signatureError, setSignatureError] = useState(false);
  const [honeypot, setHoneypot] = useState('');
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const amountRef = useRef<HTMLInputElement>(null);
  const signatureRef = useRef<HTMLInputElement>(null);

  if (gift.kind === 'free') return null;
  const isFund = gift.kind === 'fund';
  const amountCents = isFund ? parseReais(amountText) : quotaBaseCents(gift);
  const amountProblem = isFund ? fundAmountError(amountCents, giftsConfig) : null;
  // Total de cada botão (Pix / cartão); na vaquinha, só com um valor válido.
  const totals = amountProblem || amountCents === null ? null : chargePerMethod(amountCents, giftsConfig);
  const min = formatBRL(toCents(giftsConfig.fundMin));
  const max = formatBRL(toCents(giftsConfig.fundMax));
  const amountMessage =
    amountProblem === 'min' ? copy.amountErrors.min(min) : amountProblem === 'max' ? copy.amountErrors.max(max) : copy.amountErrors.invalid;
  const showAmountError = isFund && amountTouched && amountProblem !== null;
  const hasMessage = withMessage && message.trim().length > 0;

  // Enter num campo não paga: só confere o valor (pagar é sempre por um dos dois botões).
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (isFund) setAmountTouched(amountText.trim().length > 0);
  };

  const pay = async (method: PaymentMethod) => {
    if (status.kind === 'sending') return;
    if (isFund && amountProblem) {
      setAmountTouched(true);
      amountRef.current?.focus();
      return;
    }
    if (hasMessage && signMode === 'name' && !signature.trim()) {
      setSignatureError(true);
      signatureRef.current?.focus();
      return;
    }
    if (simulateCheckout(demo)) {
      onSimulated();
      return;
    }
    const endpoint = checkoutEndpoint();
    if (!endpoint) return;
    setStatus({ kind: 'sending', method });
    const result = await startCheckout(endpoint, {
      giftId: gift.id,
      method,
      ...(isFund ? { amountCents: amountCents! } : {}),
      message: hasMessage ? message : null,
      signature: hasMessage && signMode === 'name' ? signature : null,
      anonymous: hasMessage && signMode === 'secret',
      website: honeypot,
    });
    if (result.ok) {
      // Fica "abrindo…" até o navegador sair para o Asaas.
      window.location.assign(result.url);
      return;
    }
    if (result.error === 'signature_required') {
      setStatus({ kind: 'idle' });
      setSignatureError(true);
      return;
    }
    setStatus({ kind: 'error', text: result.error === 'busy' ? copy.checkoutErrors.busy : copy.checkoutErrors.generic });
  };

  return (
    <>
      <button type="button" className="gift-back gift-scroll__reveal" onClick={onBack}>
        <ChevronLeft aria-hidden="true" size={18} />
        {copy.back}
      </button>
      <ScrollHeader title={gift.name}>{gift.description && <p className="gift-scroll__intro">{gift.description}</p>}</ScrollHeader>

      <form className="gift-form gift-scroll__reveal" onSubmit={submit} noValidate>
        <div className="gift-form__summary">
          <GiftVisual gift={gift} large />
          {isFund ? (
            <div className="gift-form__field">
              <label htmlFor="gift-amount">{copy.amountLabel}</label>
              <div className="gift-form__money">
                <span aria-hidden="true">R$</span>
                <input
                  ref={amountRef}
                  id="gift-amount"
                  inputMode="decimal"
                  autoComplete="off"
                  value={amountText}
                  onChange={(e) => setAmountText(e.target.value)}
                  onBlur={() => setAmountTouched(amountText.trim().length > 0)}
                  aria-invalid={showAmountError || undefined}
                  aria-describedby="gift-amount-hint"
                  maxLength={12}
                  placeholder="100"
                />
              </div>
              <p id="gift-amount-hint" className={showAmountError ? 'gift-form__error' : 'gift-form__hint'}>
                {showAmountError ? amountMessage : copy.amountHint(min, max)}
              </p>
            </div>
          ) : null}
          {!isFund && <p className="gift-form__price">{formatBRL(amountCents!)}</p>}
        </div>

        <label className="gift-form__check">
          <input type="checkbox" checked={withMessage} onChange={(e) => setWithMessage(e.target.checked)} />
          {copy.messageToggle}
        </label>

        {withMessage && (
          <fieldset className="gift-form__message">
            <legend className="sr-only">{copy.messageLabel}</legend>
            <div className="gift-form__field">
              <label htmlFor="gift-message">{copy.messageLabel}</label>
              <textarea
                id="gift-message"
                rows={5}
                maxLength={GIFT_MESSAGE_MAX}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                aria-describedby="gift-message-count gift-privacy"
              />
              <p id="gift-message-count" className="gift-form__hint gift-form__count">
                {copy.messageCount(message.length, GIFT_MESSAGE_MAX)}
              </p>
            </div>

            <div className="gift-form__sign" role="radiogroup" aria-label={copy.signAs}>
              <label className="gift-form__radio">
                <input type="radio" name="gift-sign" checked={signMode === 'name'} onChange={() => setSignMode('name')} />
                {copy.signAs}
              </label>
              <input
                ref={signatureRef}
                className="gift-form__signature"
                aria-label={copy.signAs}
                placeholder={copy.signAsPlaceholder}
                autoComplete="name"
                maxLength={GIFT_SIGNATURE_MAX}
                value={signature}
                disabled={signMode !== 'name'}
                onChange={(e) => {
                  setSignature(e.target.value);
                  setSignatureError(false);
                }}
                aria-invalid={signatureError || undefined}
                aria-describedby={signatureError ? 'gift-signature-error' : undefined}
              />
              <label className="gift-form__radio">
                <input
                  type="radio"
                  name="gift-sign"
                  checked={signMode === 'secret'}
                  onChange={() => {
                    setSignMode('secret');
                    setSignatureError(false);
                  }}
                />
                {copy.secret}
              </label>
              {signatureError && (
                <p id="gift-signature-error" className="gift-form__error">
                  {copy.signatureMissing}
                </p>
              )}
            </div>
            <p id="gift-privacy" className="gift-form__hint">
              {copy.privacy}
            </p>
          </fieldset>
        )}

        {/* Campo-isca: escondido de pessoas e leitores de tela; robôs costumam preencher. */}
        <div className="gift-form__hp" aria-hidden="true">
          <label>
            Site
            <input tabIndex={-1} autoComplete="off" value={honeypot} onChange={(e) => setHoneypot(e.target.value)} />
          </label>
        </div>

        <fieldset className="gift-pay">
          <legend className="gift-pay__title">{copy.payTitle}</legend>
          <div className="gift-pay__options">
            {(['pix', 'card'] as const).map((method) => {
              const Icon = METHOD_ICONS[method];
              const sending = status.kind === 'sending' && status.method === method;
              return (
                <button
                  key={method}
                  type="button"
                  className={`btn btn-gold gift-pay__btn gift-pay__btn--${method}`}
                  disabled={status.kind === 'sending'}
                  onClick={() => pay(method)}
                >
                  {sending ? <LoaderCircle aria-hidden="true" size={20} className="gift-form__spin" /> : <Icon aria-hidden="true" size={20} strokeWidth={1.6} />}
                  <span className="gift-pay__label">{method === 'pix' ? copy.payPix : copy.payCard(giftsConfig.maxInstallments)}</span>
                  {totals && <span className="gift-pay__total">{formatBRL(totals[method])}</span>}
                </button>
              );
            })}
          </div>
          <p className="gift-form__hint gift-pay__note" aria-live="polite">
            {totals ? copy.payFeesNote : copy.payAmountFirst}
          </p>
        </fieldset>
        <p className="gift-form__note">{copy.checkoutNote}</p>
        <p className="gift-form__status" role="status" aria-live="polite">
          {status.kind === 'error' ? status.text : status.kind === 'sending' ? copy.redirecting : ''}
        </p>
      </form>
    </>
  );
}

/* ----------------------------------------------------------------------------
   Agradecimento (volta do Asaas)
   ---------------------------------------------------------------------------- */
function ThanksView({ demo, onBack, onClose }: { demo: boolean; onBack: () => void; onClose: () => void }) {
  return (
    <div className="gift-thanks">
      <WaxSeal className="gift-thanks__seal gift-scroll__reveal" />
      <h2 id="gift-scroll-title" className="gift-scroll__title gift-scroll__reveal" tabIndex={-1} data-autofocus>
        {copy.thanksTitle}
      </h2>
      <Divider className="gift-scroll__divider gift-scroll__reveal" />
      <p className="gift-thanks__text gift-scroll__reveal">{copy.thanksText}</p>
      {demo && <p className="notice notice-pending gift-scroll__notice">{copy.demoNotice}</p>}
      <div className="gift-thanks__actions gift-scroll__reveal">
        <button type="button" className="btn btn-ink" onClick={onBack}>
          {copy.back}
        </button>
        <button type="button" className="gift-back" onClick={onClose}>
          {copy.closeShort}
        </button>
      </div>
    </div>
  );
}
