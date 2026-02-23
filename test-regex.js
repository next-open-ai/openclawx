const url1 = "file:///Users/ctrip/.openbot/workspace/doc-assistant/上海到三亚三天行程设计.html";
const url2 = "file:///Users/ctrip/.openbot/workspace/doc-assistant/%E4%B8%8A%E6%B5%B7%E5%88%B0%E4%B8%89%E4%BA%9A%E4%B8%89%E5%A4%A9%E8%A1%8C%E7%A8%8B%E8%AE%BE%E8%AE%A1.html";

function parseLocalWorkspaceUrl(url) {
  if (!url) return null;
  const match = url.match(/^file:\/\/.+[\/\\]workspace[\/\\]([^\/\\]+)[\/\\](.*)/i);
  if (match) {
    try {
        return {
        workspace: decodeURIComponent(match[1]),
        path: decodeURIComponent(match[2])
        };
    } catch (e) {
        return {
            workspace: match[1],
            path: match[2]
        }
    }
  }
  return null;
}

console.log(parseLocalWorkspaceUrl(url1));
console.log(parseLocalWorkspaceUrl(url2));
