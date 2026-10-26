#!/usr/bin/env node
/**
 * 知识库文件收集脚本
 *
 * 功能：
 * 1. 解析知识库地址下的md文档头信息，找到与发布单元编码匹配的文件，向上递归找到AGENTS.md
 * 2. 用AGENTS.md的目录作为知识库实际地址，遍历该目录下的md文件，筛选type为Product Knowledge和Service Knowledge的文件
 * 3. 返回指定格式的对象，包含systemPrompt和fileLists
 * 4. 支持查询知识库中所有唯一的 deploy_unit
 *
 * 用法：
 *   # 收集知识文件（原有功能）
 *   node collect-knowledge.js --deployUnit LF39.18_wg_flow --knowledgePath /path/to/knowledge [--workspace /path/to/workspace]
 *
 *   # 查询所有 deploy_unit（新增功能）
 *   node collect-knowledge.js --listDeployUnits --knowledgePath /path/to/knowledge
 *
 * 参数：
 *   --deployUnit       发布单元编码（收集知识文件时必填）
 *   --knowledgePath    知识地址（必填）
 *   --workspace        工作空间地址（可选，用于接口调用失败时的降级方案）
 *   --listDeployUnits  查询所有 deploy_unit（新增功能，提供 --knowledgePath 即可）
 *
 * 输出：
 *   JSON对象，格式为：
 *   {
 *     "systemPrompt": "拼接的系统提示词",
 *     "fileLists": ["文件路径1", "文件路径2", ...]
 *   }
 *
 *   systemPrompt拼接规则：
 *   <knowledge>
 *   path: {知识文件的完整绝对路径}
 *   type: {type字段值}
 *   title: {title字段值}
 *   description: {description字段值}
 *   tags: {tags数组}
 *   </knowledge>
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const matter = require('gray-matter');

// ==================== 参数解析 ====================

/**
 * 解析命令行参数
 * @param {string[]} argv 命令行参数数组
 * @returns {Object} 解析后的参数对象
 */
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const value = argv[i + 1];
      if (value && !value.startsWith('--')) {
        args[key] = value;
        i++;
      } else {
        args[key] = true;
      }
    }
  }
  return args;
}

// ==================== 文件遍历工具 ====================

/**
 * 递归遍历目录，收集所有.md文件
 * @param {string} dir 目录路径
 * @param {string[]} results 结果数组（用于递归累积）
 * @returns {string[]} md文件路径数组
 */
function collectMarkdownFiles(dir, results = []) {
  if (!fs.existsSync(dir)) {
    return results;
  }
  const entries = fs.readdirSync(dir, {withFileTypes: true});
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // 跳过隐藏目录和node_modules等
      if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === '.git') {
        continue;
      }
      collectMarkdownFiles(fullPath, results);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      results.push(fullPath);
    }
  }
  return results;
}

// ==================== Markdown头信息解析 ====================

/**
 * 解析Markdown文件的YAML front matter头信息
 * 使用gray-matter库解析，比正则表达式更准确
 * @param {string} filePath md文件路径
 * @returns {Object|null} 解析后的头信息对象，解析失败返回null
 */
function parseMarkdownHeader(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const parsed = matter(content);
    // 只返回front matter部分，不包含正文
    return parsed.data || null;
  } catch (error) {
    // console.error(`[WARN] 解析文件头信息失败: ${filePath} - ${error.message}`);
    return null;
  }
}

// ==================== 文件名提取中文名称 ====================

/**
 * 从文件名提取中文名称
 * 规则：去掉local_前缀和.md后缀，提取中文部分
 * 例如：local_business-rules.md → 核心业务规则
 * @param {string} fileName 文件名
 * @returns {string} 提取的中文名称
 */
function extractChineseName(fileName) {
  // 去掉.md后缀
  let name = fileName.replace(/\.md$/i, '');
  // 去掉local_前缀
  name = name.replace(/^local_/i, '');
  // 去掉local-前缀
  name = name.replace(/^local-/i, '');
  // 提取中文部分（如果有中文则返回中文，否则返回处理后的文件名）
  const chineseMatch = name.match(/[\u4e00-\u9fa5]+/);
  if (chineseMatch) {
    return chineseMatch[0];
  }
  // 如果没有中文，用连字符/下划线替换为空格
  return name.replace(/[-_]/g, ' ');
}

// ==================== HTTP 请求工具 ====================

/**
 * 发送 HTTP GET 请求
 * @param {string} url 请求 URL
 * @returns {Promise<Object>} 返回解析后的 JSON 对象
 */
function httpGet(url) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || 80,
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'GET',
      timeout: 30000 // 30秒超时
    };

    const req = http.request(options, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve(json);
        } catch (error) {
          reject(new Error(`解析响应失败: ${error.message}`));
        }
      });
    });

    req.on('error', (error) => {
      reject(new Error(`请求失败: ${error.message}`));
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('请求超时'));
    });

    req.end();
  });
}

/**
 * 调用接口获取应用类型信息
 * @param {string} deployUnit 发布单元编码
 * @returns {Promise<Object>} 返回应用类型信息 { appType, buildEngineName }
 */
async function getAppTypeInfo(deployUnit) {
  const apiUrl = `http://archguardservice.paas.cmbchina.cn/cowork/get-analysis-info-v2?deployUnit=${encodeURIComponent(deployUnit)}`;
  // console.error(`[INFO] 调用接口获取应用类型信息: ${apiUrl}`);

  try {
    const response = await httpGet(apiUrl);
    // console.error(`[INFO] 接口响应: ${JSON.stringify(response)}`);

    if (response.returnCode === 'SUC0000' && response.body) {
      const buildEngineName = response.body.buildEngineName || '';
      // 判断前后端应用：如果 buildEngineName 包含 node（不区分大小写），则为前端应用
      const isFrontend = /node/i.test(buildEngineName);
      const appType = isFrontend ? 'frontend' : 'backend';

      // console.error(`[INFO] 应用类型: ${appType} (buildEngineName: ${buildEngineName})`);

      return {
        success: true,
        appType,
        buildEngineName,
        body: response.body
      };
    } else {
      const errorMsg = response.errorMsg || '未知错误';
      // console.error(`[ERROR] 接口调用失败: ${errorMsg}`);
      return {
        success: false,
        errorMsg
      };
    }
  } catch (error) {
    // console.error(`[ERROR] 请求接口异常: ${error.message}`);
    return {
      success: false,
      errorMsg: error.message
    };
  }
}

// ==================== 核心逻辑 ====================

/**
 * 从文件头信息判断是否匹配发布单元编码
 * @param {Object} header 文件头信息对象
 * @param {string} deployUnitCode 发布单元编码
 * @returns {boolean} 是否匹配
 */
function isDeployUnitMatchByHeader(header, deployUnitCode) {
  // 检查头信息中的 deploy_unit 字段是否等于发布单元编码
  return header.deploy_unit === deployUnitCode;
}

/**
 * 向上递归查找AGENTS.md文件
 * @param {string} startDir 起始目录
 * @returns {string|null} AGENTS.md文件的完整路径，未找到返回null
 */
function findAgentsMdUpward(startDir) {
  let currentDir = startDir;
  while (currentDir && currentDir !== path.parse(currentDir).root) {
    const agentsPath = path.join(currentDir, 'AGENTS.md');
    if (fs.existsSync(agentsPath) && fs.statSync(agentsPath).isFile()) {
      return agentsPath;
    }
    currentDir = path.dirname(currentDir);
  }
  // 也检查根目录
  const rootAgentsPath = path.join(path.parse(startDir).root, 'AGENTS.md');
  if (fs.existsSync(rootAgentsPath)) {
    return rootAgentsPath;
  }
  return null;
}

/**
 * 主函数（异步）
 * @param {Object} options 配置参数
 * @param {string} options.deployUnit 发布单元编码
 * @param {string} options.knowledgePath 知识地址
 * @param {string} options.workspace 工作空间地址
 */
async function main(options) {
  const {deployUnit, knowledgePath, workspace} = options;

  if (!deployUnit || !knowledgePath) {
    console.error('错误: 缺少必要参数');
    console.error('用法: node collect-knowledge.js --deployUnit <发布单元编码> --knowledgePath <知识地址> [--workspace <工作空间地址>]');
    process.exit(1);
  }

  // 规范化路径
  const knowledgeDir = path.resolve(knowledgePath);

  // 如果提供了workspace参数，则规范化workspace路径
  let workspaceDir = null;
  if (workspace) {
    workspaceDir = path.resolve(workspace);
  }

  if (!fs.existsSync(knowledgeDir)) {
    // console.error(`错误: 知识地址不存在: ${knowledgeDir}`);
    process.exit(1);
  }

  // console.error(`[INFO] 发布单元编码: ${deployUnit}`);
  // console.error(`[INFO] 知识地址: ${knowledgeDir}`);
  // console.error(`[INFO] 工作空间地址: ${workspaceDir}`);

  // ===== 步骤0: 调用接口获取应用类型信息 =====
  // console.error('[INFO] 步骤0: 调用接口获取应用类型信息...');
  const appTypeInfo = await getAppTypeInfo(deployUnit);

  let agentsMdPath = null;
  let allowedTypes = [];
  let useWorkspaceAgentsMd = false;

  if (!appTypeInfo.success) {
    // ===== 接口调用失败，降级到workspace下的AGENTS.md文件 =====
    // console.error(`[WARN] 获取应用类型信息失败: ${appTypeInfo.errorMsg}`);
    // console.error('[WARN] 接口调用失败，降级到workspace下的AGENTS.md文件...');
    // 只有当workspace参数已提供时，才尝试使用workspace下的AGENTS.md文件
    if (workspaceDir) {
      const workspaceAgentsPath = path.join(workspaceDir, 'AGENTS.md');
      if (fs.existsSync(workspaceAgentsPath) && fs.statSync(workspaceAgentsPath).isFile()) {
        agentsMdPath = workspaceAgentsPath;
        useWorkspaceAgentsMd = true;
        // console.error(`[INFO] 找到workspace下的AGENTS.md: ${agentsMdPath}`);
      } else {
        // 接口调用失败，且workspace下也没有AGENTS.md，直接返回空数组
        // console.error(`[WARN] workspace目录下未找到AGENTS.md文件，返回空数组`);
        console.log(JSON.stringify([], null, 2));
        return;
      }
    } else {
      // 未提供workspace参数，直接返回空数组
      // console.error(`[WARN] 未提供workspace参数，返回空数组`);
      console.log(JSON.stringify([], null, 2));
      return;
    }
  } else {
    // ===== 接口调用成功，根据应用类型确定需要筛选的文件类型 =====
    // 前端应用：Product Knowledge, Service Knowledge, Component Reference
    // 后端应用：Product Knowledge, Service Knowledge, Reference
    allowedTypes = appTypeInfo.appType === 'frontend'
      ? ['Product Knowledge', 'Service Knowledge', 'Component Reference']
      : ['Product Knowledge', 'Service Knowledge', 'Reference'];

    // console.error(`[INFO] 允许的文件类型: ${allowedTypes.join(', ')}`);

    // ===== 步骤1: 在知识地址下找到与发布单元编码匹配的文件 =====
    // console.error('[INFO] 步骤1: 在知识地址下查找与发布单元编码匹配的文件...');

    const knowledgeFiles = collectMarkdownFiles(knowledgeDir);
    // console.error(`[INFO] 知识地址下共找到 ${knowledgeFiles.length} 个md文件`);

    let matchedFile = null;

    for (const filePath of knowledgeFiles) {
      const header = parseMarkdownHeader(filePath);
      if (header && isDeployUnitMatchByHeader(header, deployUnit)) {
        matchedFile = filePath;
        // console.error(`[INFO] 找到匹配文件: ${filePath} (deploy_unit=${header.deploy_unit})`);
        break;
      }
    }

    if (matchedFile) {
      // ===== 步骤2: 找到匹配文件，从匹配文件所在目录向上递归查找AGENTS.md =====
      // console.error('[INFO] 步骤2: 找到匹配文件，从匹配文件所在目录向上递归查找AGENTS.md...');
      const matchedFileDir = path.dirname(matchedFile);
      // console.error(`[INFO] 匹配文件所在目录: ${matchedFileDir}`);
      agentsMdPath = findAgentsMdUpward(matchedFileDir);
    } else {
      // ===== 步骤2: 找不到匹配文件，直接使用workspace目录下的AGENTS.md文件 =====
      // console.error('[INFO] 步骤2: 未找到匹配文件，使用workspace目录下的AGENTS.md文件...');
      // 只有当workspace参数已提供时，才尝试使用workspace下的AGENTS.md文件
      if (workspaceDir) {
        const workspaceAgentsPath = path.join(workspaceDir, 'AGENTS.md');
        if (fs.existsSync(workspaceAgentsPath) && fs.statSync(workspaceAgentsPath).isFile()) {
          agentsMdPath = workspaceAgentsPath;
          useWorkspaceAgentsMd = true;
          // console.error(`[INFO] 找到workspace下的AGENTS.md: ${agentsMdPath}`);
        } else {
          // 未找到匹配文件，且workspace下也没有AGENTS.md，直接返回空数组
          // console.error(`[WARN] workspace目录下未找到AGENTS.md文件，返回空数组`);
          console.log(JSON.stringify([], null, 2));
          return;
        }
      } else {
        // 未提供workspace参数，直接返回空数组
        // console.error(`[WARN] 未提供workspace参数，返回空数组`);
        console.log(JSON.stringify([], null, 2));
        return;
      }
    }
  }

  if (!agentsMdPath) {
    // console.error(`[ERROR] 未找到AGENTS.md文件，返回空数组`);
    console.log(JSON.stringify([], null, 2));
    return;
  }

  // ===== 步骤3: 确定知识库实际地址 =====
  const actualKnowledgeDir = agentsMdPath ? path.dirname(agentsMdPath) : knowledgeDir;
  // console.error(`[INFO] 知识库实际地址: ${actualKnowledgeDir}`);

  // ===== 步骤4: 遍历知识库实际地址下的所有md文件，筛选type =====
  // console.error('[INFO] 步骤3: 遍历知识库实际地址下的md文件...');

  const allMdFiles = collectMarkdownFiles(actualKnowledgeDir);
  // console.error(`[INFO] 知识库实际地址下共找到 ${allMdFiles.length} 个md文件`);

  const currentDate = new Date().toISOString().slice(0, 10); // yyyy-MM-dd

  const results = [];

  for (const filePath of allMdFiles) {
    const fileName = path.basename(filePath);
    const isAgentsMd = fileName.toUpperCase() === 'AGENTS.MD';

    // ===== 特殊情况：当使用workspace下的AGENTS.md时，不解析头信息，不判断type =====
    if (useWorkspaceAgentsMd && isAgentsMd) {
      // 读取文件内容作为description
      let content;
      try {
        content = fs.readFileSync(filePath, 'utf-8');
      } catch (error) {
        // console.error(`[WARN] 读取文件内容失败: ${filePath} - ${error.message}`);
        continue;
      }

      // title为文件名（去掉.md后缀）
      const title = fileName.replace(/\.md$/i, '');

      // console.error(`[INFO] 保留AGENTS.md文件: ${filePath} (type=特殊处理)`);

      results.push({
        title,
        description: content,
        resource: '',
        tags: [],
        timestamp: currentDate,
        type: '',
        sub_product: '',
        deploy_unit: '',
        filePath
      });
      continue;
    }

    const header = parseMarkdownHeader(filePath);
    if (!header) {
      // console.error(`[WARN] 文件缺少头信息，跳过: ${filePath}`);
      continue;
    }

    // 直接从头信息读取type，如果没有type字段则跳过该文件
    const type = header.type;
    if (!type) {
      // console.error(`[WARN] 文件缺少type字段，跳过: ${filePath}`);
      continue;
    }
    const deploy_unit = header.deploy_unit;

    // 筛选条件：根据应用类型判断
    // Product Knowledge：不需要判断 deployUnit
    // Service Knowledge、Component Reference、Reference：需要判断 deploy_unit 是否与入参 deployUnit 一致
    let typeMatch = allowedTypes.includes(type);
    if (typeMatch && type !== 'Product Knowledge' && deployUnit !== deploy_unit) {
      typeMatch = false;
    }

    if (!typeMatch) {
      // console.error(`[WARN] 文件type不符合筛选条件，跳过: ${filePath} (type=${type}, deploy_unit=${deploy_unit})`);
      continue;
    }

    const title = header.title || extractChineseName(fileName);

    // 构建description：如果头信息中有description则使用，否则留空
    let description = header.description || '';

    const resource = header.resource || '';
    const tags = Array.isArray(header.tags) ? header.tags :
      (typeof header.tags === 'string' ? header.tags.split(',').map(t => t.trim()).filter(Boolean) : []);

    // 处理timestamp：gray-matter会将yyyy-MM-dd解析为Date对象，需要转回字符串
    let timestamp = header.timestamp || currentDate;
    if (timestamp instanceof Date) {
      timestamp = timestamp.toISOString().slice(0, 10);
    }

    const subProductValue = header.sub_product || '';
    const deployUnitValue = header.deploy_unit;

    // console.error(`[INFO] 保留文件: ${filePath} (type=${type}, deploy_unit=${deploy_unit})`);

    results.push({
      title,
      description,
      resource,
      tags,
      timestamp,
      type,
      sub_product: subProductValue,
      deploy_unit: deployUnitValue,
      filePath
    });
  }

  // ===== 输出结果 =====
  // console.error(`[INFO]===== 输出结果 ===== 共收集到 ${results.length} 个知识文件`);

  // 构建 fileLists（去重）
  const fileLists = [...new Set(results.map(item => item.filePath))];

  // 构建 systemPrompt
  let systemPrompt = '';
  for (const item of results) {
    systemPrompt += '<knowledge>\n';
    systemPrompt += `path: ${item.filePath}\n`;
    systemPrompt += `type: ${item.type || ''}\n`;
    systemPrompt += `title: ${item.title || ''}\n`;
    systemPrompt += `description: ${item.description || ''}\n`;
    systemPrompt += `tags: ${JSON.stringify(item.tags || [])}\n`;
    systemPrompt += '</knowledge>\n\n';
  }

  console.log(JSON.stringify({
    systemPrompt,
    fileLists
  }, null, 2));
}

// ==================== 查询所有 deploy_unit ====================

/**
 * 查询知识库中所有唯一的 deploy_unit
 * @param {string} knowledgePath 知识地址
 * @returns {string[]} 去重后的 deploy_unit 数组
 */
function listAllDeployUnits(knowledgePath) {
  const knowledgeDir = path.resolve(knowledgePath);

  if (!fs.existsSync(knowledgeDir)) {
    console.error(`错误: 知识地址不存在: ${knowledgeDir}`);
    process.exit(1);
  }

  const knowledgeFiles = collectMarkdownFiles(knowledgeDir);
  const deployUnitsSet = new Set();

  for (const filePath of knowledgeFiles) {
    const header = parseMarkdownHeader(filePath);
    if (header && header.deploy_unit) {
      deployUnitsSet.add(header.deploy_unit);
    }
  }

  return [...deployUnitsSet];
}

// ==================== 程序入口 ====================

const args = parseArgs(process.argv.slice(2));

// ===== 新增功能：查询所有 deploy_unit =====
if (args.listDeployUnits) {
  if (!args.knowledgePath) {
    console.error('错误: 使用 --listDeployUnits 时需要提供 --knowledgePath 参数');
    console.error('用法: node collect-knowledge.js --listDeployUnits --knowledgePath <知识地址>');
    process.exit(1);
  }

  const deployUnits = listAllDeployUnits(args.knowledgePath);
  console.log(JSON.stringify(deployUnits, null, 2));
  return;
}

main({
  deployUnit: args.deployUnit,
  knowledgePath: args.knowledgePath,
  workspace: args.workspace
});