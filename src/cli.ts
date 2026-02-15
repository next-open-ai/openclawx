#!/usr/bin/env node
/**
 * 兼容旧命令 node dist/cli.js / openbot → 实际入口为 dist/cli/cli.js
 */
import "./cli/cli.js";
