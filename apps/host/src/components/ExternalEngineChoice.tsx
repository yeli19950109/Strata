import { useEffect, useState } from 'react';
import { tr } from '../lib/i18n';
import { api } from '../lib/client';
import { refreshNative } from '../lib/native';
import { Btn, Dialog } from './ui';

export function ExternalEngineChoice({open,onClose,onDone}:{open:boolean;onClose:()=>void;onDone?:()=>void}) {
    const [path,setPath]=useState(''), [busy,setBusy]=useState(false), [error,setError]=useState('');
    const [retained,setRetained]=useState<string[]>([]);
    const [plan,setPlan]=useState<{path:string;currentVersion:string;targetVersion:string;downloadBytes:number;status:string;source:string;confirmationToken:string}|null>(null), [notice,setNotice]=useState('');
    const [current,setCurrent]=useState<{selected:boolean;usable:boolean;path:string|null;notice:string|null}|null>(null);
    useEffect(()=>{if(open)void api.get<typeof current>('/api/native/external-engine').then(s=>{setCurrent(s);if(s?.path)setPath(s.path);}).catch(e=>setError(e.message));},[open]);
    async function checkUpdate() {setBusy(true);setError('');setNotice('');setPlan(null);try {const p=await api.post<NonNullable<typeof plan>>('/api/native/external-engine/update/check');setPlan(p);}catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}}
    async function applyUpdate() {if(!plan)return;setBusy(true);setError('');setNotice('');try {const result=await api.post<{warning?:string}>('/api/native/external-engine/update/apply',{confirmationToken:plan.confirmationToken});setPlan(null);setNotice([tr('The external engine update completed.'),result.warning].filter(Boolean).join(' '));void refreshNative(true).catch(()=>{});}catch(e){setPlan(null);setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}}
    async function recover() {setBusy(true);setError('');setNotice('');setPlan(null);try {const result=await api.post<{retainedAdditions?:string[]}>('/api/native/external-engine/update/recover');setRetained(result.retainedAdditions??[]);setNotice(tr('The interrupted external engine update was restored.'));void refreshNative(true).catch(()=>{});}catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}}
    async function save() {
        setBusy(true);setError('');
        try {await api.post('/api/native/external-engine',{path});void refreshNative(true).catch(()=>{});onClose();onDone?.();}
        catch(e) {setError(e instanceof Error?e.message:String(e));}
        finally {setBusy(false);}
    }
    async function clear() {setBusy(true);setError('');try {const state=await api.del<NonNullable<typeof current>>('/api/native/external-engine');setCurrent(state);setPath('');setPlan(null);void refreshNative(true).catch(()=>{});}catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}}
    return <Dialog open={open} onClose={()=>{if(!busy){setPlan(null);onClose();}}} title={tr('Use an existing engine')} actions={<><Btn onClick={onClose} disabled={busy}>{tr('Cancel')}</Btn><Btn variant="primary" disabled={busy || !path.trim()} onClick={()=>void save()}>{tr('Use this engine')}</Btn></>}>
      <div className="stack">{current?.selected ? <p role="status">{tr('Selected engine')}: {current.path} {current.usable ? tr('(available)') : current.notice}<br/><button type="button" disabled={busy} onClick={()=>void clear()}>{tr('Stop using this engine')}</button></p> : null}<p>{tr('Enter the full path to your existing engine executable. Strata references it in place and does not move or delete it. Updates require your confirmation. If its drive is disconnected, reconnect it before starting a model.')}</p>
      <label>{tr('Engine executable path')}<input className="input" type="text" value={path} onChange={e=>setPath(e.target.value)} placeholder="Y:\\Strata\\engine\\strata.exe"/></label>
      {current?.selected ? <section className="stack"><h3 className="h4">{tr('Update this external engine')}</h3><p>{tr('Check the engine release. Only verified engine files can be updated; a backup is made before changes.')}</p><div><Btn disabled={busy} onClick={()=>void checkUpdate()}>{tr('Check external engine update')}</Btn> <Btn disabled={busy} onClick={()=>void recover()}>{tr('Restore interrupted update')}</Btn></div>{plan ? <div className="stack" role="status"><p>{tr('Engine path')}: {plan.path}<br/>{tr('Current version')}: {plan.currentVersion || tr('Unknown')}<br/>{tr('Target version')}: {plan.targetVersion || tr('Unknown')}<br/>{tr('Update source')}: {plan.source}<br/>{tr('Download size')}: {Number.isFinite(plan.downloadBytes) ? `${(plan.downloadBytes/1000000).toFixed(1)} MB` : tr('Unknown')}</p>{plan.status==='current' ? <p>{tr('This external engine is up to date.')}</p> : <><p>{tr('Confirm to update the verified engine files at this path. Strata saves a backup first; unload models before updating.')}</p><p>{tr('Stop any other command-line engines before updating. Strata cannot prevent another program from starting one during the update.')}</p><Btn variant="primary" disabled={busy} onClick={()=>void applyUpdate()}>{tr('Confirm external engine update')}</Btn></>}</div> : null}</section> : null}
      {notice ? <p role="status">{notice}</p>:null}{retained.length ? <div><p>{tr('Files added by the update were kept to avoid deleting your files. Review them before retrying; they may block another update:')}</p><ul>{retained.map(p=><li key={p}>{p}</li>)}</ul></div> : null}{error ? <p role="alert" className="inline-error">{error}</p>:null}</div>
    </Dialog>;
}
