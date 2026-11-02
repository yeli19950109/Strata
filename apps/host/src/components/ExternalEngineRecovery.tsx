import { useEffect, useState } from 'react';
import { api } from '../lib/client';
import { tr } from '../lib/i18n';
import { refreshNative } from '../lib/native';
import { Btn, Dialog } from './ui';

/** Keep interrupted writes visible across app restarts until restored. */
export function ExternalEngineRecovery() {
    const [retained,setRetained]=useState<string[]|null>(null);
    const [pending,setPending]=useState(false), [busy,setBusy]=useState(false), [error,setError]=useState('');
    useEffect(()=>{let live=true;const poll=()=>api.get<{pendingRecovery:boolean}>('/api/native/external-engine/update/status').then(r=>{if(live)setPending(r.pendingRecovery);}).catch(()=>{});void poll();const id=setInterval(()=>void poll(),3000);return()=>{live=false;clearInterval(id);};},[]);
    async function recover(){setBusy(true);setError('');try{const result=await api.post<{retainedAdditions?:string[]}>('/api/native/external-engine/update/recover');setRetained(result.retainedAdditions??[]);setPending(false);void refreshNative(true).catch(()=>{});}catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}}
    return <Dialog open={pending || retained!==null} title={tr('Restore the interrupted engine update')} onClose={()=>{if(!pending)setRetained(null);}} actions={retained!==null ? <Btn variant="primary" onClick={()=>setRetained(null)}>{tr('Done')}</Btn> : <Btn variant="primary" disabled={busy} onClick={()=>void recover()}>{tr('Restore the engine backup')}</Btn>}>
      {retained!==null ? <><p>{tr('The interrupted external engine update was restored.')}</p>{retained.length ? <><p>{tr('Files added by the update were kept to avoid deleting your files. Review them before retrying; they may block another update:')}</p><ul>{retained.map(p=><li key={p}>{p}</li>)}</ul></> : null}</> : <p>{tr('An external engine update was interrupted. Restore its verified backup before loading or changing models. Reconnect its drive first if needed.')}</p>}
      {busy ? <p role="status">{tr('Restoring the engine…')}</p> : null}{error ? <p role="alert" className="inline-error">{error}</p> : null}
    </Dialog>;
}
