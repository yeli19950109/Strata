import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { EngineFolderChoice } from '../../../src/components/EngineFolderChoice';
import '../../../src/styles/kit/tokens.css';
import '../../../src/styles/kit/components.css';
import '../../../src/styles/app.css';
import '../../../src/styles/annotation-fixes.css';
function App(){const [open,setOpen]=useState(false);return <><button onClick={()=>setOpen(true)}>Open engine settings</button><EngineFolderChoice open={open} onClose={()=>setOpen(false)}/></>;}
createRoot(document.getElementById('root')!).render(<App/>);
