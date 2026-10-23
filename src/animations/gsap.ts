import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

gsap.registerPlugin(ScrollTrigger);

// A barra de endereço do celular aparece/some ao rolar: evita recálculos
// desnecessários (e saltos) quando apenas a altura da viewport muda.
ScrollTrigger.config({ ignoreMobileResize: true });
gsap.defaults({ ease: 'power2.out', duration: 0.8 });

export { gsap, ScrollTrigger };
