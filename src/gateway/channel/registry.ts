/**
 * 通道注册表：按 channelId 注册与获取通道，供入站回调分发。
 */
import type { IChannel, UnifiedMessage } from "./types.js";
import { handleChannelMessage } from "./channel-core.js";

const channels = new Map<string, IChannel>();

export function registerChannel(channel: IChannel): void {
    if (channels.has(channel.id)) {
        console.warn(`[ChannelRegistry] overwriting channel ${channel.id}`);
    }
    channels.set(channel.id, channel);
}

export function unregisterChannel(channelId: string): void {
    channels.delete(channelId);
}

export function getChannel(channelId: string): IChannel | undefined {
    return channels.get(channelId);
}

export function listChannels(): IChannel[] {
    return Array.from(channels.values());
}

/**
 * 入站收到统一消息时调用：按 channelId 找到通道并交给核心处理。
 */
export async function dispatchMessage(msg: UnifiedMessage): Promise<void> {
    const channel = channels.get(msg.channelId);
    if (!channel) {
        console.warn("[ChannelRegistry] no channel for", msg.channelId);
        return;
    }
    await handleChannelMessage(channel, msg);
}

/** 启动所有已注册通道的入站传输 */
export async function startAllChannels(): Promise<void> {
    for (const ch of channels.values()) {
        for (const inbound of ch.getInbounds()) {
            try {
                await inbound.start();
            } catch (e) {
                console.warn("[ChannelRegistry] start inbound failed for", ch.id, e);
            }
        }
    }
}

/** 停止所有已注册通道的入站传输 */
export async function stopAllChannels(): Promise<void> {
    for (const ch of channels.values()) {
        for (const inbound of ch.getInbounds()) {
            try {
                await inbound.stop();
            } catch (e) {
                console.warn("[ChannelRegistry] stop inbound failed for", ch.id, e);
            }
        }
    }
}
