const parseLocalWorkspaceUrl = (url) => {
      if (!url) return null;
      const match = url.match(/^file:\/\/.+[\/\\]workspace[\/\\]([^\/\\]+)[\/\\](.*)/i);
      if (match) {
        return {
          workspace: decodeURIComponent(match[1]),
          path: decodeURIComponent(match[2])
        };
      }
      return null;
    }

console.log(parseLocalWorkspaceUrl("file:///Users/ctrip/.openbot/workspace/doc-assistant/上海到三亚三天行程设计.html"));
console.log(parseLocalWorkspaceUrl("file:///Users/ctrip/.openbot/workspace/doc-assistant/%E4%B8%8A...%A1.html"));
