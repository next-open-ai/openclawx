import { Type } from "@sinclair/typebox";
import { BrowserManager } from "agent-browser/dist/browser.js";
import type { AgentTool } from "@mariozechner/pi-agent-core";

/**
 * Browser tool schema - defines all possible browser actions
 */
const BrowserToolSchema = Type.Object({
    action: Type.Union([
        Type.Literal("navigate"),
        Type.Literal("snapshot"),
        Type.Literal("screenshot"),
        Type.Literal("click"),
        Type.Literal("type"),
        Type.Literal("fill"),
        Type.Literal("scroll"),
        Type.Literal("extract"),
        Type.Literal("wait"),
        Type.Literal("back"),
        Type.Literal("forward"),
        Type.Literal("download"),
        Type.Literal("close"),
    ], { description: "Browser action to perform" }),
    url: Type.Optional(Type.String({ description: "URL to navigate to (for navigate action) or download from (for download action)" })),
    selector: Type.Optional(Type.String({ description: "CSS selector or ref (e.g., @e1) to target element" })),
    text: Type.Optional(Type.String({ description: "Text to type or fill (for type/fill actions)" })),
    direction: Type.Optional(Type.Union([
        Type.Literal("up"),
        Type.Literal("down"),
        Type.Literal("left"),
        Type.Literal("right"),
    ], { description: "Scroll direction" })),
    pixels: Type.Optional(Type.Number({ description: "Number of pixels to scroll" })),
    interactive: Type.Optional(Type.Boolean({ description: "Get only interactive elements in snapshot" })),
    fullPage: Type.Optional(Type.Boolean({ description: "Take full page screenshot" })),
    timeout: Type.Optional(Type.Number({ description: "Timeout in milliseconds for wait action" })),
    downloadPath: Type.Optional(Type.String({ description: "Local path to save downloaded file (for download action)" })),
});

type BrowserToolInput = {
    action: "navigate" | "snapshot" | "screenshot" | "click" | "type" | "fill" | "scroll" | "extract" | "wait" | "back" | "forward" | "download" | "close";
    url?: string;
    selector?: string;
    text?: string;
    direction?: "up" | "down" | "left" | "right";
    pixels?: number;
    interactive?: boolean;
    fullPage?: boolean;
    timeout?: number;
    downloadPath?: string;
};

/**
 * Shared browser manager instance
 */
let browserManager: BrowserManager | null = null;

/**
 * Get or create browser manager instance
 */
async function getBrowserManager(): Promise<BrowserManager> {
    if (!browserManager) {
        browserManager = new BrowserManager();
    }

    // Launch browser if not already launched
    if (!browserManager.isLaunched()) {
        await browserManager.launch({
            action: "launch",
            id: "default",
            headless: true,
            viewport: { width: 1280, height: 720 },
        });
    }

    return browserManager;
}

/**
 * Create browser automation tool
 * @param workspaceDir Optional workspace directory for downloads
 */
export function createBrowserTool(workspaceDir?: string): AgentTool<any> {
    return {
        name: "browser",
        label: "Browser",
        description: [
            "Control a headless browser for web automation.",
            "Actions: navigate (go to URL), snapshot (get page content with refs), screenshot (capture image),",
            "click (click element), type (type text), fill (clear and fill input), scroll (scroll page),",
            "extract (get text from element), wait (wait for element), download (download file from URL or by clicking),",
            "back/forward (navigation), close (close browser).",
            "Use refs from snapshot (e.g., @e1, @e2) to interact with elements reliably.",
        ].join(" "),
        parameters: BrowserToolSchema,
        execute: async (_toolCallId: string, args: unknown) => {
            const params = args as BrowserToolInput;
            console.log(`[Browser Tool] Executing action: ${params.action}`);
            try {
                // Ensure browser is ready
                const browser = await getBrowserManager();
                console.log(`[Browser Tool] Browser manager ready`);

                switch (params.action) {
                    case "navigate": {
                        if (!params.url) {
                            throw new Error("URL is required for navigate action");
                        }
                        const page = browser.getPage();
                        await page.goto(params.url, { waitUntil: "domcontentloaded" });
                        const url = page.url();
                        const title = await page.title();
                        return {
                            content: [{
                                type: "text" as const,
                                text: `Navigated to: ${title}\nURL: ${url}`
                            }],
                            details: { url, title },
                        };
                    }

                    case "snapshot": {
                        const snapshot = await browser.getSnapshot({
                            interactive: params.interactive ?? true,
                            compact: true,
                        });
                        const page = browser.getPage();
                        const url = page.url();
                        const title = await page.title();

                        return {
                            content: [{
                                type: "text" as const,
                                text: `Page: ${title}\nURL: ${url}\n\n${snapshot.tree}`
                            }],
                            details: {
                                url,
                                title,
                                snapshot: snapshot.tree,
                                refs: snapshot.refs
                            },
                        };
                    }

                    case "screenshot": {
                        const page = browser.getPage();
                        const screenshot = await page.screenshot({
                            fullPage: params.fullPage ?? false,
                            type: "png",
                        });
                        const base64 = screenshot.toString("base64");

                        return {
                            content: [
                                { type: "text" as const, text: "Screenshot captured" },
                                {
                                    type: "image" as const,
                                    data: base64,
                                    mimeType: "image/png"
                                },
                            ],
                            details: { fullPage: params.fullPage ?? false },
                        };
                    }

                    case "click": {
                        if (!params.selector) {
                            throw new Error("Selector is required for click action");
                        }
                        const locator = browser.getLocator(params.selector);
                        await locator.click();

                        return {
                            content: [{
                                type: "text" as const,
                                text: `Clicked element: ${params.selector}`
                            }],
                            details: { selector: params.selector },
                        };
                    }

                    case "type": {
                        if (!params.selector || !params.text) {
                            throw new Error("Selector and text are required for type action");
                        }
                        const locator = browser.getLocator(params.selector);
                        await locator.pressSequentially(params.text);

                        return {
                            content: [{
                                type: "text" as const,
                                text: `Typed text into: ${params.selector}`
                            }],
                            details: { selector: params.selector, text: params.text },
                        };
                    }

                    case "fill": {
                        if (!params.selector || !params.text) {
                            throw new Error("Selector and text are required for fill action");
                        }
                        const locator = browser.getLocator(params.selector);
                        await locator.fill(params.text);

                        return {
                            content: [{
                                type: "text" as const,
                                text: `Filled text into: ${params.selector}`
                            }],
                            details: { selector: params.selector, text: params.text },
                        };
                    }

                    case "scroll": {
                        const page = browser.getPage();
                        const direction = params.direction ?? "down";
                        const pixels = params.pixels ?? 500;

                        const scrollMap = {
                            down: { x: 0, y: pixels },
                            up: { x: 0, y: -pixels },
                            right: { x: pixels, y: 0 },
                            left: { x: -pixels, y: 0 },
                        };

                        const { x, y } = scrollMap[direction];
                        await page.evaluate(({ x, y }: { x: number; y: number }) => {
                            window.scrollBy(x, y);
                        }, { x, y });

                        return {
                            content: [{
                                type: "text" as const,
                                text: `Scrolled ${direction} by ${pixels}px`
                            }],
                            details: { direction, pixels },
                        };
                    }

                    case "extract": {
                        if (!params.selector) {
                            throw new Error("Selector is required for extract action");
                        }
                        const locator = browser.getLocator(params.selector);
                        const text = await locator.textContent();

                        return {
                            content: [{
                                type: "text" as const,
                                text: `Extracted text: ${text || "(empty)"}`
                            }],
                            details: { selector: params.selector, text },
                        };
                    }

                    case "wait": {
                        if (!params.selector) {
                            throw new Error("Selector is required for wait action");
                        }
                        const locator = browser.getLocator(params.selector);
                        await locator.waitFor({
                            state: "visible",
                            timeout: params.timeout ?? 30000
                        });

                        return {
                            content: [{
                                type: "text" as const,
                                text: `Element is now visible: ${params.selector}`
                            }],
                            details: { selector: params.selector },
                        };
                    }

                    case "back": {
                        const page = browser.getPage();
                        await page.goBack();
                        const url = page.url();

                        return {
                            content: [{
                                type: "text" as const,
                                text: `Navigated back to: ${url}`
                            }],
                            details: { url },
                        };
                    }

                    case "forward": {
                        const page = browser.getPage();
                        await page.goForward();
                        const url = page.url();

                        return {
                            content: [{
                                type: "text" as const,
                                text: `Navigated forward to: ${url}`
                            }],
                            details: { url },
                        };
                    }

                    case "download": {
                        const fs = await import("fs/promises");
                        const path = await import("path");

                        // Create downloads directory if it doesn't exist
                        const downloadsDir = workspaceDir ? path.join(workspaceDir, "downloads") : path.join(process.cwd(), "downloads");
                        try {
                            await fs.mkdir(downloadsDir, { recursive: true });
                        } catch (err) {
                            // Directory might already exist, ignore
                        }

                        // Hybrid approach: URL download or click-triggered download
                        if (params.url) {
                            // Direct URL download
                            const response = await fetch(params.url);
                            if (!response.ok) {
                                throw new Error(`Download failed: ${response.statusText}`);
                            }

                            const buffer = await response.arrayBuffer();
                            const filename = params.downloadPath || path.basename(params.url) || `download_${Date.now()}`;
                            const fullPath = path.isAbsolute(filename)
                                ? filename
                                : path.join(downloadsDir, filename);

                            await fs.writeFile(fullPath, Buffer.from(buffer));

                            return {
                                content: [{
                                    type: "text" as const,
                                    text: `Downloaded file to: ${fullPath}\nSize: ${buffer.byteLength} bytes`
                                }],
                                details: {
                                    path: fullPath,
                                    size: buffer.byteLength,
                                    url: params.url
                                },
                            };
                        } else if (params.selector) {
                            // Click-triggered download using Playwright
                            const page = browser.getPage();

                            const downloadPromise = page.waitForEvent('download', { timeout: 30000 });
                            const locator = browser.getLocator(params.selector);
                            await locator.click();

                            const download = await downloadPromise;
                            const suggestedFilename = download.suggestedFilename();
                            const filename = params.downloadPath || suggestedFilename || `download_${Date.now()}`;
                            const fullPath = path.isAbsolute(filename)
                                ? filename
                                : path.join(downloadsDir, filename);

                            await download.saveAs(fullPath);

                            return {
                                content: [{
                                    type: "text" as const,
                                    text: `Downloaded file to: ${fullPath}\nOriginal filename: ${suggestedFilename}`
                                }],
                                details: {
                                    path: fullPath,
                                    originalFilename: suggestedFilename,
                                    selector: params.selector
                                },
                            };
                        } else {
                            throw new Error("Download action requires either url or selector parameter");
                        }
                    }

                    case "close": {
                        if (browserManager) {
                            await browserManager.close();
                            browserManager = null;
                        }

                        return {
                            content: [{
                                type: "text" as const,
                                text: "Browser closed"
                            }],
                            details: { closed: true },
                        };
                    }

                    default:
                        throw new Error(`Unknown action: ${params.action}`);
                }
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                return {
                    content: [{
                        type: "text" as const,
                        text: `Browser action failed: ${errorMessage}`
                    }],
                    details: { error: errorMessage },
                };
            }
        },
    };
}

/**
 * Cleanup function to close browser on process exit
 */
export async function closeBrowser(): Promise<void> {
    if (browserManager) {
        await browserManager.close();
        browserManager = null;
    }
}
