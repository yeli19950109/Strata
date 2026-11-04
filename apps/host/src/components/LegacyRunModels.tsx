import { useState } from 'react';
import { tr } from '../lib/i18n';
import { nativeAction, refreshNative, useNative } from '../lib/native';
import { Btn, Dialog } from './ui';
import { LegacyRunImport } from './LegacyRunImport';
import { EngineFolderChoice } from './EngineFolderChoice';
import { api } from '../lib/client';

/** Imported runs can have arbitrary model names and do not belong to the download catalog. */
export function LegacyRunModels() {
    const native=useNative();
    const [importOpen,setImportOpen]=useState(false), [engineOpen,setEngineOpen]=useState(false), [remove,setRemove]=useState<string|null>(null);
    const [pending,setPending]=useState(false), [error,setError]=useState('');
    const [review,setReview]=useState<{model:string;beforeLoad:unknown;configHash:string}|null>(null);
    const [edit,setEdit]=useState<{model:string;text:string;configHash:string}|null>(null);
    const entries=native?.installed?.models.filter(m=>m.externalImport) ?? [];
    const active=!!native?.jobs.some(j=>j.state==='running');
    async function action(kind:'load'|'remove',model:string,confirmedConfigHash?:string) {
        setPending(true);setError('');
        try { await nativeAction('operations',{kind,args:{model,...(confirmedConfigHash?{confirmedConfigHash}:{})}});setRemove(null);setReview(null); }
        catch(e) { setError(e instanceof Error?e.message:String(e)); }
        finally {setPending(false);}
    }
    async function load(model:string) {
        setPending(true);setError('');
        try {
            const current=await api.get<{beforeLoad:unknown;configHash:string}>(`/api/native/legacy/${encodeURIComponent(model)}/load-review`);
            if(current.beforeLoad) setReview({model,...current});
            else await nativeAction('operations',{kind:'load',args:{model,confirmedConfigHash:current.configHash}});
        } catch(e) {setError(e instanceof Error?e.message:String(e));}
        finally {setPending(false);}
    }
    async function openEditor(model:string) {
        setPending(true);setError('');try{const result=await api.get<{text:string;configHash:string}>(`/api/native/legacy/${encodeURIComponent(model)}/config`);setEdit({model,...result});}catch(e){setError(e instanceof Error?e.message:String(e));}finally{setPending(false);}
    }
    async function saveEditor() {
        if(!edit)return;setPending(true);setError('');try{await api.post(`/api/native/legacy/${encodeURIComponent(edit.model)}/config`,{text:edit.text,configHash:edit.configHash});setEdit(null);await refreshNative(true);}catch(e){setError(e instanceof Error?e.message:String(e));}finally{setPending(false);}
    }
    return <section id="existing-engine-configurations" className="st-card stack">
      <div><h2 className="h4">{tr('Existing engine configurations')}</h2><p className="small muted">{tr('Use a configuration from your command-line installation. Your existing files stay where they are.')}</p></div>
      <div style={{display:"flex",gap:8,flexWrap:"wrap"}}><Btn onClick={()=>setImportOpen(true)}>{tr('Import run JSON…')}</Btn><Btn onClick={()=>setEngineOpen(true)}>{tr('Use an existing engine…')}</Btn></div>
      {entries.map(entry=>{
        const instance=native?.instances.find(i=>i.model===entry.model), job=native?.jobs.filter(j=>j.model===entry.model).at(-1);
        return <div key={entry.model} className="stack" style={{gap:8,borderTop:'1px solid var(--st-line)',paddingTop:12}}>
          <div><strong>{entry.model_name || entry.model}</strong> <span className="small muted">{entry.model}</span></div>
          {entry.knownModel?<div className="small muted">{entry.knownModel.family} · {entry.knownModel.quant}{!entry.knownModel.shardsMatch?` · ${tr('Check the second shard path')}`:''}</div>:null}
          <div className="small muted">{instance ? tr(instance.status) : entry.ready ? tr('Ready to load') : tr('Some files are unavailable. Reconnect the drive and check the paths.')}</div>
          {entry.missing?.length ? <div className="small muted">{entry.missing.join(', ')}</div> : null}
          {job?.state==='running' ? <div role="status">{job.summary}</div> : null}
          {job?.state==='error' ? <div role="alert" className="inline-error">{job.error || job.summary}</div> : null}
          <div style={{display:'flex',gap:8,flexWrap:'wrap'}}>
            {instance ? <Btn disabled={pending || active} onClick={()=>void nativeAction(`instances/${instance.id}/unload`).catch(e=>setError(e.message))}>{tr('Unload')}</Btn> : <Btn variant="primary" disabled={pending || active || !entry.ready} onClick={()=>void load(entry.model)}>{tr('Load')}</Btn>}
            <Btn disabled={pending || active || !!instance} onClick={()=>void openEditor(entry.model)}>{tr('Edit configuration')}</Btn>
            <Btn disabled={pending || active} onClick={()=>setRemove(entry.model)}>{tr('Remove from Strata')}</Btn>
          </div>
        </div>;
      })}
      {error ? <p role="alert" className="inline-error">{error}</p> : null}
      <EngineFolderChoice open={engineOpen} onClose={()=>setEngineOpen(false)}/><LegacyRunImport open={importOpen} onClose={()=>setImportOpen(false)}/>
      <Dialog open={!!edit} title={tr('Edit imported configuration')} wide onClose={()=>{if(!pending){setEdit(null);setError('');}}} actions={<><Btn disabled={pending} onClick={()=>{setEdit(null);setError('');}}>{tr('Cancel')}</Btn><Btn variant="primary" disabled={pending||!edit} onClick={()=>void saveEditor()}>{tr('Save configuration')}</Btn></>}>
        <p>{tr('Edit the app-owned copy as JSON. The original file remains unchanged; arguments, environment variables and additional fields remain unless you edit them.')}</p>
        <p>{tr('Commands in before_load run when the model starts. Review them before loading.')}</p>
        {error?<p role="alert" className="inline-error">{error}</p>:null}
        <label className="input-field"><span>{tr('Run configuration JSON')}</span><textarea className="st-input" rows={18} spellCheck={false} value={edit?.text??''} onChange={e=>setEdit(old=>old?{...old,text:e.target.value}:old)} style={{fontFamily:'monospace',minHeight:280}}/></label>
      </Dialog>
      <Dialog open={!!review} title={tr('Review command before loading')} onClose={()=>{if(!pending)setReview(null);}} actions={<><Btn disabled={pending} onClick={()=>setReview(null)}>{tr('Cancel')}</Btn><Btn variant="primary" disabled={pending || !review} onClick={()=>{if(review)void action('load',review.model,review.configHash);}}>{tr('Run command and load')}</Btn></>}>
        <p>{tr('This configuration will run the following before_load command when the model starts. Only continue if you trust it.')}</p>
        <pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{review ? JSON.stringify(review.beforeLoad,null,2) : ''}</pre>
      </Dialog>
      <Dialog open={!!remove} title={tr('Remove configuration?')} onClose={()=>setRemove(null)} actions={<><Btn onClick={()=>setRemove(null)}>{tr('Cancel')}</Btn><Btn variant="primary" disabled={pending || !remove} onClick={()=>{if(remove)void action('remove',remove);}}>{tr('Remove from Strata')}</Btn></>}>
        <p>{tr('This removes only the copy of the configuration from Strata. Your original JSON, engine, model files and libraries are kept.')}</p>
      </Dialog>
    </section>;
}
