import { HogwartsCrest } from '../ui/HogwartsCrest';
import { WaxSeal } from '../ui/WaxSeal';
import './envelope.css';

interface EnvelopeProps {
  address: string[];
}

/**
 * Envelope construído em camadas animáveis (todas <span>, pois vive dentro
 * de um <button>):  fundo → carta → bolso frontal → aba 3D → selo de cera.
 * Os atributos data-env-* são os alvos da timeline de abertura.
 */
export function Envelope({ address }: EnvelopeProps) {
  return (
    <span className="envelope" data-env>
      <span className="envelope__shadow" data-env-fade />
      <span className="envelope__back" data-env-fade />

      <span className="envelope__letter" data-env-letter>
        <span className="envelope__letter-paper parchment">
          <HogwartsCrest className="envelope__letter-crest" />
          <span className="envelope__letter-kicker">Convite</span>
          <span className="envelope__letter-lines" />
        </span>
      </span>

      <span className="envelope__front" data-env-fade>
        <span className="envelope__pocket parchment" />
        <span className="envelope__shade envelope__shade--left" />
        <span className="envelope__shade envelope__shade--right" />
        <span className="envelope__shade envelope__shade--bottom" />
        <svg className="envelope__folds" viewBox="0 0 148 100" preserveAspectRatio="none" aria-hidden="true">
          <path d="M0 100 L74 57 L148 100" fill="none" stroke="rgba(92,58,24,.42)" strokeWidth=".45" vectorEffect="non-scaling-stroke" />
          <path d="M0 0 L74 57 L148 0" fill="none" stroke="rgba(92,58,24,.22)" strokeWidth=".45" vectorEffect="non-scaling-stroke" />
        </svg>
        <span className="envelope__address">
          {address.map((line) => (
            <span key={line}>{line}</span>
          ))}
        </span>
      </span>

      <span className="envelope__flap" data-env-flap data-env-fade>
        <span className="envelope__flap-face envelope__flap-face--front parchment" />
        <span className="envelope__flap-face envelope__flap-face--back" />
      </span>

      <span className="envelope__seal" data-env-seal>
        <span className="envelope__seal-glow" data-env-seal-glow />
        <span className="envelope__seal-pulse" />
        <span className="envelope__seal-half envelope__seal-half--left" data-env-seal-left>
          <WaxSeal />
        </span>
        <span className="envelope__seal-half envelope__seal-half--right" data-env-seal-right>
          <WaxSeal />
        </span>
      </span>
    </span>
  );
}
