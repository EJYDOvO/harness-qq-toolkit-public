/**
 * 把审批请求渲染成 QQ 文本（含被 gate 的命令回显）。按钮（允许一次 / 拒绝）由
 * HITL Bridge 签发、QQ Adapter 渲染为键盘；dsh 审批结果为闭合集合
 * （allowed-once/rejected/cancelled/unavailable），没有 allow-always。
 */
export function buildApprovalText(request, command) {
    const lines = ['🔐 **执行审批**', ''];
    lines.push(`🔧 工具: ${request.toolName}`);
    if (command) {
        lines.push('');
        lines.push('```');
        lines.push(command);
        lines.push('```');
    }
    if (request.reason) {
        lines.push('');
        lines.push(`📝 ${request.reason}`);
    }
    lines.push('');
    lines.push('> 👇 点击下方按钮确认是否允许执行');
    return lines.join('\n');
}
