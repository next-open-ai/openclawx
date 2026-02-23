/**
 * Jest 用 mock，供 test 中加载 memory 时替代 @mariozechner/pi-coding-agent，避免安装/加载真实包。
 */
function getLatestCompactionEntry() {
    return null;
}
function convertToLlm(x) {
    return Array.isArray(x) ? x : [];
}
module.exports = { getLatestCompactionEntry, convertToLlm };
