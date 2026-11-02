import { useRef, useState } from 'react';
import { tr } from '../lib/i18n';
import { api } from '../lib/client';
import { refreshNative } from '../lib/native';
import { Btn, Dialog } from './ui';

type Preview = { config: Record<string, unknown>; issues: {level:string;message:string}[]; overrides: string[] };

/** Select and review an existing run config. Selection and preview only read the file. */
export function LegacyRunImport({open,onClose,onImported}:{open:boolean;onClose:()=>void;onImported?:()=>void}) {
    const file = useRef<HTMLInputElement>(null);
    const [text,setText] = useState(''), [id,setId] = useState(''), [preview,setPreview] = useState<Preview|null>(null);
    const [busy,setBusy] = useState(false), [problem,setProblem] = useState('');
    async function chosen(f: File | undefined) {
        if (!f) return;
        setProblem(''); setPreview(null); setText('');
        if (f.size > 1024 * 1024) { setProblem(tr('Choose a JSON file under 1 MiB.')); return; }
        setBusy(true);
        try {
            const source = new TextDecoder('utf-8', {fatal:true, ignoreBOM:true}).decode(await f.arrayBuffer());
            const result = await api.post<Preview>('/api/native/legacy/preview',{text:source});
            const suggested = f.name.replace(/\.json$/i,'').replace(/^strata-/i,'').replace(/[^a-z0-9_.-]+/gi,'-').replace(/^[^a-z0-9]+/i,'').replace(/\.{2,}/g,'.').slice(0,80);
            setId(suggested || 'imported-model'); setText(source); setPreview(result);
        } catch(e) { setProblem(e instanceof Error ? e.message : String(e)); }
        finally { setBusy(false); if(file.current) file.current.value=''; }
    }
    async function save() {
        setBusy(true); setProblem('');
        try { await api.post('/api/native/legacy/import',{text,id}); setText(''); setPreview(null); onClose(); onImported?.(); void refreshNative(true).catch(() => {}); }
        catch(e) { setProblem(e instanceof Error ? e.message : String(e)); }
        finally { setBusy(false); }
    }
    function close() { if (!busy) {setText(''); setPreview(null); setProblem(''); onClose();} }
    return <Dialog open={open} onClose={close} title={tr('Use an existing engine and run configuration')} wide actions={<><Btn onClick={close} disabled={busy}>{tr('Cancel')}</Btn>{preview ? <Btn variant="primary" disabled={busy || !id.trim()} onClick={() => void save()}>{tr('Import configuration')}</Btn> : null}</>}>
      <div className="stack">
        <p>{tr('Choose the JSON file you used from the command line. Strata copies only the configuration; your engine, models and libraries stay in their current locations. Importing does not start a model or download an engine.')}</p>
        <input ref={file} type="file" accept=".json,application/json" onChange={e => void chosen(e.target.files?.[0])}/>
        {problem ? <p role="alert" className="inline-error">{problem}</p> : null}
        {preview ? <>
          <label>{tr('Name in Strata')}<input className="input" value={id} maxLength={80} onChange={e=>setId(e.target.value)} /></label>
          <p>{tr('The paths below are kept as written. If a drive or file is unavailable, reconnect it before loading the model.')}</p>
          {preview.config.before_load ? <p role="alert" className="inline-error">{tr('This configuration includes a before_load command. It will run when the model starts; review it carefully.')}</p> : null}
          <p><strong>{tr('Changes when starting:')}</strong></p><ul>{preview.overrides.map(line=><li key={line}>{tr(line)}</li>)}</ul>
          {preview.issues.length ? <ul>{preview.issues.map((issue,i)=><li key={i}>{tr(issue.message)}</li>)}</ul> : null}
          <details open><summary>{tr('Configuration to import')}</summary><pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere',maxHeight:300,overflow:'auto'}}>{JSON.stringify(preview.config,null,2)}</pre></details>
        </> : null}
      </div>
    </Dialog>;
}
