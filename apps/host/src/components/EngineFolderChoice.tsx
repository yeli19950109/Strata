import { useEffect, useRef, useState } from 'react';
import { tr } from '../lib/i18n';
import { api } from '../lib/client';
import { refreshNative } from '../lib/native';
import { Btn, Dialog } from './ui';

type Folder = { selected:boolean; usable:boolean; path:string|null; notice:string|null; cancelled?:boolean };

/** Settings: the engine folder. A folder the person chooses is the app's engine folder from then on, the same as the one the app made: engines are started, updated and rolled back there. */
export function EngineFolderChoice({open,onClose,onDone}:{open:boolean;onClose:()=>void;onDone?:()=>void}) {
    const [busy,setBusy]=useState(false), [error,setError]=useState(''), [current,setCurrent]=useState<Folder|null>(null);
    const lock=useRef(false);
    async function guarded(fn:()=>Promise<void>) { if(lock.current)return;lock.current=true;setBusy(true);setError('');try{await fn();}catch(e){setError(e instanceof Error?e.message:String(e));}finally{lock.current=false;setBusy(false);} }
    useEffect(()=>{if(!open)return;setError('');let live=true;void api.get<Folder>('/api/native/engine-folder').then(s=>{if(live)setCurrent(s);}).catch(e=>{if(live)setError(e.message);});return ()=>{live=false;};},[open]);
    async function choose() {await guarded(async()=>{const result=await api.post<Folder>('/api/native/engine-folder',{});setCurrent(result);if(result.cancelled)return;void refreshNative(true).catch(()=>{});onClose();onDone?.();});}
    async function reset() {await guarded(async()=>{setCurrent(await api.del<Folder>('/api/native/engine-folder'));void refreshNative(true).catch(()=>{});});}
    const close=()=>{if(!lock.current)onClose();};
    return <Dialog open={open} onClose={close} title={tr('Engine folder')} actions={<><Btn onClick={close} disabled={busy}>{tr('Close')}</Btn><Btn variant="primary" disabled={busy} onClick={()=>void choose()}>{tr('Choose engine folder…')}</Btn></>}>
      <div className="stack">
        <p>{tr('Choose the folder that holds your engine. Strata then uses it as its own engine folder: it starts, updates and rolls back the engine there, the same as the engine Strata installed itself.')}</p>
        <p className="small" style={{overflowWrap:'anywhere'}} role="status">{current?.selected?<>{tr('Engine folder')}: {current.path}{current.notice?<><br/>{tr(current.notice)}</>:null}</>:tr('Strata uses its own engine folder.')}</p>
        {current?.selected?<div><Btn disabled={busy} onClick={()=>void reset()}>{tr('Use Strata’s own engine folder')}</Btn></div>:null}
        {error?<p role="alert" className="inline-error">{error}</p>:null}
      </div>
    </Dialog>;
}
