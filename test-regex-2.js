const url = "file:///Users/ctrip/.openbot/workspace/doc-assistant/上海到三亚三天行程设计.html";

function parseLocalWorkspaceUrl(u) {
  if (!u) return null;
  const match = u.match(/^file:\/\/.+[\/\\]workspace[\/\\]([^\/\\]+)[\/\\](.*)/i);
  if (match) {
    return {
      workspace: decodeURIComponent(match[1]),
      path: decodeURIComponent(match[2])
    };
  }
  return null;
}

const parsed = parseLocalWorkspaceUrl(url);
console.log("Parsed:", parsed);

const ext = parsed ? parsed.path.split('.').pop()?.toLowerCase() || '' : '';
console.log("Ext:", ext);

console.log("Type:", ['html', 'htm'].includes(ext) ? 'html' : ext === 'pdf' ? 'pdf' : 'web');
