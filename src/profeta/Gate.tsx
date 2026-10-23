import { useState, type FormEvent } from 'react';
import { profetaTexts } from '../content/profeta';
import { login, ProfetaError, type SessionInfo } from '../lib/profeta';

const t = profetaTexts.gate;

/** Porta do jornal: a palavra mágica do cartão da mesa vira um cookie de 60 dias. */
export function Gate({ onEnter }: { onEnter: (session: SessionInfo) => void }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!password.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      onEnter(await login(password));
    } catch (err) {
      const code = err instanceof ProfetaError ? err.code : 'rede';
      setError(code === 'senha_errada' ? t.wrong : code === 'devagar' ? t.slow : t.offline);
      setBusy(false);
    }
  };

  return (
    <form className="profeta-gate" onSubmit={submit}>
      <h2 className="profeta-gate__title">{t.title}</h2>
      <p className="profeta-gate__intro">{t.intro}</p>
      <label className="profeta-field">
        <span>{t.label}</span>
        <input
          type="text"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          enterKeyHint="go"
          maxLength={80}
          required
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? 'profeta-gate-error' : undefined}
        />
      </label>
      {error && (
        <p id="profeta-gate-error" className="profeta-error" role="alert">
          {error}
        </p>
      )}
      <button type="submit" className="profeta-btn" disabled={busy}>
        {t.submit}
      </button>
    </form>
  );
}
