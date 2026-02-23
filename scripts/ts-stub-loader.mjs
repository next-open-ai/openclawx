/**
 * ESM 解析钩子：将 "typescript" 解析为桩模块，避免加载 node_modules/typescript/lib/typescript.js
 *（该文件在 ESM 下含 with 语句会触发 SyntaxError: Unexpected token 'with'）。
 * 仅用于在加载 node-llama-cpp 时避免其依赖链拉取 typescript。
 */
const STUB_SOURCE = `export const version = "0.0.0-stub";
export default { version };
`;

export async function resolve(specifier, context, nextResolve) {
    if (specifier === "typescript" || specifier === "typescript/package.json") {
        return {
            url: "data:application/javascript;base64," + Buffer.from(STUB_SOURCE, "utf8").toString("base64"),
            format: "module",
            shortCircuit: true,
        };
    }
    return nextResolve(specifier, context);
}
