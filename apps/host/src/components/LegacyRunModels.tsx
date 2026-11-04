import { useState } from 'react';
import { tr } from '../lib/i18n';
import { nativeAction, useNative } from '../lib/native';
import { Btn, Dialog } from './ui';
import { LegacyRunImport } from './LegacyRunImport';
import { EngineFolderChoice } from './EngineFolderChoice';
import { NativeSettings } from './NativeSettings';
import { NativeSettingsFile } from './NativeSettingsFile';

/** Imported run configurations are copied into the app's model folder and are model configurations like the others: their settings
 *  change that copy, never the file they came from, and they can be exported again. They have arbitrary names outside the download catalog, so they are listed here. */
export function LegacyRunModels() {
    const native=useNative();
    const [importOpen,setImportOpen]=useState(false), [engineOpen,setEngineOpen]=useState(false), [remove,setRemove]=useState<string|null>(null);
    const [pending,setPending]=useState(false), [error,setError]=useState(''), [open,setOpen]=useState<string|null>(null);
    const entries=native?.installed?.models.filter(m=>m.imported) ?? [];
    const active=!!native?.jobs.some(j=>j.state==='running');
    async function action(kind:'load'|'remove',model:string) {
        setPending(true);setError('');
        try { await nativeAction('operations',{kind,args:{model}});setRemove(null); }
        catch(e) { setError(e instanceof Error?e.message:String(e)); }
        finally {setPending(false);}
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
            {instance ? <Btn disabled={pending || active} onClick={()=>void nativeAction(`instances/${instance.id}/unload`).catch(e=>setError(e.message))}>{tr('Unload')}</Btn> : <Btn variant="primary" disabled={pending || active || !entry.ready} onClick={()=>void action('load',entry.model)}>{tr('Load')}</Btn>}
            <Btn disabled={pending} onClick={()=>setOpen(open===entry.model?null:entry.model)}>{tr('Edit configuration')}</Btn>
            <Btn disabled={pending || active} onClick={()=>setRemove(entry.model)}>{tr('Remove from Strata')}</Btn>
          </div>
          {open===entry.model ? <div className="stack"><NativeSettingsFile model={entry.model}/><NativeSettings model={entry.model}/></div> : null}
        </div>;
      })}
      {error ? <p role="alert" className="inline-error">{error}</p> : null}
      <EngineFolderChoice open={engineOpen} onClose={()=>setEngineOpen(false)}/><LegacyRunImport open={importOpen} onClose={()=>setImportOpen(false)}/>
      <Dialog open={!!remove} title={tr('Remove configuration?')} onClose={()=>setRemove(null)} actions={<><Btn onClick={()=>setRemove(null)}>{tr('Cancel')}</Btn><Btn variant="primary" disabled={pending || !remove} onClick={()=>{if(remove)void action('remove',remove);}}>{tr('Remove from Strata')}</Btn></>}>
        <p>{tr('This removes only the copy of the configuration from Strata. Your original JSON, engine, model files and libraries are kept.')}</p>
      </Dialog>
    </section>;
}
