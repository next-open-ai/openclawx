import { archivedAssetContentUrl, workspaceContentUrl } from '../services/api.js';
import { isDesktopShell } from './platform.js';

function openUrl(url: string) {
  window.open(url, '_blank', 'noopener');
}

/** Prefer the OS default browser (Electron shell.openExternal); fall back to window.open. */
export async function openExternalBestEffort(url: string) {
  const target = String(url || '').trim();
  if (!target) return;
  if (isDesktopShell() && window.openclawxDesktop?.openExternal) {
    await window.openclawxDesktop.openExternal(target);
    return;
  }
  openUrl(target);
}

export function copyableWorkspaceFileUrl(root: string, relative: string) {
  return workspaceContentUrl(root, relative);
}

export function copyableAssetUrl(assetId: string) {
  return archivedAssetContentUrl(assetId);
}

export async function previewWorkspaceFileUrl(root: string, relative: string) {
  if (isDesktopShell() && window.openclawxDesktop) {
    const registered = await window.openclawxDesktop.registerPreviewRoot(root);
    return `${registered.origin}/${relative.split('/').map(encodeURIComponent).join('/')}`;
  }
  return workspaceContentUrl(root, relative);
}

export async function previewAssetUrl(assetId: string, assetName: string) {
  if (isDesktopShell() && window.openclawxDesktop) {
    const registered = await window.openclawxDesktop.registerAssetPreviewRoot(assetId);
    return `${registered.origin}/${encodeURIComponent(assetName)}`;
  }
  return archivedAssetContentUrl(assetId);
}

export async function openWorkspaceFileBestEffort(root: string, relative: string) {
  if (isDesktopShell()) {
    await window.openclawxDesktop?.openProjectFileInBrowser(root, relative);
    return;
  }
  openUrl(workspaceContentUrl(root, relative));
}

export async function downloadWorkspaceFileBestEffort(root: string, relative: string) {
  if (isDesktopShell()) {
    await window.openclawxDesktop?.revealProjectFile(root, relative);
    return;
  }
  openUrl(workspaceContentUrl(root, relative, { download: true }));
}

export async function revealWorkspaceFileBestEffort(root: string, relative: string) {
  if (isDesktopShell()) {
    await window.openclawxDesktop?.revealProjectFile(root, relative);
    return true;
  }
  return false;
}

export async function openAssetBestEffort(assetId: string) {
  if (isDesktopShell()) {
    await window.openclawxDesktop?.openAssetInBrowser(assetId);
    return;
  }
  openUrl(archivedAssetContentUrl(assetId));
}

export async function downloadAssetBestEffort(assetId: string) {
  if (isDesktopShell()) {
    await window.openclawxDesktop?.saveAsset(assetId);
    return;
  }
  openUrl(archivedAssetContentUrl(assetId, { download: true }));
}

export async function revealAssetBestEffort(assetId: string) {
  if (isDesktopShell()) {
    await window.openclawxDesktop?.revealAsset(assetId);
    return true;
  }
  return false;
}
