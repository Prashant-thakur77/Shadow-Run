import './styles/fonts.css';
import './styles/tokens.css';
import './styles/base.css';
import './styles/type.css';
import './styles/shell.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
