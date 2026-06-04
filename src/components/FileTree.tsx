import { ChevronRight, ChevronDown, Folder, FileText, Image as ImageIcon, FileType } from 'lucide-react';

export interface FileEntry {
  relPath: string;
  name: string;
  kind: 'text' | 'pdf' | 'image';
  mtime: number;
  size: number;
}

interface TreeNode {
  name: string;
  path: string;
  dir: boolean;
  kind?: FileEntry['kind'];
  mtime?: number;
  children: TreeNode[];
}

export function buildTree(files: FileEntry[]): TreeNode[] {
  const root: TreeNode = { name: '', path: '', dir: true, children: [] };
  for (const f of files) {
    const parts = f.relPath.split('/');
    let node = root;
    let acc = '';
    parts.forEach((part, i) => {
      acc = acc ? `${acc}/${part}` : part;
      const isFile = i === parts.length - 1;
      let child = node.children.find(c => c.name === part && c.dir === !isFile);
      if (!child) {
        child = isFile
          ? { name: part, path: f.relPath, dir: false, kind: f.kind, mtime: f.mtime, children: [] }
          : { name: part, path: acc, dir: true, children: [] };
        node.children.push(child);
      }
      node = child;
    });
  }
  const sortRec = (n: TreeNode) => {
    n.children.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
    n.children.forEach(sortRec);
  };
  sortRec(root);
  return root.children;
}

function fileIcon(kind?: FileEntry['kind']) {
  if (kind === 'image') return <ImageIcon size={13} strokeWidth={1.75} />;
  if (kind === 'pdf') return <FileType size={13} strokeWidth={1.75} />;
  return <FileText size={13} strokeWidth={1.75} />;
}

interface FileTreeProps {
  nodes: TreeNode[];
  depth?: number;
  selected: string | null;
  recentPath: string | null;
  expanded: Set<string>;
  onToggle: (path: string) => void;
  onSelect: (path: string) => void;
}

export function FileTree({ nodes, depth = 0, selected, recentPath, expanded, onToggle, onSelect }: FileTreeProps) {
  return (
    <>
      {nodes.map(node =>
        node.dir ? (
          <div key={node.path}>
            <button
              className="tree-row tree-row--dir"
              style={{ paddingLeft: 8 + depth * 12 }}
              onClick={() => onToggle(node.path)}
            >
              {expanded.has(node.path)
                ? <ChevronDown size={13} strokeWidth={2} className="tree-chevron" />
                : <ChevronRight size={13} strokeWidth={2} className="tree-chevron" />}
              <Folder size={13} strokeWidth={1.75} className="tree-folder" />
              <span className="tree-name">{node.name}</span>
            </button>
            {expanded.has(node.path) && (
              <FileTree
                nodes={node.children}
                depth={depth + 1}
                selected={selected}
                recentPath={recentPath}
                expanded={expanded}
                onToggle={onToggle}
                onSelect={onSelect}
              />
            )}
          </div>
        ) : (
          <button
            key={node.path}
            className={`tree-row tree-row--file ${selected === node.path ? 'tree-row--selected' : ''}`}
            style={{ paddingLeft: 8 + depth * 12 + 14 }}
            onClick={() => onSelect(node.path)}
            title={node.path}
          >
            <span className="tree-file-icon">{fileIcon(node.kind)}</span>
            <span className="tree-name">{node.name}</span>
            {recentPath === node.path && <span className="tree-recent" title="just changed" />}
          </button>
        )
      )}
    </>
  );
}
