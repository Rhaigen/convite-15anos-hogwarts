import { useEffect, useState, type RefObject } from 'react';

/** Indica se o elemento está perto/dentro da área visível (IntersectionObserver). */
export function useInView(ref: RefObject<Element | null>, rootMargin = '200px 0px'): boolean {
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') {
      setInView(true);
      return;
    }
    // Um mesmo aviso pode trazer mais de uma entrada (ex.: [fora, dentro] num salto de rolagem): vale a última.
    const observer = new IntersectionObserver((entries) => setInView(entries.at(-1)?.isIntersecting ?? false), { rootMargin });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, rootMargin]);
  return inView;
}
