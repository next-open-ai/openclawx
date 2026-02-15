/**
 * 通道模块 HTTP 处理：GET 列出已配置通道；具体入站由各通道（如飞书 WebSocket）自行处理。
 */
import type { Request, Response } from "express";
import { listChannels } from "./channel/registry.js";

export function handleChannel(req: Request, res: Response): void {
    if (req.method === "GET") {
        const channels = listChannels().map((c) => ({ id: c.id, name: c.name }));
        res.status(200).setHeader("Content-Type", "application/json").end(
            JSON.stringify({ ok: true, channels }),
        );
        return;
    }
    res.status(404).setHeader("Content-Type", "application/json").end(
        JSON.stringify({ ok: false, message: "Not found" }),
    );
}
