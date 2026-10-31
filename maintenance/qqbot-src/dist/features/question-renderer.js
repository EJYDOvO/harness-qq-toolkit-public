/** 把单个问题渲染成 QQ 文本（单选按钮由 HITL Bridge 签发、QQ Adapter 渲染为键盘） */
export function formatQuestion(question, requireMentionHint, withButtons) {
    const lines = [];
    if (question.header)
        lines.push(`**${question.header}**`);
    const opts = question.options ?? [];
    const multi = question.multiSelect === true;
    // 问题行：多选标记前置，用户第一眼就知道作答方式
    lines.push(multi ? `${question.question}（可多选）` : question.question);
    // 原生 intent 问题（如计划审阅）附带须审阅的内容
    if (typeof question.detail === 'string' && question.detail.trim())
        lines.push('', question.detail.trim(), '');
    // 选项列表：保留完整 label + description（按钮 label 截断时 description 靠正文展示）
    opts.forEach((o, i) => {
        lines.push(`${i + 1}. ${o.label}${o.description ? ` · ${o.description}` : ''}`);
    });
    // 底部引导：用引用块（>）与正文区分；mention 放在「回复」动作后（点按钮无需 @）
    if (opts.length > 0) {
        lines.push('');
        const mention = requireMentionHint ? '（需 @机器人）' : '';
        if (withButtons) {
            lines.push(`> 👇 点击下方按钮选择，或回复编号${mention}`);
        }
        else if (multi) {
            lines.push(`> 💡 回复多个编号即可多选（如 1,3）${mention}，或直接输入你的想法`);
        }
        else {
            lines.push(`> 💡 回复编号选择${mention}，或直接输入你的想法`);
        }
    }
    return lines.join('\n');
}
//# sourceMappingURL=question-renderer.js.map