import { useEffect, useRef, useState, type ChangeEvent, type CSSProperties } from 'react';
import { Camera } from 'lucide-react';
import { profetaConfig, profetaTexts } from '../content/profeta';
import {
  isRetryable,
  kindOf,
  loadAuthor,
  preparePhoto,
  ProfetaError,
  retryDelayMs,
  saveAuthor,
  uploadFile,
  videoDuration,
  type WindowState,
} from '../lib/profeta';

const t = profetaTexts.sender;

type JobStatus = 'waiting' | 'preparing' | 'sending' | 'retrying' | 'sent' | 'failed';

interface Job {
  key: string;
  file: File;
  kind: 'foto' | 'video';
  status: JobStatus;
  progress: number;
  note: string | null;
  preview: string | null;
}

const errorText = (code: string) => (profetaTexts.errors as Record<string, string | undefined>)[code] ?? profetaTexts.errors.desconhecido;
const wait = (ms: number) => new Promise((r) => window.setTimeout(r, ms));

interface SenderProps {
  janela: WindowState;
  /** Um envio terminou: o jornal procura a foto nova. */
  onSent: () => void;
  /** A sessão expirou: volta para a porta. */
  onSessionLost: () => void;
}

/**
 * "Mande sua fotografia": escolhe vários arquivos, reduz as fotos no celular e envia um por vez,
 * tentando de novo quando a internet da festa cai. Mostra o que realmente aconteceu com cada um.
 */
export function Sender({ janela, onSent, onSessionLost }: SenderProps) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [author, setAuthor] = useState(loadAuthor);
  const [caption, setCaption] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const running = useRef(false);
  const queue = useRef<Job[]>([]);
  const previews = useRef<string[]>([]);
  const meta = useRef({ author, caption });
  meta.current = { author, caption };

  useEffect(() => () => previews.current.forEach((url) => URL.revokeObjectURL(url)), []);

  const patch = (key: string, change: Partial<Job>) => setJobs((list) => list.map((j) => (j.key === key ? { ...j, ...change } : j)));

  async function send(job: Job): Promise<'ok' | 'stop' | 'next'> {
    patch(job.key, { status: 'preparing', note: null });
    let body: Blob = job.file;
    if (job.kind === 'foto') {
      body = await preparePhoto(job.file);
      if (body.size > profetaConfig.maxPhotoBytes) return fail(job, 'grande_demais');
    } else {
      if (job.file.size > profetaConfig.maxVideoBytes) return fail(job, 'grande_demais');
      const seconds = await videoDuration(job.file);
      if (seconds !== null && seconds > profetaConfig.maxVideoSeconds + 0.5) patch(job.key, { note: t.longVideo });
    }
    for (let attempt = 0; ; attempt++) {
      patch(job.key, { status: attempt === 0 ? 'sending' : 'retrying', progress: 0 });
      try {
        await uploadFile(body, { tipo: job.kind, autor: meta.current.author, legenda: meta.current.caption }, (p) => patch(job.key, { progress: p, status: 'sending' }));
        patch(job.key, { status: 'sent', progress: 1 });
        return 'ok';
      } catch (error) {
        if (error instanceof ProfetaError && error.code === 'sem_sessao') {
          fail(job, 'sem_sessao');
          return 'stop';
        }
        if (attempt < profetaConfig.retries && isRetryable(error)) {
          patch(job.key, { status: 'retrying' });
          await wait(retryDelayMs(attempt + 1));
          continue;
        }
        return fail(job, error instanceof ProfetaError ? error.code : 'desconhecido');
      }
    }
  }

  function fail(job: Job, code: string): 'next' {
    patch(job.key, { status: 'failed', note: errorText(code) });
    return 'next';
  }

  async function run() {
    if (running.current) return;
    running.current = true;
    try {
      while (queue.current.length > 0) {
        const job = queue.current.shift()!;
        const result = await send(job);
        if (result === 'ok') onSent();
        if (result === 'stop') {
          queue.current = [];
          onSessionLost();
        }
      }
    } finally {
      running.current = false;
    }
  }

  const pick = (e: ChangeEvent<HTMLInputElement>) => {
    const files = [...(e.target.files ?? [])];
    e.target.value = '';
    saveAuthor(author);
    const fresh: Job[] = [];
    for (const file of files) {
      const kind = kindOf(file);
      const key = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      if (!kind) {
        fresh.push({ key, file, kind: 'foto', status: 'failed', progress: 0, note: profetaTexts.errors.formato_nao_aceito, preview: null });
        continue;
      }
      const job: Job = { key, file, kind, status: 'waiting', progress: 0, note: null, preview: kind === 'foto' ? URL.createObjectURL(file) : null };
      if (job.preview) previews.current.push(job.preview);
      fresh.push(job);
      queue.current.push(job);
    }
    setJobs((list) => [...fresh.reverse(), ...list].slice(0, 60));
    void run();
  };

  if (janela !== 'aberta') {
    return (
      <aside className="profeta-sender profeta-sender--quiet" aria-live="polite">
        <p>{janela === 'antes' ? t.before : t.closed}</p>
      </aside>
    );
  }

  return (
    <aside className="profeta-sender" aria-labelledby="profeta-sender-title">
      <h2 id="profeta-sender-title" className="profeta-sender__title">
        {t.title}
      </h2>
      <p className="profeta-sender__intro">{t.intro}</p>
      <div className="profeta-sender__fields">
        <label className="profeta-field">
          <span>{t.nameLabel}</span>
          <input type="text" value={author} onChange={(e) => setAuthor(e.target.value)} onBlur={() => saveAuthor(author)} placeholder={t.namePlaceholder} maxLength={60} autoComplete="name" />
        </label>
        <label className="profeta-field">
          <span>{t.captionLabel}</span>
          <input type="text" value={caption} onChange={(e) => setCaption(e.target.value)} placeholder={t.captionPlaceholder} maxLength={140} />
        </label>
      </div>
      <input ref={input} className="sr-only" type="file" accept="image/*,video/*" multiple onChange={pick} tabIndex={-1} aria-hidden="true" />
      <button type="button" className="profeta-btn profeta-btn--big" onClick={() => input.current?.click()}>
        <Camera aria-hidden="true" size={22} strokeWidth={1.6} />
        {t.pick}
      </button>
      <p className="profeta-sender__hint">{t.whatsapp}</p>

      {jobs.length > 0 && (
        <ul className="profeta-jobs" aria-live="polite">
          {jobs.map((job) => (
            <li key={job.key} className={`profeta-job profeta-job--${job.status}`}>
              {job.preview ? (
                <img src={job.preview} alt="" className="profeta-job__thumb" />
              ) : (
                <span className="profeta-job__thumb profeta-job__thumb--video" aria-hidden="true">
                  {job.kind === 'video' && job.status !== 'failed' ? '▶' : '·'}
                </span>
              )}
              <span className="profeta-job__name">{job.file.name}</span>
              <span className="profeta-job__status">
                {t.status[job.status]}
                {job.status === 'sending' && job.progress > 0 ? ` ${Math.round(job.progress * 100)}%` : ''}
                {job.note ? ` · ${job.note}` : ''}
              </span>
              {(job.status === 'sending' || job.status === 'preparing') && (
                <span className="profeta-job__bar" style={{ '--p': job.progress } as CSSProperties} aria-hidden="true" />
              )}
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}
