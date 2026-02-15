/**
 * Nest 应用创建：支持「内嵌到 Gateway」与「独立监听」两种模式。
 * - 内嵌：不设置 globalPrefix、不 listen，返回 { app, express } 供 Gateway 挂载到 /server-api。
 * - 独立：设置 globalPrefix('server-api') 并 listen(port)，用于单独启动 Desktop Server。
 */
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import type { Express } from 'express';
import { AppModule } from './app.module.js';

export interface NestAppResult {
    app: INestApplication;
    express: Express;
}

/**
 * 创建 Nest 应用（内嵌模式）：不 listen，不设置 globalPrefix。
 * Gateway 将返回的 express 挂到 /server-api，请求路径会剥掉前缀后进入 Nest。
 */
export async function createNestAppEmbedded(): Promise<NestAppResult> {
    const app = await NestFactory.create(AppModule, {
        cors: true,
    });
    app.enableCors({
        origin: ['http://localhost:5173', 'http://localhost:38080', 'http://localhost:38081'],
        credentials: true,
    });
    await app.init();
    const express = app.getHttpAdapter().getInstance() as Express;
    return { app, express };
}

/**
 * 独立启动时使用：设置 globalPrefix 并监听端口。
 */
export async function createNestAppStandalone(port: number = 38081): Promise<INestApplication> {
    const app = await NestFactory.create(AppModule, {
        cors: true,
    });
    app.setGlobalPrefix('server-api');
    app.enableCors({
        origin: ['http://localhost:5173', 'http://localhost:38080', 'http://localhost:38081'],
        credentials: true,
    });
    await app.listen(port);
    return app;
}
