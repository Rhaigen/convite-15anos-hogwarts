import { useEffect, useRef, useState, type Ref } from 'react';
import { Check, Copy, KeyRound, LockKeyhole, MessageCircleHeart } from 'lucide-react';
import { gsap } from '../../animations/gsap';
import { useEffects } from '../../components/effects/EffectsContext';
import { pixConfig, rsvpConfig } from '../../content/settings';
import { gifts as copy, rsvp } from '../../content/texts';
import { copyText } from '../../lib/clipboard';
import { resolvePix } from '../../lib/pix';
import { whatsappUrl } from '../../lib/whatsapp';

type CopyTarget = 'key' | 'payload';

/** Porta circular de cofre (decorativa) — gira ao copiar a chave. */
function VaultDoor({ wheelRef }: { wheelRef: Ref<SVGGElement> }) {
  const bolts = Array.from({ length: 12 }, (_, i) => (i / 12) * 360);
  return (
    <svg className="vault__door" viewBox="-100 -100 200 200" aria-hidden="true" focusable="false">
      <defs>
        <radialGradient id="vault-metal" cx="35%" cy="30%" r="80%">
          <stop offset="0" stopColor="#f6d98a" />
          <stop offset=".45" stopColor="#a87b31" />
          <stop offset="1" stopColor="#4a3010" />
        </radialGradient>
      </defs>
      <circle r="96" fill="url(#vault-metal)" />
      <circle r="84" fill="#2a1408" opacity=".55" />
      <circle r="80" fill="url(#vault-metal)" />
      {bolts.map((deg) => (
        <circle key={deg} cx="0" cy="-88" r="4" fill="#5c3d12" stroke="#f6d98a" strokeWidth=".8" transform={`rotate(${deg})`} />
      ))}
      <circle r="52" fill="none" stroke="#5c3d12" strokeWidth="2" opacity=".7" />
      <g ref={wheelRef}>
        {[0, 60, 120].map((deg) => (
          <rect key={deg} x="-4" y="-46" width="8" height="92" rx="4" fill="#5c3d12" transform={`rotate(${deg})`} />
        ))}
        <circle r="16" fill="url(#vault-metal)" stroke="#5c3d12" strokeWidth="2" />
        <text y="6" textAnchor="middle" fontFamily="'Cinzel Variable', Cinzel, Georgia, serif" fontSize="17" fontWeight="700" fill="#4a2d0a">
          S
        </text>
      </g>
    </svg>
  );
}

/**
 * Pix direto da família ("qualquer quantia", sem custos): só exibe chave e QR Code quando
 * configurados. `variant="scroll"`: versão compacta dentro do pergaminho da lista de
 * presentes, com o aviso de que o Pix não leva mensagem (o recado vai pela Aifos).
 */
export function PixVault({ variant }: { variant?: 'scroll' } = {}) {
  const pix = resolvePix(pixConfig);
  const [copied, setCopied] = useState<CopyTarget | null>(null);
  const [failed, setFailed] = useState(false);
  const [qr, setQr] = useState<string | null>(null);
  const wheelRef = useRef<SVGGElement>(null);
  const { reducedMotion } = useEffects();
  const payload = pix?.payload ?? null;

  // QR Code gerado localmente (biblioteca carregada sob demanda), apenas com dados reais.
  useEffect(() => {
    if (pixConfig.qrCodeImage || !payload) return;
    let cancelled = false;
    import('qrcode')
      .then((QR) =>
        QR.toString(payload, { type: 'svg', errorCorrectionLevel: 'M', margin: 1, color: { dark: '#1b0f0c', light: '#fffaf0' } }),
      )
      .then((svg) => {
        if (!cancelled) setQr(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
      })
      .catch(() => {
        if (!cancelled) setQr(null);
      });
    return () => {
      cancelled = true;
    };
  }, [payload]);

  useEffect(() => {
    if (!copied && !failed) return;
    const t = window.setTimeout(() => {
      setCopied(null);
      setFailed(false);
    }, 3000);
    return () => window.clearTimeout(t);
  }, [copied, failed]);

  const handleCopy = async (target: CopyTarget, text: string) => {
    const ok = await copyText(text);
    setCopied(ok ? target : null);
    setFailed(!ok);
    if (ok && wheelRef.current && !reducedMotion) {
      gsap.to(wheelRef.current, { rotation: '+=240', svgOrigin: '0 0', duration: 1.2, ease: 'back.out(1.4)' });
    }
  };

  if (!pixConfig.enabled) return null;
  const qrSrc = pixConfig.qrCodeImage ?? qr;
  const messageUrl = whatsappUrl(rsvpConfig.whatsappNumber, rsvp.messageGreeting);

  return (
    <article className={`vault${variant ? ` vault--${variant}` : ''}`} aria-labelledby="pix-title">
      <VaultDoor wheelRef={wheelRef} />
      <div className="vault__body">
        <h3 id="pix-title" className="vault__title">
          {copy.pixTitle}
        </h3>

        {!pix ? (
          <p className="vault__pending">
            <LockKeyhole aria-hidden="true" size={18} />
            {copy.pixPending}
          </p>
        ) : (
          <>
            <p className="vault__intro">{copy.pixIntro}</p>
            <dl className="vault__data">
              {pix.recipientName && (
                <div>
                  <dt>Recebedor</dt>
                  <dd>{pix.recipientName}</dd>
                </div>
              )}
              {pix.city && (
                <div>
                  <dt>Cidade</dt>
                  <dd>{pix.city}</dd>
                </div>
              )}
              <div>
                <dt>Chave Pix · {pix.keyTypeLabel}</dt>
                <dd className="vault__key">{pix.key}</dd>
              </div>
            </dl>

            <div className="vault__actions">
              <button type="button" className="btn btn-gold" onClick={() => handleCopy('key', pix.key)}>
                {copied === 'key' ? <Check aria-hidden="true" size={17} /> : <KeyRound aria-hidden="true" size={17} />}
                {copied === 'key' ? 'Chave copiada' : 'Copiar chave Pix'}
              </button>
              {payload && (
                <button type="button" className="btn btn-ghost" onClick={() => handleCopy('payload', payload)}>
                  {copied === 'payload' ? <Check aria-hidden="true" size={17} /> : <Copy aria-hidden="true" size={17} />}
                  {copied === 'payload' ? 'Código copiado' : 'Copiar Pix Copia e Cola'}
                </button>
              )}
            </div>
            <p className="vault__feedback" role="status" aria-live="polite">
              {copied === 'key' && 'Chave Pix copiada para a área de transferência.'}
              {copied === 'payload' && 'Código Pix Copia e Cola copiado. Cole no app do seu banco.'}
              {failed && 'Não foi possível copiar automaticamente. Selecione a chave acima e copie manualmente.'}
            </p>

            {qrSrc && (
              <figure className="vault__qr">
                <img src={qrSrc} width={180} height={180} alt={`QR Code Pix para presentear ${pix.recipientName ?? 'a aniversariante'}`} />
                <figcaption>Aponte a câmera do app do seu banco</figcaption>
              </figure>
            )}

            {variant === 'scroll' && (
              <p className="vault__note">
                {copy.pixNoMessage}{' '}
                {messageUrl && (
                  <a href={messageUrl} target="_blank" rel="noopener noreferrer">
                    <MessageCircleHeart aria-hidden="true" size={15} />
                    {copy.pixMessageLink}
                    <span className="sr-only">(abre o WhatsApp em uma nova aba)</span>
                  </a>
                )}
              </p>
            )}
          </>
        )}
      </div>
    </article>
  );
}
