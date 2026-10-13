/** Delivery adapter for the current sandboxed static application host, not a general agent policy. */
export function managedStaticDeliveryInstructions(input: { appId: string; token: string; publishUrl: string }) {
  return `【当前交付模式：沙箱静态网页】
本节仅约束本应用的页面交付，不是智能体的通用开发限制。使用原生write/edit生成自包含、响应式 output/index.html；当前宿主不运行npm、后端服务器或外部CDN，页面不直接fetch接口。
宿主在预览及发布页面自动注入 window.workmateData：query(operationId,parameters)读取已登记操作，Promise返回fields/rows/hasMore等；mutate(operationId,parameters)提交已登记且启用的写操作；getAccess()读取当前writeEnabled/canWrite与operations的approved/action。页面只传操作ID与参数，不携带SQL或数据库凭据。项目预览使用当前账号，不必先发布才能验证；发布页需登录。
页面提供加载、空态、成功及错误反馈；不要伪造数据或成功提示，不自动重试写入。打开表单及 workmate:data-access-changed 事件后刷新权限，不把“只读/待审核”写成固定文案。授权后的保存直接提交，不增加平台二次确认。
完成后 commit_artifact({path:'output/index.html'})，再 bind_data_app_custom_site({appId:${JSON.stringify(input.appId)},token:${JSON.stringify(input.token)},path:'output/index.html'})；token仅用于绑定，不是数据身份，不得放进页面。后续修改保持原应用与操作ID。
交付时说明实际查询验证/绑定结果及未完成项，给出发布链接 ${input.publishUrl}。`;
}
