/**
 * OpenBot Desktop 后端入口（独立模式）。
 * 内嵌到 Gateway 时由 gateway/server 调用 createNestAppEmbedded，不经过本文件。
 */
import { createNestAppStandalone } from './bootstrap.js';

const port = Number(process.env.PORT) || 38081;
createNestAppStandalone(port).then(() => {
    console.log(`🚀 OpenBot Desktop Server running on http://localhost:${port}`);
});
