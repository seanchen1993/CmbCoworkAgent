export const mockMd = `
# 完整的 Markdown 功能测试文档

这是一个用于测试所有 Markdown 功能的完整示例文档。

**哈哈**：11
**呵呵**：22
**呵呵**：22

------

- **哈哈**：11  \`tag\`
- **呵呵**：22
- **呵呵**：22

---


## 目录

1. [标题测试](#标题测试)
2. [文本格式化](#文本格式化)
3. [列表功能](#列表功能)
4. [链接和图片](#链接和图片)
5. [代码块](#代码块)
6. [表格](#表格)
7. [引用块](#引用块)
8. [分割线](#分割线)
9. [任务列表](#任务列表)
10. [数学公式](#数学公式)
11. [HTML标签](#html标签)

---

## 标题测试

# 一级标题 H1
## 二级标题 H2
### 三级标题 H3
#### 四级标题 H4
##### 五级标题 H5
###### 六级标题 H6

## 文本格式化

这是**粗体文本**，这是*斜体文本*，这是***粗斜体文本***。

这是~~删除线文本~~，这是\`行内代码\`。

这是一个包含<u>下划线</u>的句子。

这是上标：E=mc²，这是下标：H₂O。

这是==高亮文本==（如果支持）。

## 列表功能

### 无序列表
- 项目 1
- 项目 2
  - 子项目 2.1
  - 子项目 2.2
    - 子子项目 2.2.1
- 项目 3

### 有序列表
1. 第一项
2. 第二项
   1. 子项 2.1
   2. 子项 2.2
3. 第三项

### 定义列表
术语 1
: 这是术语 1 的定义

术语 2
: 这是术语 2 的定义
: 这是术语 2 的另一个定义

## 链接和图片

### 链接测试
- [普通链接](https://github.com)
- [带标题的链接](https://github.com "GitHub 主页")
- [相对链接](./README.md)
- [邮箱链接](mailto:test@example.com)
- <https://example.com>

### 图片测试
![示例图片](https://via.placeholder.com/400x200/0066cc/ffffff?text=测试图片)

![带alt文本的图片](https://via.placeholder.com/200x100/ff6600/ffffff?text=Alt+Text "这是图片标题")

## 代码块

### 行内代码
这是一个 \`console.log("Hello World")\` 行内代码示例。

### 代码块（无语法高亮）
\`\`\`
function hello() {
    console.log("Hello, World!");
}
\`\`\`

### JavaScript 代码块

\`\`\`diff
diff --git a/src/components/UserProfile.tsx b/src/components/UserProfile.tsx
index abc1234..def5678 100644
--- a/src/components/UserProfile.tsx
+++ b/src/components/UserProfile.tsx
@@ -1,10 +1,15 @@
 import React from 'react'
+import { useState } from 'react'
+import { Button } from '@/components/ui/button'
+import { Button } from '@/components/ui/button'
+import { Button } from '@/components/ui/button'
+import { Button } from '@/components/ui/button'
+import { Button } from '@/components/ui/button'
+import { Button } from '@/components/ui/button'
+import { Button } from '@/components/ui/button'
+import { Button } from '@/components/ui/button'
+import { Button } from '@/components/ui/button'
+import { Button } from '@/components/ui/button'

 interface UserProfileProps {
   name: string
-  email: string
+  email?: string
+  avatar?: string
 }

-export function UserProfile({ name, email }: UserProfileProps) {
+export function UserProfile({ name, email, avatar }: UserProfileProps) {
+  const [isFollowing, setIsFollowing] = useState(false)
+
   return (
     <div className="user-profile">
-      <h2>{name}</h2>
-      <p>{email}</p>
+      <div className="flex items-center gap-4">
+        <img src={avatar || '/default-avatar.png'} alt={name} className="w-12 h-12 rounded-full" />
+        <div>
+          <h2 className="text-xl font-semibold">{name}</h2>
+          {email && <p className="text-gray-600">{email}</p>}
+        </div>
+        <Button onClick={() => setIsFollowing(!isFollowing)} variant={isFollowing ? "outline" : "default"}>
+          {isFollowing ? 'Following' : 'Follow'}
+        </Button>
+      </div>
     </div>
   )
 }

\`\`\`

\`\`\`javascript
// JavaScript 示例
function fibonacci(n) {
    if (n <= 1) return n;
    return fibonacci(n - 1) + fibonacci(n - 2);
}

const result = fibonacci(10);
console.log(\`第10个斐波那契数是: \${result}\`);

// ES6+ 特性
const numbers = [1, 2, 3, 4, 5];
const doubled = numbers.map(n => n * 2);
const sum = numbers.reduce((acc, curr) => acc + curr, 0);
\`\`\`

### Python 代码块
\`\`\`python
# Python 示例
import datetime
from typing import List, Dict

class User:
    def __init__(self, name: str, age: int):
        self.name = name
        self.age = age
        self.created_at = datetime.datetime.now()

    def greet(self) -> str:
        return f"Hello, I'm {self.name} and I'm {self.age} years old!"

def process_users(users: List[User]) -> Dict[str, int]:
    return {user.name: user.age for user in users}

# 使用示例
users = [
    User("Alice", 25),
    User("Bob", 30),
    User("Charlie", 35)
]

for user in users:
    print(user.greet())
\`\`\`

### SQL 代码块
\`\`\`sql
-- SQL 示例
CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    username VARCHAR(50) UNIQUE NOT NULL,
    email VARCHAR(100) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO users (username, email, password_hash) VALUES
('alice', 'alice@example.com', 'hash1'),
('bob', 'bob@example.com', 'hash2'),
('charlie', 'charlie@example.com', 'hash3');

SELECT u.username, u.email, COUNT(p.id) as post_count
FROM users u
LEFT JOIN posts p ON u.id = p.user_id
WHERE u.created_at >= '2024-01-01'
GROUP BY u.id, u.username, u.email
ORDER BY post_count DESC
LIMIT 10;
\`\`\`

### JSON 代码块
\`\`\`json
{
  "name": "markdown-preview-test",
  "version": "1.0.0",
  "description": "测试 Markdown 预览功能",
  "dependencies": {
    "react": "^18.0.0",
    "typescript": "^5.0.0"
  },
  "users": [
    {
      "id": 1,
      "name": "张三",
      "email": "zhangsan@example.com",
      "preferences": {
        "theme": "dark",
        "language": "zh-CN",
        "notifications": {
          "email": true,
          "push": false
        }
      }
    }
  ]
}
\`\`\`

### Bash 代码块
\`\`\`bash
#!/bin/bash

# 系统信息脚本
echo "系统信息收集脚本"
echo "=================="

# 检查操作系统
if [[ "$OSTYPE" == "linux-gnu"* ]]; then
    OS="Linux"
elif [[ "$OSTYPE" == "darwin"* ]]; then
    OS="macOS"
elif [[ "$OSTYPE" == "msys" ]]; then
    OS="Windows"
else
    OS="Unknown"
fi

echo "操作系统: $OS"
echo "当前用户: $(whoami)"
echo "当前目录: $(pwd)"
echo "系统时间: $(date)"

# 磁盘空间检查
echo "磁盘使用情况:"
df -h | head -5
\`\`\`

## 表格

### 基本表格
| 姓名 | 年龄 | 职业 | 城市 |
|------|------|------|------|
| 张三 | 25 | 工程师 | 北京 |
| 李四 | 30 | 设计师 | 上海 |
| 王五 | 28 | 产品经理 | 深圳 |

### 对齐表格
| 左对齐 | 居中对齐 | 右对齐 | 默认 |
|:-------|:--------:|-------:|------|
| 内容A  | 内容B    | 内容C  | 内容D |
| 这是一个很长的内容 | 短内容 | 123456 | 测试 |

### 复杂表格
| 功能 | 状态 | 优先级 | 负责人 | 预计完成时间 | 备注 |
|------|:----:|:------:|--------|:------------:|------|
| 用户登录 | ✅ 完成 | 高 | 张三 | 2024-03-01 | 已上线 |
| 数据导出 | 🚧 进行中 | 中 | 李四 | 2024-03-15 | 70% 完成 |
| 报表生成 | 📋 待开始 | 低 | 王五 | 2024-04-01 | 依赖数据导出 |
| API 优化 | ❌ 暂停 | 高 | 赵六 | TBD | 需求变更 |

## 引用块

### 简单引用
> 这是一个简单的引用块。
> 可以包含多行内容。

### 嵌套引用
> 这是第一级引用
> > 这是第二级引用
> > > 这是第三级引用

### 包含其他元素的引用
> ## 引用中的标题
>
> 这是引用中的段落，可以包含 **粗体** 和 *斜体* 文本。
>
> - 引用中的列表项 1
> - 引用中的列表项 2
>
> \`\`\`javascript
> // 引用中的代码块
> console.log("在引用中的代码");
> \`\`\`

### 著名引用
> "在软件开发中，最昂贵的bug是那些在生产环境中才被发现的bug。"
>
> — 某位智慧的开发者

## 分割线

这是第一段内容。

---

这是分割线后的内容。

***

另一种分割线样式。

___

第三种分割线样式。

## 任务列表

### 日常任务
- [x] 完成 Markdown 预览组件
- [x] 编写测试用例
- [ ] 添加代码高亮功能
- [ ] 优化移动端显示
  - [x] 修复滚动问题
  - [ ] 调整字体大小
- [ ] 部署到生产环境

### 项目计划
- [ ] 需求分析
  - [x] 用户调研
  - [x] 竞品分析
  - [ ] 需求文档
- [ ] 设计阶段
  - [ ] UI 设计
  - [ ] 交互设计
- [ ] 开发阶段
  - [ ] 前端开发
  - [ ] 后端开发
  - [ ] 测试

## 数学公式

### 行内公式
这是一个行内公式：$E = mc^2$，爱因斯坦的质能方程。

圆的面积公式：$A = \\pi r^2$

### 块级公式
$$
\\begin{align}
\\nabla \\times \\vec{\\mathbf{B}} -\\, \\frac1c\\, \\frac{\\partial\\vec{\\mathbf{E}}}{\\partial t} &= \\frac{4\\pi}{c}\\vec{\\mathbf{j}} \\\\
\\nabla \\cdot \\vec{\\mathbf{E}} &= 4 \\pi \\rho \\\\
\\nabla \\times \\vec{\\mathbf{E}}\\, +\\, \\frac1c\\, \\frac{\\partial\\vec{\\mathbf{B}}}{\\partial t} &= \\vec{\\mathbf{0}} \\\\
\\nabla \\cdot \\vec{\\mathbf{B}} &= 0
\\end{align}
$$

### 矩阵
$$
\\begin{pmatrix}
a & b \\\\
c & d
\\end{pmatrix}
\\begin{pmatrix}
x \\\\
y
\\end{pmatrix}
=
\\begin{pmatrix}
ax + by \\\\
cx + dy
\\end{pmatrix}
$$

### 求和公式
$$
\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}
$$

### 积分公式
$$
\\int_0^\\infty e^{-x^2} dx = \\frac{\\sqrt{\\pi}}{2}
$$

## HTML标签

### 基本HTML
这是<mark>高亮文本</mark>。

这是<kbd>Ctrl</kbd> + <kbd>C</kbd>键盘快捷键。

这是<sub>下标</sub>和<sup>上标</sup>。

### 详情折叠
<details>
<summary>点击展开详细信息</summary>

这里是折叠的内容，只有点击"详细信息"才会显示。

可以包含任何markdown内容：

- 列表项
- **粗体文本**
- \`代码\`

</details>

### 表格增强
<table>
  <thead>
    <tr>
      <th>名称</th>
      <th>描述</th>
      <th>状态</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td><strong>React</strong></td>
      <td>用户界面库</td>
      <td><span style="color: green;">✓ 活跃</span></td>
    </tr>
    <tr>
      <td><strong>Vue</strong></td>
      <td>渐进式框架</td>
      <td><span style="color: green;">✓ 活跃</span></td>
    </tr>
    <tr>
      <td><strong>Angular</strong></td>
      <td>完整的框架</td>
      <td><span style="color: orange;">⚠ 维护中</span></td>
    </tr>
  </tbody>
</table>

## 脚注

这是一个包含脚注的句子[^1]。

这是另一个脚注[^note]。

[^1]: 这是第一个脚注的内容。
[^note]: 这是一个命名脚注的内容，可以包含更复杂的信息。

## Emoji 支持

这里有一些 emoji：

- 😀 😃 😄 😁 😆 😅 😂 🤣
- 🚀 🎯 💡 ⚡ 🔥 ✨ 🎉 🎊
- ✅ ❌ ⚠️ 📝 📊 📈 📉 💻
- 🌟 ⭐ 🌙 ☀️ 🌈 🌸 🍕 🎂

## 特殊字符和转义

### 需要转义的字符
\\* 星号需要转义
\\# 井号需要转义
\\[链接\\] 方括号需要转义

### 特殊字符
版权符号：©
注册商标：®
商标符号：™
度数符号：°
货币符号：$ € ¥ £
数学符号：± × ÷ ≠ ≤ ≥
箭头符号：← → ↑ ↓ ↔

---

## 总结

这个文档包含了几乎所有常用的 Markdown 语法和功能：

1. ✅ 各级标题 (H1-H6)
2. ✅ 文本格式化（粗体、斜体、删除线等）
3. ✅ 列表（有序、无序、嵌套）
4. ✅ 链接和图片
5. ✅ 代码块（多种编程语言）
6. ✅ 表格（基本、对齐、复杂）
7. ✅ 引用块（简单、嵌套、复杂）
8. ✅ 分割线
9. ✅ 任务列表
10. ✅ 数学公式（LaTeX）
11. ✅ HTML 标签
12. ✅ 脚注
13. ✅ Emoji
14. ✅ 特殊字符

这个测试文档可以用来验证 Markdown 预览组件的所有功能是否正常工作。

**最后更新时间：** $(new Date().toLocaleString())
`
