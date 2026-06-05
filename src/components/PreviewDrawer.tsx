import { useEffect, useMemo, useState } from 'react';
import { Eye, X, PanelLeftOpen, PanelLeftClose } from 'lucide-react';
import { FileTree, buildTree, type FileEntry } from './FileTree';
import './PreviewDrawer.css';

const BROKER = 'http://127.0.0.1:7900';
const TREE_POLL_MS = 4000;
const FILE_POLL_MS = 2000;

type PreviewKind = 'text' | 'pdf' | 'image';

interface FileMeta {
  relPath: string;
  name: string;
  kind: PreviewKind;
  mtime: string;
  size: number;
  truncated?: boolean;
  content?: string;
}

interface PreviewDrawerProps {
  open: boolean;
  cwd: string | null;
  teammateName?: string;
  /** The file the agent (or user) asked to preview. null = browse mode. */
  file: string | null;
  /** Bumped on every open/request so the same file can be re-requested. */
  requestKey: number;
  onClose: () => void;
}

const LANG: Record<string, string> = {
  ts: 'TypeScript', tsx: 'TypeScript', js: 'JavaScript', jsx: 'JavaScript',
  py: 'Python', md: 'Markdown', css: 'CSS', json: 'JSON', go: 'Go',
  rs: 'Rust', sh: 'Shell', html: 'HTML', yml: 'YAML', yaml: 'YAML', sql: 'SQL',
};
const langOf = (name: string) => LANG[name.split('.').pop()?.toLowerCase() ?? ''] ?? 'Text';
const fmtSize = (n: number) => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;
function agoOf(iso: string) {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`;
}
function ancestors(relPath: string): string[] {
  const parts = relPath.split('/');
  const out: string[] = [];
  for (let i = 1; i < parts.length; i++) out.push(parts.slice(0, i).join('/'));
  return out;
}

export function PreviewDrawer({ open, cwd, teammateName, file, requestKey, onClose }: PreviewDrawerProps) {
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [meta, setMeta] = useState<FileMeta | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [empty, setEmpty] = useState(false);
  const [treeOpen, setTreeOpen] = useState(false); // file tree hidden by default

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape' && open) onClose(); }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // Each open / agent request decides what's shown: the named file, or browse mode.
  useEffect(() => {
    if (!open) return;
    setSelected(file);
    setTreeOpen(!file); // a named file shows it; no file => open the browser
  }, [open, requestKey, file]);

  // Poll the file list (only needed for manual browsing).
  useEffect(() => {
    if (!open || !cwd) return;
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch(`${BROKER}/tree?cwd=${encodeURIComponent(cwd!)}`, { signal: AbortSignal.timeout(5000) });
        const data: { files: FileEntry[] } = await res.json();
        if (!cancelled) { setFiles(data.files ?? []); setEmpty((data.files ?? []).length === 0); }
      } catch { if (!cancelled) setEmpty(true); }
    }
    load();
    const id = setInterval(load, TREE_POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [open, cwd]);

  // Auto-expand the folders leading to the shown file.
  useEffect(() => {
    if (!selected) return;
    setExpanded(prev => {
      const next = new Set(prev);
      for (const a of ancestors(selected)) next.add(a);
      return next;
    });
  }, [selected]);

  // Poll the shown file's content (live updates as the agent edits it).
  useEffect(() => {
    if (!open || !cwd || !selected) { setMeta(null); return; }
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch(`${BROKER}/filemeta?cwd=${encodeURIComponent(cwd!)}&path=${encodeURIComponent(selected!)}`, { signal: AbortSignal.timeout(5000) });
        const data: { file: FileMeta | null } = await res.json();
        if (!cancelled) setMeta(data.file);
      } catch { /* keep last */ }
    }
    load();
    const id = setInterval(load, FILE_POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [open, cwd, selected]);

  const tree = useMemo(() => buildTree(files), [files]);
  const lines = meta?.content != null ? meta.content.replace(/\n$/, '').split('\n') : [];
  const fileUrl = meta && cwd ? `${BROKER}/file?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(meta.relPath)}` : '';
  const isCsv = !!meta && meta.kind === 'text' && /\.(csv|tsv)$/i.test(meta.name);

  function toggleFolder(path: string) {
    setExpanded(prev => { const n = new Set(prev); n.has(path) ? n.delete(path) : n.add(path); return n; });
  }
  function pick(path: string) { setSelected(path); setTreeOpen(false); }

  return (
    <>
      <div className={`drawer-backdrop ${open ? 'drawer-backdrop--visible' : ''}`} onClick={onClose} />
      <div className={`drawer ${open ? 'drawer--open' : ''}`} aria-hidden={!open}>
        <div className="drawer-header">
          <div className="drawer-header-left">
            <button
              className={`drawer-tree-toggle ${treeOpen ? 'drawer-tree-toggle--on' : ''}`}
              title={treeOpen ? 'Hide files' : 'Browse files'}
              onClick={() => setTreeOpen(o => !o)}
            >
              {treeOpen ? <PanelLeftClose size={16} strokeWidth={1.75} /> : <PanelLeftOpen size={16} strokeWidth={1.75} />}
            </button>
            <span className="drawer-icon"><Eye size={15} strokeWidth={1.75} /></span>
            <span className="drawer-title">PREVIEW</span>
            {teammateName && <span className="drawer-agent">{teammateName}</span>}
          </div>
          <button className="drawer-close" onClick={onClose}><X size={15} strokeWidth={1.75} /></button>
        </div>

        <div className="drawer-body">
          {treeOpen && (
            <aside className="drawer-tree">
              {files.length === 0 ? (
                <div className="tree-empty">{empty ? 'No files' : 'Loading…'}</div>
              ) : (
                <FileTree
                  nodes={tree}
                  selected={selected}
                  recentPath={null}
                  expanded={expanded}
                  onToggle={toggleFolder}
                  onSelect={pick}
                />
              )}
            </aside>
          )}

          <section className="drawer-view">
            {!meta ? (
              <div className="drawer-empty">
                <span className="drawer-empty-title">Nothing to show</span>
                <span className="drawer-empty-sub">An agent opens a file here with the preview tool, or open the file list (top-left) to browse.</span>
              </div>
            ) : (
              <>
                <div className="drawer-toolbar">
                  <span className="toolbar-file" title={meta.relPath}>{meta.relPath}</span>
                  <span className="toolbar-lang">{meta.kind === 'pdf' ? 'PDF' : meta.kind === 'image' ? 'IMAGE' : isCsv ? 'CSV' : langOf(meta.name)}</span>
                  <span className="toolbar-live">● {agoOf(meta.mtime)}{meta.truncated ? ' · truncated' : ` · ${fmtSize(meta.size)}`}</span>
                </div>
                <div className="drawer-content">
                  {meta.kind === 'pdf' ? (
                    <iframe className="drawer-embed" src={fileUrl} title={meta.relPath} />
                  ) : meta.kind === 'image' ? (
                    <div className="drawer-image-wrap"><img className="drawer-image" src={fileUrl} alt={meta.relPath} /></div>
                  ) : isCsv ? (
                    <CsvTable text={meta.content ?? ''} />
                  ) : (
                    <div className="code-block">
                      {lines.map((line, i) => (
                        <div key={i} className="code-row">
                          <span className="code-num">{i + 1}</span>
                          <span className={`code-text ${tokenClass(line)}`}>{line || ' '}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </>
            )}
          </section>
        </div>
      </div>
    </>
  );
}

const CSV_MAX_ROWS = 2000;

function parseDelimited(text: string, delim: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else inQ = false; }
      else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === delim) { row.push(cur); cur = ''; }
    else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else if (c !== '\r') cur += c;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows.filter(r => !(r.length === 1 && r[0] === ''));
}

function CsvTable({ text }: { text: string }) {
  const { header, body, total } = useMemo(() => {
    const first = text.split('\n', 1)[0] ?? '';
    const delim = first.split('\t').length > first.split(',').length ? '\t' : ',';
    const rows = parseDelimited(text, delim);
    return { header: rows[0] ?? [], body: rows.slice(1, CSV_MAX_ROWS), total: rows.length - 1 };
  }, [text]);

  if (!header.length) {
    return <div className="drawer-empty"><span className="drawer-empty-title">Empty file</span></div>;
  }
  return (
    <div className="csv-wrap">
      <table className="csv-table">
        <thead>
          <tr>
            <th className="csv-rownum" />
            {header.map((h, i) => <th key={i}>{h}</th>)}
          </tr>
        </thead>
        <tbody>
          {body.map((r, ri) => (
            <tr key={ri}>
              <td className="csv-rownum">{ri + 1}</td>
              {header.map((_, ci) => <td key={ci}>{r[ci] ?? ''}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
      {total > body.length && <div className="csv-more">… {total - body.length} more rows</div>}
    </div>
  );
}

function tokenClass(line: string): string {
  const t = line.trim();
  if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('#')) return 'code--comment';
  if (t.startsWith('import') || t.startsWith('export') || t.startsWith('from ')) return 'code--keyword-line';
  return '';
}
