import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router';

import App from './App';
import { setCadDevelopmentChecks } from './domain/cad/cadDevelopmentChecks';
import './index.css';

setCadDevelopmentChecks(import.meta.env.DEV);

const root = document.getElementById('root');

if (!root) {
  throw new Error('Root element #root was not found.');
}

const router = createBrowserRouter([{ path: '*', element: <App /> }], { basename: import.meta.env.BASE_URL });

createRoot(root).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>
);
