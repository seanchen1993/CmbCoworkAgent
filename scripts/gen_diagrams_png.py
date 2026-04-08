"""
Generate all diagrams as PNG using matplotlib (no SVG renderer needed).
Produces fig1–fig10 as high-res PNG in docs/diagrams/.
"""
import os
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import matplotlib.patches as mpatches
from matplotlib.patches import FancyBboxPatch, FancyArrowPatch
import matplotlib.patheffects as pe
import numpy as np

matplotlib.rcParams['font.family'] = ['Microsoft YaHei', 'SimHei', 'DejaVu Sans']
matplotlib.rcParams['axes.unicode_minus'] = False

OUT = r'C:/ai/CmbCoworkAgent/docs/diagrams'

def save(fig, name):
    path = os.path.join(OUT, name)
    fig.savefig(path, dpi=150, bbox_inches='tight', facecolor=fig.get_facecolor())
    plt.close(fig)
    print('Saved:', path)

def draw_box(ax, x, y, w, h, text_lines, fill, edge, radius=0.3, fontsize=11, bold_first=True):
    box = FancyBboxPatch((x, y), w, h,
                         boxstyle=f"round,pad=0,rounding_size={radius}",
                         facecolor=fill, edgecolor=edge, linewidth=1.8, zorder=3)
    ax.add_patch(box)
    n = len(text_lines)
    for idx, t in enumerate(text_lines):
        offset = (idx - (n-1)/2) * (h / (n+0.5))
        weight = 'bold' if (idx == 0 and bold_first) else 'normal'
        size   = fontsize if (idx == 0 and bold_first) else fontsize - 1
        ax.text(x + w/2, y + h/2 + offset, t,
                ha='center', va='center', fontsize=size,
                fontweight=weight, color='#1e293b', zorder=4)

def arr(ax, x1, y1, x2, y2, color='#94a3b8', lw=2):
    ax.annotate('', xy=(x2, y2), xytext=(x1, y1),
                arrowprops=dict(arrowstyle='->', color=color, lw=lw,
                                mutation_scale=16))


# ─────────────────────────────────────────────────────────────────────────────
# 图1  总体架构图
# ─────────────────────────────────────────────────────────────────────────────
def fig1():
    fig, ax = plt.subplots(figsize=(12, 8))
    fig.patch.set_facecolor('#f8fafc')
    ax.set_facecolor('#f8fafc')
    ax.set_xlim(0, 10); ax.set_ylim(0, 8)
    ax.axis('off')
    ax.set_title('图1  CmbCoworkAgent 总体架构', fontsize=15, fontweight='bold',
                 color='#1e293b', pad=14)

    draw_box(ax, 2.5, 6.6, 5, 0.95, ['交互展现层 (Renderer)',
             '会话 · 审批 · Hooks配置 · Skills管理 · 更新提示'],
             '#dbeafe', '#3b82f6')
    draw_box(ax, 2.0, 5.4, 6, 0.95, ['IPC 安全路由层',
             'Agent · Sandbox · Routing · Update · Terminal · Hooks · MCP'],
             '#e0f2fe', '#0ea5e9')
    draw_box(ax, 1.5, 4.1, 7, 1.0,  ['Agent 运行时层',
             'Model · Tools · Skills中间件 · Memory · MCP · Background Tasks'],
             '#dcfce7', '#22c55e')

    # 下半两列
    draw_box(ax, 0.4, 2.2, 4.2, 1.6,
             ['安全执行控制层',
              'Windows沙箱 / HITL审批',
              'Hooks引擎 · 凭据隔离',
              '敏感目录黑名单'],
             '#fee2e2', '#ef4444')
    draw_box(ax, 5.4, 2.2, 4.2, 1.6,
             ['智能决策层',
              '三层模型路由',
              '线程粘性 · 误路由提升',
              '故障转移 · 容量保护'],
             '#fef9c3', '#eab308')

    draw_box(ax, 0.4, 0.3, 9.2, 1.6,
             ['持久化与审计层 · 更新运维层',
              'Checkpoint · Thread · Memory Index · Trace审计',
              '版本完整性校验 · 后台安装 · 自动回滚'],
             '#f3e8ff', '#a855f7')

    for (ya, yb) in [(6.6, 6.35), (5.4, 5.15), (4.1, 3.85)]:
        arr(ax, 5, ya, 5, yb, '#94a3b8', 2)

    save(fig, 'fig1_architecture.png')


# ─────────────────────────────────────────────────────────────────────────────
# 图2  四层沙箱（梯形）
# ─────────────────────────────────────────────────────────────────────────────
def fig2():
    fig, ax = plt.subplots(figsize=(11, 7))
    fig.patch.set_facecolor('#f8fafc')
    ax.set_facecolor('#f8fafc')
    ax.set_xlim(0, 10); ax.set_ylim(0, 8)
    ax.axis('off')
    ax.set_title('图2  四层沙箱安全防护体系', fontsize=14, fontweight='bold',
                 color='#1e293b', pad=12)

    layers = [
        ('#fef2f2','#ef4444', '① 第一层：Windows 沙箱执行层',
         '四模式可配：none / readonly / unelevated / elevated  ·  HITL 人机协同审批闭环'),
        ('#fff7ed','#f97316', '② 第二层：Hooks 前置拦截层',
         'PreToolUse 策略决策  ·  Shell Hook + Prompt Hook  ·  拦截后不进入 HITL 审批'),
        ('#fffbeb','#eab308', '③ 第三层：凭据隔离层',
         'SSRF 防护（DNS解析校验）·  主进程代理凭据  ·  日志脱敏输出'),
        ('#f0fdf4','#22c55e', '④ 第四层：Skill 安全防护层',
         '启用时静态扫描  ·  结构化风险报告  ·  高风险 Skill 进入审核队列'),
    ]
    for i, (fill, edge, title, sub) in enumerate(layers):
        indent = i * 0.35
        y = 5.8 - i * 1.55
        draw_box(ax, indent, y, 10-2*indent, 1.3,
                 [title, sub], fill, edge, radius=0.25, fontsize=11)
        # badge circle
        circle = plt.Circle((indent+0.35, y+0.65), 0.28,
                             color=edge, zorder=5)
        ax.add_patch(circle)
        ax.text(indent+0.35, y+0.65, str(i+1),
                ha='center', va='center', fontsize=11,
                fontweight='bold', color='white', zorder=6)

    save(fig, 'fig2_sandbox_layers.png')


# ─────────────────────────────────────────────────────────────────────────────
# 图3  SSRF 防护流程
# ─────────────────────────────────────────────────────────────────────────────
def fig3():
    fig, ax = plt.subplots(figsize=(9, 7))
    fig.patch.set_facecolor('#f8fafc')
    ax.set_facecolor('#f8fafc')
    ax.set_xlim(0, 9); ax.set_ylim(0, 9)
    ax.axis('off')
    ax.set_title('图3  SSRF 防护流程', fontsize=14, fontweight='bold',
                 color='#1e293b', pad=12)

    nodes = [
        (2.5, 7.5, 4, 0.9, ['用户填写 baseUrl'], '#dbeafe','#3b82f6'),
        (2.5, 6.0, 4, 0.9, ['DNS 解析域名'], '#e0f2fe','#0ea5e9'),
        (2.5, 4.5, 4, 0.9, ['IP 范围检查','RFC 1918 / 回环 / Link-local / CGNAT'], '#fef9c3','#eab308'),
        (2.5, 3.0, 4, 0.9, ['允许保存配置','推理端点生效'], '#dcfce7','#22c55e'),
    ]
    for (x,y,w,h,txt,fill,edge) in nodes:
        draw_box(ax, x, y, w, h, txt, fill, edge)

    # 拒绝节点
    draw_box(ax, 7.2, 4.2, 1.5, 0.9, ['拒绝保存','提示风险'],
             '#fee2e2','#ef4444', fontsize=10)

    for ya, yb in [(7.5, 7.05),(6.0, 5.55),(4.5, 4.05),(3.0, 3.9)]:
        if ya == 3.0:
            break
        arr(ax, 4.5, ya, 4.5, yb)
    arr(ax, 4.5, 4.5, 4.5, 4.05)
    arr(ax, 4.5, 3.95, 4.5, 3.9)

    # 右分支
    arr(ax, 6.5, 4.95, 7.2, 4.65, '#ef4444', 2)
    ax.text(6.75, 5.1, '命中私有IP', fontsize=9.5, color='#dc2626', ha='center')
    ax.text(4.5, 4.25, '非私有IP', fontsize=9.5, color='#16a34a', ha='center')

    save(fig, 'fig3_ssrf_flow.png')


# ─────────────────────────────────────────────────────────────────────────────
# 图4  四层记忆结构
# ─────────────────────────────────────────────────────────────────────────────
def fig4():
    fig, ax = plt.subplots(figsize=(11, 6.5))
    fig.patch.set_facecolor('#f8fafc')
    ax.set_facecolor('#f8fafc')
    ax.set_xlim(0, 10); ax.set_ylim(0, 7)
    ax.axis('off')
    ax.set_title('图4  四层记忆结构', fontsize=14, fontweight='bold',
                 color='#1e293b', pad=12)

    layers = [
        ('#eff6ff','#3b82f6','组织记忆层','行内规范 · 架构约束 · 安全红线 · 合规要求','跨项目共享'),
        ('#f0fdf4','#22c55e','项目记忆层','项目背景 · 技术决策 · 依赖关系 · 接口约束','项目生命周期'),
        ('#fff7ed','#f97316','线程记忆层','会话摘要 · 中间结论 · 代码片段 · 操作历史','线程级持久化'),
        ('#fdf4ff','#a855f7','会话记忆层','即时上下文 · 当前任务状态 · 临时变量','当前会话'),
    ]
    for i, (fill, edge, title, sub, scope) in enumerate(layers):
        indent = i * 0.3
        y = 5.2 - i * 1.35
        w = 10 - 2*indent - 0.8
        draw_box(ax, indent, y, w, 1.1, [title, sub], fill, edge, radius=0.2)
        # scope badge on right
        bx = indent + w - 0.1
        badge = FancyBboxPatch((bx - 1.5, y + 0.3), 1.4, 0.5,
                               boxstyle="round,pad=0,rounding_size=0.15",
                               facecolor=edge, edgecolor=edge, alpha=0.9, zorder=5)
        ax.add_patch(badge)
        ax.text(bx - 0.8, y + 0.55, scope, ha='center', va='center',
                fontsize=9, fontweight='bold', color='white', zorder=6)

    save(fig, 'fig4_memory_layers.png')


# ─────────────────────────────────────────────────────────────────────────────
# 图5  双路 BM25 检索
# ─────────────────────────────────────────────────────────────────────────────
def fig5():
    fig, ax = plt.subplots(figsize=(11, 7.5))
    fig.patch.set_facecolor('#f8fafc')
    ax.set_facecolor('#f8fafc')
    ax.set_xlim(0, 10); ax.set_ylim(0, 8)
    ax.axis('off')
    ax.set_title('图5  中英双路 BM25 混合检索架构', fontsize=14,
                 fontweight='bold', color='#1e293b', pad=12)

    # 顶部输入
    draw_box(ax, 3, 6.6, 4, 0.9, ['用户查询','（中英文混合输入）'],
             '#dbeafe','#3b82f6')

    # 分叉
    arr(ax, 4, 6.6, 1.8, 5.65, '#94a3b8', 2)
    arr(ax, 6, 6.6, 8.2, 5.65, '#94a3b8', 2)

    # 英文路径
    draw_box(ax, 0.2, 4.6, 3.2, 0.9, ['英文路径','SQLite FTS3 全词倒排索引'],
             '#e0f2fe','#0ea5e9')
    draw_box(ax, 0.2, 3.3, 3.2, 0.9, ['MATCH 精确匹配','高效 · 无分词误差'],
             '#bfdbfe','#3b82f6')

    # 中文路径
    draw_box(ax, 6.6, 4.6, 3.2, 0.9, ['中文路径','CJK Bigram 双字切片'],
             '#fef9c3','#eab308')
    draw_box(ax, 6.6, 3.3, 3.2, 0.9, ['LIKE 子句匹配','解决中文无词边界问题'],
             '#fde68a','#d97706')

    arr(ax, 1.8, 4.6, 1.8, 4.25); arr(ax, 8.2, 4.6, 8.2, 4.25)
    arr(ax, 1.8, 3.3, 1.8, 2.95); arr(ax, 8.2, 3.3, 8.2, 2.95)

    # 合并
    arr(ax, 1.8, 2.95, 4.2, 2.1, '#94a3b8', 2)
    arr(ax, 8.2, 2.95, 5.8, 2.1, '#94a3b8', 2)

    draw_box(ax, 2.0, 1.1, 6, 0.9,
             ['结果合并去重 → BM25 相关性排序 → Top-K 注入 Agent 上下文'],
             '#dcfce7','#22c55e')

    save(fig, 'fig5_bm25_retrieval.png')


# ─────────────────────────────────────────────────────────────────────────────
# 图6  Prompt Hook 流程
# ─────────────────────────────────────────────────────────────────────────────
def fig6():
    fig, ax = plt.subplots(figsize=(11, 9))
    fig.patch.set_facecolor('#f8fafc')
    ax.set_facecolor('#f8fafc')
    ax.set_xlim(0, 10); ax.set_ylim(0, 10)
    ax.axis('off')
    ax.set_title('图6  自然语言策略 Hook（Prompt Hook）执行流程',
                 fontsize=14, fontweight='bold', color='#1e293b', pad=12)

    steps = [
        (3, 8.6, 4, 0.85, ['管理员配置自然语言策略',
          '"如未标注审批工单号，禁止执行 DDL 操作"'], '#dbeafe','#3b82f6'),
        (3, 7.2, 4, 0.85, ['Agent 触发 PreToolUse 事件', ''], '#e0f2fe','#0ea5e9'),
        (3, 5.8, 4, 0.85, ['Hook 引擎提取工具调用上下文',
          '工具名 · 完整参数 · 对话历史摘要'], '#fef9c3','#eab308'),
        (3, 4.2, 4, 0.85, ['Prompt Hook 执行引擎',
          '构造 Prompt → 调用行内 LLM → 解析决策 JSON'], '#f3e8ff','#a855f7'),
    ]
    for (x,y,w,h,txt,fill,edge) in steps:
        draw_box(ax, x, y, w, h, txt, fill, edge)

    for ya, yb in [(8.6,7.2),(7.2,5.8),(5.8,4.2)]:
        arr(ax, 5, ya, 5, yb)

    # 超时熔断
    draw_box(ax, 7.7, 4.0, 2.1, 0.85, ['LLM超时','按 fallback 降级'],
             '#fee2e2','#ef4444', fontsize=10)
    arr(ax, 7.0, 4.65, 7.7, 4.42, '#ef4444', 2)
    ax.text(7.35, 4.78, '超时', fontsize=9.5, color='#dc2626', ha='center')

    # 分叉决策
    arr(ax, 5, 4.2, 5, 3.5)
    draw_box(ax, 1.0, 2.5, 3.4, 0.85, ['allow','工具正常执行'],
             '#dcfce7','#22c55e')
    draw_box(ax, 5.6, 2.5, 3.4, 0.85, ['block','拦截 · 返回拒绝原因'],
             '#fee2e2','#ef4444')
    arr(ax, 5, 3.5, 2.7, 3.35, '#22c55e', 2)
    arr(ax, 5, 3.5, 7.3, 3.35, '#ef4444', 2)
    ax.text(3.3, 3.55, 'allow', fontsize=10, color='#16a34a', fontweight='bold')
    ax.text(6.3, 3.55, 'block', fontsize=10, color='#dc2626', fontweight='bold')

    # 审计留痕
    draw_box(ax, 1.5, 1.2, 7, 0.85,
             ['决策结果写入 Trace 链路（allow / block / error + reason）'],
             '#f1f5f9','#94a3b8', fontsize=10, bold_first=False)
    arr(ax, 2.7, 2.5, 3.5, 2.07, '#94a3b8', 1.5)
    arr(ax, 7.3, 2.5, 6.5, 2.07, '#94a3b8', 1.5)

    save(fig, 'fig6_prompt_hook.png')


# ─────────────────────────────────────────────────────────────────────────────
# 图7  Skill 生命周期
# ─────────────────────────────────────────────────────────────────────────────
def fig7():
    fig, ax = plt.subplots(figsize=(11, 9))
    fig.patch.set_facecolor('#f8fafc')
    ax.set_facecolor('#f8fafc')
    ax.set_xlim(0, 10); ax.set_ylim(0, 10)
    ax.axis('off')
    ax.set_title('图7  Skill 生命周期治理流程', fontsize=14,
                 fontweight='bold', color='#1e293b', pad=12)

    steps = [
        ('#dbeafe','#3b82f6','① 上传 Skill',          'SKILL.md / .zip 格式，name 字段去重校验'),
        ('#fef9c3','#eab308','② 安全扫描',             '危险指令 · 凭据路径 · 命令注入 · 网络外传检测'),
        ('#dcfce7','#22c55e','③ 启用注册',             '写入 manifest · 缓存目录签名 · 失效旧缓存'),
        ('#e0f2fe','#0ea5e9','④ workspace 过滤',       'glob 匹配工作区路径 · 不匹配则不注入 System Prompt'),
        ('#f3e8ff','#a855f7','⑤ depends-on 依赖解析', '递归加载依赖 Skill · 循环依赖检测 · 深度上限保护'),
        ('#fff7ed','#f97316','⑥ 上下文注入 / 路由',   'System Prompt 注入  ·  /slash-command 精准触发'),
    ]
    total = len(steps)
    for i, (fill, edge, title, sub) in enumerate(steps):
        y = 8.4 - i * 1.35
        draw_box(ax, 1.5, y, 7, 1.0, [title, sub], fill, edge)
        if i < total - 1:
            arr(ax, 5, y, 5, y - 0.35)

    # 扫描失败分支
    scan_y = 8.4 - 1 * 1.35
    draw_box(ax, 0.1, scan_y+0.05, 1.2, 0.9, ['高风险','审核队列'],
             '#fee2e2','#ef4444', fontsize=9.5)
    arr(ax, 1.5, scan_y + 0.5, 1.3, scan_y + 0.5, '#ef4444', 2)
    ax.text(1.38, scan_y + 0.62, '↑', fontsize=9, color='#dc2626', ha='center')

    save(fig, 'fig7_skill_lifecycle.png')


# ─────────────────────────────────────────────────────────────────────────────
# 图8  综合能力对比柱状图
# ─────────────────────────────────────────────────────────────────────────────
def fig8():
    fig, ax = plt.subplots(figsize=(13, 6))
    fig.patch.set_facecolor('#f8fafc')
    ax.set_facecolor('#f8fafc')

    categories = ['沙箱防护\n层数', '中文记忆\n准确率(%)', 'Token\n压缩率(%)',
                  '首Token延迟\n降低(%)', 'SSRF防护\n覆盖率(%)', 'Skill安全\n扫描覆盖(%)']
    baseline = [25, 41, 0, 0, 0, 0]
    ours     = [100,87, 77,67,100,100]

    x = np.arange(len(categories))
    w = 0.32
    b1 = ax.bar(x-w/2, baseline, w, label='引入式方案（基线）',
                color='#93c5fd', edgecolor='#3b82f6', linewidth=1, zorder=3)
    b2 = ax.bar(x+w/2, ours,     w, label='本项目',
                color='#6ee7b7', edgecolor='#059669', linewidth=1, zorder=3)

    for bar, v in zip(b1, baseline):
        if v > 0:
            ax.text(bar.get_x()+bar.get_width()/2, v+1.5, str(v),
                    ha='center', va='bottom', fontsize=10, color='#1e40af')
    for bar, v in zip(b2, ours):
        ax.text(bar.get_x()+bar.get_width()/2, v+1.5, str(v),
                ha='center', va='bottom', fontsize=10.5,
                color='#065f46', fontweight='bold')

    ax.set_xticks(x); ax.set_xticklabels(categories, fontsize=10.5)
    ax.set_ylim(0, 120)
    ax.set_ylabel('得分 / 百分比', fontsize=10, color='#475569')
    ax.set_title('图8  与引入式方案综合能力对比', fontsize=13,
                 fontweight='bold', color='#1e293b', pad=14)
    ax.legend(fontsize=10.5, framealpha=0.7)
    ax.yaxis.grid(True, linestyle='--', alpha=0.4, zorder=0)
    ax.spines[['top','right']].set_visible(False)

    fig.patch.set_facecolor('#f8fafc')
    plt.tight_layout()
    save(fig, 'fig8_compare_bar.png')


# ─────────────────────────────────────────────────────────────────────────────
# 图9  记忆检索准确率
# ─────────────────────────────────────────────────────────────────────────────
def fig9():
    fig, ax = plt.subplots(figsize=(8, 5.5))
    fig.patch.set_facecolor('#f8fafc')
    ax.set_facecolor('#f8fafc')

    methods   = ['单路英文 FTS3\n（引入式方案）', '双路 BM25\n中英混合（本项目）']
    accuracy  = [41, 87]
    latency   = [12, 28]
    colors    = ['#93c5fd','#6ee7b7']
    edges     = ['#3b82f6','#059669']

    bars = ax.bar(methods, accuracy, color=colors, edgecolor=edges,
                  linewidth=1.5, width=0.4, zorder=3)
    for bar, acc, lat in zip(bars, accuracy, latency):
        ax.text(bar.get_x()+bar.get_width()/2, acc+1.5,
                f'{acc}%\n耗时 {lat}ms', ha='center', va='bottom',
                fontsize=11.5, fontweight='bold', color='#1e293b')

    ax.set_ylim(0, 108)
    ax.set_ylabel('Top-5 准确率 (%)', fontsize=11, color='#475569')
    ax.set_title('图9  中文记忆检索准确率对比（500条测试集）',
                 fontsize=13, fontweight='bold', color='#1e293b', pad=12)
    ax.yaxis.grid(True, linestyle='--', alpha=0.4, zorder=0)
    ax.spines[['top','right']].set_visible(False)

    ax.annotate('', xy=(1, 90), xytext=(0, 44),
                arrowprops=dict(arrowstyle='->', color='#dc2626', lw=2.5))
    ax.text(0.5, 72, '+46 个百分点', ha='center', fontsize=12.5,
            color='#dc2626', fontweight='bold')

    plt.tight_layout()
    save(fig, 'fig9_memory_accuracy.png')


# ─────────────────────────────────────────────────────────────────────────────
# 图10  Token 压缩 & 延迟
# ─────────────────────────────────────────────────────────────────────────────
def fig10():
    fig, axes = plt.subplots(1, 2, figsize=(12, 5.5))
    fig.patch.set_facecolor('#f8fafc')

    # 左：Token 数
    ax1 = axes[0]; ax1.set_facecolor('#f8fafc')
    labels = ['全量注入\n（无过滤）', 'workspace\n过滤（本项目）']
    tokens = [18000, 4200]
    colors = ['#fca5a5','#6ee7b7']
    edges  = ['#ef4444','#059669']
    bars = ax1.bar(labels, tokens, color=colors, edgecolor=edges, linewidth=1.5,
                   width=0.4, zorder=3)
    for bar, v in zip(bars, tokens):
        ax1.text(bar.get_x()+bar.get_width()/2, v+250,
                 f'{v:,} tokens', ha='center', va='bottom',
                 fontsize=11.5, fontweight='bold', color='#1e293b')
    ax1.set_ylim(0, 22000)
    ax1.set_ylabel('System Prompt Token 数', fontsize=10, color='#475569')
    ax1.set_title('Token 消耗对比', fontsize=12, color='#1e293b', fontweight='bold')
    ax1.yaxis.grid(True, linestyle='--', alpha=0.4, zorder=0)
    ax1.spines[['top','right']].set_visible(False)
    ax1.annotate('', xy=(1, 4500), xytext=(0, 18200),
                arrowprops=dict(arrowstyle='->', color='#dc2626', lw=2.5))
    ax1.text(0.5, 12500, '压缩 77%', ha='center', fontsize=13,
             color='#dc2626', fontweight='bold')

    # 右：首 Token 延迟
    ax2 = axes[1]; ax2.set_facecolor('#f8fafc')
    delays = [1.8, 0.6]
    bars2  = ax2.bar(labels, delays, color=colors, edgecolor=edges, linewidth=1.5,
                     width=0.4, zorder=3)
    for bar, v in zip(bars2, delays):
        ax2.text(bar.get_x()+bar.get_width()/2, v+0.04,
                 f'{v}s', ha='center', va='bottom',
                 fontsize=12.5, fontweight='bold', color='#1e293b')
    ax2.set_ylim(0, 2.5)
    ax2.set_ylabel('首 Token 延迟 (s)', fontsize=10, color='#475569')
    ax2.set_title('模型首 Token 延迟对比', fontsize=12, color='#1e293b', fontweight='bold')
    ax2.yaxis.grid(True, linestyle='--', alpha=0.4, zorder=0)
    ax2.spines[['top','right']].set_visible(False)
    ax2.annotate('', xy=(1, 0.66), xytext=(0, 1.84),
                arrowprops=dict(arrowstyle='->', color='#dc2626', lw=2.5))
    ax2.text(0.5, 1.32, '降低 67%', ha='center', fontsize=13,
             color='#dc2626', fontweight='bold')

    fig.suptitle('图10  Skill workspace 过滤效果（30 个 Skill 测试环境）',
                 fontsize=13, fontweight='bold', color='#1e293b', y=1.01)
    plt.tight_layout()
    save(fig, 'fig10_token_compare.png')


# ─────────────────────────────────────────────────────────────────────────────
# 图4 重绘：per-fact 记忆体系与 Dream 整合架构
# ─────────────────────────────────────────────────────────────────────────────
def fig4():
    fig, ax = plt.subplots(figsize=(13, 8))
    fig.patch.set_facecolor('#f8fafc')
    ax.set_facecolor('#f8fafc')
    ax.set_xlim(0, 13); ax.set_ylim(0, 8)
    ax.axis('off')
    ax.set_title('图4  per-fact 记忆体系与 Dream 整合架构', fontsize=14, fontweight='bold',
                 color='#1e293b', pad=14)

    # 对话输入
    draw_box(ax, 4.5, 6.8, 4, 0.8, ['对话结束触发', 'summarizeAndSave()'],
             '#dbeafe', '#3b82f6', fontsize=10)

    # LLM 抽取
    draw_box(ax, 3.8, 5.5, 5.4, 0.9, ['行内 LLM 自动抽取',
             'create · update · skip 操作集 + 更新 MEMORY.md'],
             '#ede9fe', '#7c3aed', fontsize=10)

    arr(ax, 6.5, 6.8, 6.5, 6.4)

    # MEMORY.md
    draw_box(ax, 0.3, 4.0, 2.8, 1.0, ['MEMORY.md', '注入每次对话 (200行/25KB)'],
             '#fef3c7', '#d97706', fontsize=10)
    arr(ax, 5.0, 5.5, 2.0, 5.0, '#d97706')
    ax.annotate('', xy=(1.7, 4.0), xytext=(1.7, 4.95),
                arrowprops=dict(arrowstyle='->', color='#d97706', lw=1.8))

    # 四类文件
    type_data = [
        (0.3,  2.3, 'user_xxx.md',      'user\n角色·偏好·风格',         '#dbeafe', '#3b82f6'),
        (3.5,  2.3, 'feedback_xxx.md',  'feedback\n纠正·约定·Why归因',   '#dcfce7', '#16a34a'),
        (6.7,  2.3, 'project_xxx.md',   'project\n决策·技术债·合规',     '#fef3c7', '#d97706'),
        (9.9,  2.3, 'reference_xxx.md', 'reference\n外部系统指针',        '#f3e8ff', '#9333ea'),
    ]
    for (x, y, fn, label, fc, ec) in type_data:
        draw_box(ax, x, y, 2.8, 1.1, [fn, label], fc, ec, fontsize=9)
        arr(ax, 6.5, 5.5, x + 1.4, y + 1.1)

    # BM25 索引
    draw_box(ax, 4.5, 0.7, 4, 0.9, ['BM25 搜索索引', 'FTS3(英文) + CJK bigram(中文)  recall_count↑'],
             '#f1f5f9', '#64748b', fontsize=10)
    for x in [1.7, 4.9, 8.1, 11.3]:
        arr(ax, x, 2.3, 6.5, 1.6)

    # Dream 整合
    draw_box(ax, 9.5, 4.0, 3.2, 1.5,
             ['Dream 整合引擎', '7天+5会话自动触发', 'merge · create_meta · archive'],
             '#fce7f3', '#db2777', fontsize=9)
    ax.annotate('', xy=(9.5, 4.75), xytext=(8.2, 4.75),
                arrowprops=dict(arrowstyle='->', color='#db2777', lw=2,
                                connectionstyle='arc3,rad=0'))
    ax.annotate('', xy=(6.5, 4.0), xytext=(9.5, 4.0),
                arrowprops=dict(arrowstyle='->', color='#db2777', lw=1.5,
                                connectionstyle='arc3,rad=-0.3'))
    ax.text(10.9, 3.55, 'merge/archive\nper-fact files', ha='center',
            fontsize=8.5, color='#db2777', style='italic')

    # recall 标注
    ax.text(6.5, 1.25, 'recall_count 驱动 Dream 候选优先级', ha='center',
            fontsize=9, color='#64748b', style='italic')

    plt.tight_layout()
    save(fig, 'fig4_memory_layers.png')


# ─────────────────────────────────────────────────────────────────────────────
# 图11  Dream 自主整合执行流程
# ─────────────────────────────────────────────────────────────────────────────
def fig11():
    fig, ax = plt.subplots(figsize=(11, 9))
    fig.patch.set_facecolor('#f8fafc')
    ax.set_facecolor('#f8fafc')
    ax.set_xlim(0, 11); ax.set_ylim(0, 9)
    ax.axis('off')
    ax.set_title('图11  Dream 自主整合执行流程', fontsize=14, fontweight='bold',
                 color='#1e293b', pad=14)

    # 触发条件
    draw_box(ax, 2.5, 7.8, 6, 0.8,
             ['触发条件（满足其一）',
              '自动：距上次整合 ≥7天 AND (会话 ≥5次 OR 新增事实 ≥20条)  |  手动：Memory 面板点击 Dream 按钮'],
             '#ede9fe', '#7c3aed', fontsize=9, bold_first=True)

    arr(ax, 5.5, 7.8, 5.5, 7.3)

    # 候选筛选
    draw_box(ax, 2.5, 6.4, 6, 0.7,
             ['候选筛选（无需 LLM）',
              '按 recall_count=0 + 年龄 + 最近更新 打分，取 Top-100 文件'],
             '#f1f5f9', '#64748b', fontsize=9)
    arr(ax, 5.5, 6.4, 5.5, 5.9)

    # LLM 整合
    draw_box(ax, 2.5, 5.0, 6, 0.7,
             ['行内 LLM 整合分析',
              '发送：文件头 + recall统计 + 前800字正文 → 输出操作 JSON'],
             '#dbeafe', '#3b82f6', fontsize=9)
    arr(ax, 5.5, 5.0, 5.5, 4.5)

    # 三种操作
    ops = [
        (0.4, 2.9, 3.0, 1.2, ['merge', '合并语义重复条目\n→ 写入新合并文件\n→ 源文件归档'],  '#dcfce7', '#16a34a'),
        (3.8, 2.9, 3.4, 1.2, ['create_meta', '3条以上同向 feedback\n→ 提炼元规律\n→ 写入新 meta 文件'], '#fef3c7', '#d97706'),
        (7.6, 2.9, 3.0, 1.2, ['archive', '180天+0召回\n→ 移至 archive/\n(安全，不删除)'], '#fce7f3', '#db2777'),
    ]
    for (x, y, w, h, lines, fc, ec) in ops:
        draw_box(ax, x, y, w, h, lines, fc, ec, fontsize=9)
        arr(ax, 5.5, 4.5, x + w/2, y + h)

    # 安全守卫
    draw_box(ax, 1.5, 1.5, 8, 0.75,
             ['安全守卫（硬规则，LLM 建议必须通过）',
              'user 类型永不归档 · recall_count>0 不归档 · 30天内新文件不归档 · 文件只移动不删除'],
             '#fef2f2', '#dc2626', fontsize=9)
    arr(ax, 5.5, 2.9, 5.5, 2.25)

    # 完成
    draw_box(ax, 3.0, 0.4, 5, 0.7,
             ['整合完成', '更新 MEMORY.md · 重建搜索索引 · 更新 .dream_state.json · 面板刷新'],
             '#d1fae5', '#059669', fontsize=9)
    arr(ax, 5.5, 1.5, 5.5, 1.1)

    plt.tight_layout()
    save(fig, 'fig11_dream_flow.png')


# ─────────────────────────────────────────────────────────────────────────────
# 图12  Memory 面板实际使用效果（UI 模拟图）
# ─────────────────────────────────────────────────────────────────────────────
def fig12():
    fig, ax = plt.subplots(figsize=(13, 8))
    fig.patch.set_facecolor('#0f172a')
    ax.set_facecolor('#0f172a')
    ax.set_xlim(0, 13); ax.set_ylim(0, 8)
    ax.axis('off')
    ax.set_title('图12  Memory 面板实际使用效果', fontsize=14, fontweight='bold',
                 color='#f1f5f9', pad=14)

    # 左侧边栏背景
    sidebar = FancyBboxPatch((0.2, 0.2), 4.0, 7.4,
                              boxstyle='round,pad=0,rounding_size=0.2',
                              facecolor='#1e293b', edgecolor='#334155', linewidth=1.5)
    ax.add_patch(sidebar)

    # 标题区
    ax.text(0.7, 7.25, 'Memory', color='#f1f5f9', fontsize=13, fontweight='bold')
    # 已启用 badge
    en_badge = FancyBboxPatch((2.2, 7.05), 0.9, 0.35,
                               boxstyle='round,pad=0,rounding_size=0.15',
                               facecolor='#14532d', edgecolor='#16a34a', linewidth=1)
    ax.add_patch(en_badge)
    ax.text(2.65, 7.22, '已启用', color='#4ade80', fontsize=8, ha='center', va='center')
    # Dream badge
    dream_badge = FancyBboxPatch((3.2, 7.05), 0.85, 0.35,
                                  boxstyle='round,pad=0,rounding_size=0.15',
                                  facecolor='#3b0764', edgecolor='#9333ea', linewidth=1)
    ax.add_patch(dream_badge)
    ax.text(3.625, 7.22, '✦ Dream', color='#c084fc', fontsize=8, ha='center', va='center')

    # 统计行
    ax.text(0.5, 6.7, '12 个文件  48.3 KB  索引 156 KB  整合: 今天 · 3次对话',
            color='#64748b', fontsize=7.5)

    # info bar
    info = FancyBboxPatch((0.3, 6.3), 3.8, 0.3,
                           boxstyle='round,pad=0,rounding_size=0.1',
                           facecolor='#1e293b', edgecolor='#334155', linewidth=1)
    ax.add_patch(info)
    ax.text(0.6, 6.45, 'ℹ  记忆系统会自动总结对话并在后续会话中回忆',
            color='#94a3b8', fontsize=7.5)

    # MEMORY.md 条目
    mem_row = FancyBboxPatch((0.3, 5.85), 3.8, 0.35,
                              boxstyle='round,pad=0,rounding_size=0.1',
                              facecolor='#0f172a', edgecolor='#334155', linewidth=1)
    ax.add_patch(mem_row)
    ax.text(0.6, 6.02, '📄', fontsize=9)
    ax.text(0.95, 6.02, 'MEMORY.md', color='#6366f1', fontsize=9, fontweight='bold')
    ax.text(0.95, 5.88, '索引文件 · 注入到每次对话', color='#64748b', fontsize=7)

    # 分组标题 USER
    ax.text(0.5, 5.6, '👤  USER  · 2', color='#94a3b8', fontsize=7.5, fontstyle='italic')

    user_items = [
        ('工程师角色背景', 'user_role_engineer.md', '高级 Electron 工程师，10年经验', 8),
        ('偏好简短回复', 'user_prefer_terse.md', '不喜欢冗长说明，倾向简洁直接', 0),
    ]
    y = 5.1
    for (name, fn, desc, recall) in user_items:
        row = FancyBboxPatch((0.3, y - 0.05), 3.8, 0.4,
                              boxstyle='round,pad=0,rounding_size=0.1',
                              facecolor='#0f172a', edgecolor='#1e3a5f', linewidth=1)
        ax.add_patch(row)
        ax.text(0.55, y + 0.25, '●', color='#3b82f6', fontsize=8)
        ax.text(0.75, y + 0.25, name, color='#e2e8f0', fontsize=8.5)
        ax.text(0.75, y + 0.08, desc, color='#64748b', fontsize=7)
        if recall > 0:
            rb = FancyBboxPatch((3.7, y + 0.12), 0.3, 0.22,
                                 boxstyle='round,pad=0,rounding_size=0.08',
                                 facecolor='#78350f', edgecolor='#d97706', linewidth=0.8)
            ax.add_patch(rb)
            ax.text(3.85, y + 0.22, f'{recall}×', color='#fbbf24',
                    fontsize=7.5, ha='center', va='center', fontweight='bold')
        y -= 0.5

    # FEEDBACK 分组
    ax.text(0.5, 3.9, '💬  FEEDBACK  · 3', color='#94a3b8', fontsize=7.5, fontstyle='italic')
    fb_items = [
        ('禁止 mock 数据库', '3次召回验证，强偏好集成测试', 3),
        ('优先使用 TypeScript', '所有新文件统一用 TS', 12),
        ('不要末尾摘要', '直接行动，不复述操作内容', 1),
    ]
    y = 3.4
    for (name, desc, recall) in fb_items:
        row = FancyBboxPatch((0.3, y - 0.05), 3.8, 0.4,
                              boxstyle='round,pad=0,rounding_size=0.1',
                              facecolor='#0f172a', edgecolor='#422006', linewidth=1)
        ax.add_patch(row)
        ax.text(0.55, y + 0.25, '●', color='#f59e0b', fontsize=8)
        ax.text(0.75, y + 0.25, name, color='#e2e8f0', fontsize=8.5)
        ax.text(0.75, y + 0.08, desc, color='#64748b', fontsize=7)
        color = '#78350f' if recall < 10 else '#431407'
        badge_c = '#d97706' if recall < 10 else '#dc2626'
        text_c = '#fbbf24' if recall < 10 else '#fca5a5'
        rb = FancyBboxPatch((3.7, y + 0.12), 0.3, 0.22,
                             boxstyle='round,pad=0,rounding_size=0.08',
                             facecolor=color, edgecolor=badge_c, linewidth=0.8)
        ax.add_patch(rb)
        ax.text(3.85, y + 0.22, f'{recall}×', color=text_c,
                fontsize=7.5, ha='center', va='center', fontweight='bold')
        y -= 0.5

    # Dream 整合结果横幅
    dream_banner = FancyBboxPatch((0.3, 0.5), 3.8, 0.55,
                                   boxstyle='round,pad=0,rounding_size=0.12',
                                   facecolor='#1e1035', edgecolor='#9333ea', linewidth=1.5)
    ax.add_patch(dream_banner)
    ax.text(0.55, 0.88, '✦', color='#c084fc', fontsize=10)
    ax.text(0.85, 0.88, '整合完成：合并 2 条 · 新增 1 条元规律 · 跳过 8 条',
            color='#e9d5ff', fontsize=8.5, va='center')
    ax.text(0.85, 0.65, '• 合并: "偏好 TS" + "避免 JS" → feedback_ts_preference.md',
            color='#a78bfa', fontsize=7.5)

    # 右侧内容区背景
    content_bg = FancyBboxPatch((4.5, 0.2), 8.3, 7.4,
                                  boxstyle='round,pad=0,rounding_size=0.2',
                                  facecolor='#1e293b', edgecolor='#334155', linewidth=1.5)
    ax.add_patch(content_bg)

    # 右侧文件头
    ax.text(4.8, 7.3, 'feedback_no_db_mock.md', color='#f1f5f9', fontsize=11, fontweight='bold')
    ax.text(4.8, 7.05, '1.2 KB · 修改于 2026-04-08 14:32', color='#64748b', fontsize=8)

    # 文件内容
    content_lines = [
        ('---', '#64748b'),
        ('name: 禁止 mock 数据库', '#94a3b8'),
        ('description: 集成测试必须连接真实数据库，3次验证', '#94a3b8'),
        ('type: feedback', '#c084fc'),
        ('---', '#64748b'),
        ('', ''),
        ('测试里不要 mock 数据库，上季度 mock 测试通过但生产迁移', '#e2e8f0'),
        ('失败，已造成线上事故。', '#e2e8f0'),
        ('', ''),
        ('**Why:** 模拟层与真实数据库行为差异导致测试通过但', '#e2e8f0'),
        ('生产失败，掩盖了迁移脚本的边界条件 bug。', '#e2e8f0'),
        ('', ''),
        ('**How to apply:** 所有涉及数据库的测试用例必须连接', '#e2e8f0'),
        ('真实测试库，禁止 jest.mock() 替换数据库层。', '#e2e8f0'),
        ('', ''),
        ('⚠️  召回次数: 3 · 最近召回: 今天', '#fbbf24'),
    ]
    y_c = 6.7
    for (line, color) in content_lines:
        if line:
            ax.text(4.8, y_c, line, color=color, fontsize=8,
                    fontfamily='monospace')
        y_c -= 0.33

    plt.tight_layout()
    save(fig, 'fig12_memory_panel.png')


if __name__ == '__main__':
    fig1(); fig2(); fig3(); fig4(); fig5()
    fig6(); fig7(); fig8(); fig9(); fig10()
    fig11(); fig12()
    print('\nAll 12 diagrams generated as PNG.')
