import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ExternalEngineChoice } from '../../../src/components/ExternalEngineChoice';
import '../../../src/styles/kit/tokens.css';
import '../../../src/styles/kit/components.css';
import '../../../src/styles/app.css';
import '../../../src/styles/annotation-fixes.css';
function App(){const [mode,setMode]=useState<'settings'|'update'|null>(null);return <><button onClick={()=>setMode('settings')}>Open engine settings</button><button onClick={()=>setMode('update')}>Open engine update</button><ExternalEngineChoice open={mode==='settings'} onClose={()=>setMode(null)}/><ExternalEngineChoice mode="update" open={mode==='update'} onClose={()=>setMode(null)}/></>;}
createRoot(document.getElementById('root')!).render(<App/>);
