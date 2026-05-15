import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { installStrudelLogCapture } from './audio/strudelLog.js';

installStrudelLogCapture();

const root = createRoot(document.getElementById('root')!);
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
