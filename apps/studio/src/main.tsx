import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { EditorProvider, documentFromTemplate, blankDocument } from './state/store';
import { TEMPLATES } from '@artboard/templates';
import './styles.css';

function initialDocument() {
  const list = TEMPLATES as any[];
  if (list && list.length) {
    try { return documentFromTemplate(list[0]!); } catch { /* fall through to blank */ }
  }
  return blankDocument(1080, 1080, 'Untitled');
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <EditorProvider initial={initialDocument()}>
      <App />
    </EditorProvider>
  </React.StrictMode>,
);
