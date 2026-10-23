import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import '@fontsource-variable/cinzel/wght.css';
import '@fontsource/cormorant-garamond/500.css';
import '@fontsource/cormorant-garamond/600.css';
import '@fontsource/cormorant-garamond/500-italic.css';
import '@fontsource-variable/inter/wght.css';
import './profeta.css';

import { EffectsProvider } from '../components/effects/EffectsContext';
import { ProfetaApp } from './ProfetaApp';

const root = document.getElementById('root');
if (!root) throw new Error('Elemento #root não encontrado.');

createRoot(root).render(
  <StrictMode>
    <EffectsProvider>
      <ProfetaApp />
    </EffectsProvider>
  </StrictMode>,
);
