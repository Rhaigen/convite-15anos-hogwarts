import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import '@fontsource-variable/cinzel/wght.css';
import '@fontsource/cormorant-garamond/400.css';
import '@fontsource/cormorant-garamond/500.css';
import '@fontsource/cormorant-garamond/600.css';
import '@fontsource/cormorant-garamond/400-italic.css';
import '@fontsource/cormorant-garamond/500-italic.css';
import '@fontsource/cormorant-garamond/600-italic.css';
import '@fontsource-variable/inter/wght.css';
import '@fontsource/pinyon-script/400.css';
import './styles/globals.css';

import { EffectsProvider } from './components/effects/EffectsContext';
import { App } from './app/App';

const root = document.getElementById('root');
if (!root) throw new Error('Elemento #root não encontrado.');

createRoot(root).render(
  <StrictMode>
    <EffectsProvider>
      <App />
    </EffectsProvider>
  </StrictMode>,
);
