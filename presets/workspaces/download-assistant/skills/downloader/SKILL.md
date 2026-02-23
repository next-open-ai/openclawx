---
name: downloader
description: Downloads files, images, or media from URLs using curl, wget, or python scripts. Can handle bulk downloads and save them to a specified directory.
allowed-tools: bash
---

# Downloader Skill

Use this skill to download resources from the internet to the user's local file system.

## Workflow

1. Identify the URL(s) to download and the target destination directory. If no directory is specified, default to `~/Downloads/OpenClawX/` and inform the user.
2. Ensure the destination directory exists using `bash` (`mkdir -p <dir>`).
3. Use a tool like `wget` or `curl` via the `bash` tool:
   - Example: `wget -P ~/Downloads/OpenClawX/ <URL>`
   - For multiple files, write urls to a file and use `wget -i <file>`.
4. If downloading media (like video), suggest to the user to use `yt-dlp` or similar tools if they are available on the system.
5. Check if the download succeeded (e.g., using `ls -l` on the destination file).
6. Provide the exact path of the downloaded file(s) to the user.
