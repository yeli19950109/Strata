import React from 'react';
import { createRoot } from 'react-dom/client';
import { LegacyRunModels } from '../../../src/components/LegacyRunModels';
import '../../../src/styles/kit/tokens.css';
import '../../../src/styles/kit/components.css';
import '../../../src/styles/app.css';
import '../../../src/styles/annotation-fixes.css';
createRoot(document.getElementById('root')!).render(<LegacyRunModels/>);
